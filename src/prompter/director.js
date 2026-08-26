// Orchestration for the dedicated prompter path.
//
// One character message in, zero or more images out:
//
//   CHARACTER_MESSAGE_RENDERED
//     ├─ guards: trigger mode, auto enabled, bot message with text, not already
//     │          illustrated, nothing else in flight
//     ├─ prompter/context.build()   → the system prompt
//     ├─ prompter/llm.send()        → raw reply
//     ├─ prompter/schema.validate() → { generate, reason, images[] }
//     ├─ generate === false         → record the decision and stop
//     └─ per image: resolveSeed → generateImage (serialized by src/queue.js)
//                   → append the <img> → metadata → save
//
// The <img> tag shape is identical to the marker path's, so retry, the gallery,
// the outbound rewrite and the cleanup registry all keep working untouched.
//
// Concurrency rules, deliberately stricter than the reference extensions:
// one prompter request at a time, event re-entry is dropped rather than
// cancelling the request in flight, and CHAT_CHANGED aborts and resets.

import { MODULE_NAME } from "../../settings.js";
import { generateImage } from "../comfy.js";
import { resolveSeed, saveLastSeed } from "../state.js";
import {
    appendImageToMessage,
    countComfyImages,
    findIndexBySendDate,
    persistMessageImages,
    renderMessageWithSuffix,
} from "../dom.js";
import { buildFailedTag, countFailedTags } from "../failtag.js";
import { isTimeoutError as isFetchTimeout } from "../http.js";
import { buildImgTag } from "../imgtag.js";
import { notifyFailure, notifyWarning } from "../notify.js";
import { ensureRegistrySeeded, growRegistry, listRegistryLoraCalls, resetAppearanceState } from "./appearance.js";
import { buildPrompterContext } from "./context.js";
import { frameDirectionsFor, recordFrameDirections } from "./framing.js";
import { getErrorChain, isTimeoutError, runPrompter } from "./llm.js";
import { parseDirective, validateDirective } from "./schema.js";
import { debugEnabled, debugLog, warnLog } from "./log.js";

// The per-message manual trigger, injected into ST's own message button row.
const DIRECT_BUTTON_CLASS = "comfyinject-direct";
const DIRECT_ICON_CLASS = "fa-wand-magic-sparkles";

// One request at a time. Event re-entry is dropped; the manual button reports
// that it is busy rather than killing work in progress.
let inFlight = false;
/** @type {AbortController | null} */
let controller = null;

// The previous request's stable block, so the debug log can say whether the
// cached prefix survived. Tracked here rather than in the builder because the
// preview tools build contexts too, and counting those would report invalidations
// that never reached a backend.
/** @type {string | null} */
let lastStableBlock = null;

/**
 * Records this request's stable block and reports whether it is byte-identical to
 * the previous one. The first request in a chat is neither — it is the write.
 * @param {string} text
 * @returns {boolean | "first"}
 */
function trackStableBlock(text) {
    const unchanged = lastStableBlock === null ? "first" : lastStableBlock === text;
    lastStableBlock = text;
    return unchanged;
}

/** @returns {any} */
function ctx() {
    return SillyTavern.getContext();
}

/** @returns {Record<string, any>} */
function getSettings() {
    return ctx().extensionSettings[MODULE_NAME];
}

/**
 * True when the dedicated path is switched on at all.
 * @returns {boolean}
 */
function dedicatedEnabled() {
    const mode = getSettings()?.trigger_mode;
    return mode === "dedicated" || mode === "both";
}

/**
 * Failure feedback follows the shared toast convention in src/notify.js: an
 * automatic run stays silent when the user asked for silence, but an explicitly
 * requested run always answers.
 * @param {string} text
 * @param {boolean} manual
 */
function reportFailure(text, manual) {
    notifyFailure(text, { force: manual });
}

/**
 * Runs the prompter for one message and generates whatever it asks for.
 * @param {number} messageIndex
 * @param {object} options
 * @param {boolean} options.manual - True when a user clicked the per-message button
 */
async function runDirector(messageIndex, { manual }) {
    const settings = getSettings();
    const message = ctx().chat?.[messageIndex];
    if (!message) return;

    const sendDate = message.send_date;

    inFlight = true;
    controller = new AbortController();
    const signal = controller.signal;

    try {
        // One extra call on the first dedicated run in a chat, and never again.
        // It is deliberately inside the in-flight window and before the context
        // is built, so the very first image already has the registry to work from.
        await ensureRegistrySeeded({ signal });
        if (signal.aborted) return;

        let built;
        try {
            built = await buildPrompterContext({ messageIndex });
        } catch (err) {
            debugLog("context build refused", err);
            if (manual) notifyWarning(err?.message || String(err), { force: true });
            return;
        }

        debugLog("prompt assembled", {
            messageIndex,
            sections: built.sections.map(section => ({ title: section.title, chars: section.body.length })),
            chars: built.chars,
            // The two block sizes and whether the stable half is byte-identical to
            // the last request's in this chat. Without these the cache-aware
            // layout is unfalsifiable, and a regression that quietly re-breaks the
            // prefix would be invisible.
            stableChars: built.systemPrompt.length,
            volatileChars: built.volatilePrompt.length,
            stableBlockUnchanged: trackStableBlock(built.systemPrompt),
        });
        // The assembled prompt in full, not just its shape. Every misbehaving
        // prompter gets diagnosed here first, and a truncated prompt hides
        // exactly the section that went wrong.
        debugLog("stable block (system message)\n", built.systemPrompt);
        debugLog("volatile block (user message)\n", built.volatilePrompt);

        let result;
        try {
            result = await runPrompter({
                messages: built.messages,
                signal,
                // Only reached when the backend refuses schema-constrained output
                // and the schema JSON was being left out of the prompt because of
                // it. The retried request carries the full rules.
                rebuild: async (structuredMode) =>
                    (await buildPrompterContext({ messageIndex, structuredMode })).messages,
            });
        } catch (err) {
            // An abort is a skip, not an error — no toast, no partial image.
            if (signal.aborted) {
                debugLog("prompter aborted", messageIndex);
                return;
            }
            warnLog("prompter request failed", getErrorChain(err));
            reportFailure(
                isTimeoutError(err) ? "The prompter request timed out." : "The prompter request failed.",
                manual
            );
            return;
        }

        if (signal.aborted) return;

        let parsed;
        try {
            parsed = parseDirective(result.payload);
        } catch (err) {
            warnLog("prompter reply could not be parsed", err?.message || err);
            reportFailure(err?.message || "The prompter's reply could not be parsed.", manual);
            return;
        }

        const validated = validateDirective(parsed, {
            maxImages: settings.prompter_max_images_per_message,
            maxTags: settings.prompter_max_tags,
            bannedTags: settings.prompter_banned_tags,
            policy: settings.prompter_generate_policy,
            // Empty unless the registry-LoRA setting is on. When it is, a call the
            // user pinned to a character is put back if the reply dropped it.
            registryLoras: listRegistryLoraCalls(),
        });
        debugLog("validated directive", {
            transport: result.transport,
            structured: result.structured,
            generate: validated.generate,
            reason: validated.reason,
            images: validated.images,
            notes: validated.notes,
        });
        // Notes mean the reply broke the contract somewhere — a defaulted ar or
        // shot, a dropped or clamped image. Worth seeing without debug mode on.
        if (validated.notes.length) warnLog("directive was corrected:", validated.notes.join("; "));

        if (!validated.generate) {
            debugLog("decision: skip", { messageIndex, reason: validated.reason });
            if (debugEnabled()) {
                toastr.info(
                    `Prompter skipped this message${validated.reason ? `: ${validated.reason}` : ""}`,
                    "ComfyInject"
                );
            }
            return;
        }

        debugLog("decision: generate", { messageIndex, images: validated.images.length, reason: validated.reason });

        // Grow the registry from the prompter's own belief about who it drew,
        // before generation rather than after: a ComfyUI failure should not cost
        // us a newly discovered character.
        growRegistry(validated.images);

        // Re-derived rather than carried out of the builder. The roll is a pure
        // function of the target's send_date, the pools and the stored previous
        // roll, and nothing between the context build and here writes any of the
        // three — so this is the same roll the request was sent with.
        const frameDirections = frameDirectionsFor(settings, message, settings.prompter_max_images_per_message);

        const produced = await generateAndAppend({
            sendDate,
            fallbackIndex: messageIndex,
            images: validated.images,
            reason: validated.reason,
            signal,
            manual,
        });

        // Only a run that put a frame on screen advances the rotation. Recording a
        // roll that ComfyUI refused, or one whose chat has since been switched
        // away from, would make the next turn avoid values nothing was drawn from.
        if (produced && !signal.aborted) recordFrameDirections(frameDirections);
    } finally {
        inFlight = false;
        controller = null;
    }
}

/**
 * Generates each approved image and appends it to the message.
 *
 * Submissions go through generateImage(), which serializes them behind the
 * marker path and the retry button. The chat can shift while ComfyUI works, so
 * the message is re-found by send_date after every await.
 *
 * @param {object} params
 * @param {string} params.sendDate
 * @param {number} params.fallbackIndex
 * @param {Array<{prompt: string, ar: string, shot: string, characters: string[]}>} params.images
 * @param {string} params.reason
 * @param {AbortSignal} params.signal
 * @param {boolean} params.manual
 * @returns {Promise<number>} How many images actually landed in the message
 */
async function generateAndAppend({ sendDate, fallbackIndex, images, reason, signal, manual }) {
    let appended = 0;

    for (let i = 0; i < images.length; i++) {
        if (signal.aborted) return appended;

        let index = findIndexBySendDate(sendDate);
        if (index === -1) index = fallbackIndex;
        let message = ctx().chat?.[index];
        if (!message || message.send_date !== sendDate) {
            debugLog("target message is gone, stopping");
            return appended;
        }

        const image = images[i];
        const position = images.length > 1 ? ` ${i + 1}/${images.length}` : "";
        renderMessageWithSuffix(
            index,
            message,
            `<span class="comfyinject-pending">[Generating image${position}...]</span>`
        );

        // The prompter never picks seeds — that is the extension's business, and
        // letting it choose would silently defeat the seed lock.
        const seed = resolveSeed("RANDOM", index);

        let result;
        try {
            result = await generateImage({
                prompt: image.prompt,
                ar: image.ar,
                shot: image.shot,
                seed,
                messageIndex: index,
            });
        } catch (err) {
            console.error("[ComfyInject] Dedicated-path image generation failed:", err);
            const currentIndex = findIndexBySendDate(sendDate);
            if (currentIndex !== -1) {
                // Keep the directive rather than the disappointment. A prompter
                // reply costs an LLM call and would come back different next
                // time, so the placeholder holds this one — prompt, framing and
                // seed — and a Retry button spends nothing but an HTTP request
                // once ComfyUI is reachable again.
                const currentMessage = ctx().chat[currentIndex];
                appendImageToMessage(currentMessage, buildFailedTag({
                    prompt: image.prompt,
                    ar: image.ar,
                    shot: image.shot,
                    seed,
                    error: err,
                }));
                await persistMessageImages(currentIndex, currentMessage, [], { appendMetadata: true });
            }
            reportFailure(
                isFetchTimeout(err)
                    ? "ComfyUI did not answer in time. Press Retry on the message when it is back."
                    : "Image generation failed. Press Retry on the message to try again.",
                manual
            );
            return appended;
        }

        if (signal.aborted) {
            debugLog("aborted after generation, discarding the image");
            return appended;
        }

        // Re-resolve after the await: messages may have been deleted or moved.
        index = findIndexBySendDate(sendDate);
        if (index === -1) {
            debugLog("target message vanished while generating, discarding the image");
            return appended;
        }
        message = ctx().chat[index];

        saveLastSeed(result.seed);

        appendImageToMessage(message, buildImgTag(result.imageUrl, result.prompt, result.seed));
        await persistMessageImages(index, message, [{
            ar: image.ar,
            shot: image.shot,
            promptId: result.promptId,
            filename: result.filename,
            effectiveAr: result.effectiveAr,
            effectiveShot: result.effectiveShot,
            resolution: result.resolution,
            shotTags: result.shotTags,
            repairMeta: null,
            source: "dedicated",
            reason,
            characters: image.characters,
        }], { appendMetadata: true });

        appended++;
        console.log(`[ComfyInject] Prompter image appended to message ${index}`);
    }

    return appended;
}

/**
 * CHARACTER_MESSAGE_RENDERED handler.
 *
 * In both mode the marker path has already run by the time this fires — ST's
 * event emitter awaits listeners in registration order — so an image already in
 * the message means the roleplay model emitted a marker and this run stands down.
 * @param {number} index
 * @param {string} [type] - ST's own reason for the render, second argument of the
 * event. "first_message" is the greeting.
 */
async function onCharacterMessage(index, type) {
    if (!dedicatedEnabled()) return;
    if (!getSettings()?.prompter_auto) return;

    // The greeting is not a turn. It is card text the roleplay model never wrote,
    // it is the same for every chat started on that card, and SillyTavern re-emits
    // it on every open of a chat that still holds nothing else (script.js:7643's
    // `chat.length === 1` branch, and again on a greeting swipe at script.js:9859).
    // Illustrating it spends a prompter call and an image before the story has a
    // first beat to illustrate. The per-message button still works on it, which is
    // the whole difference between "never" and "not on its own".
    if (type === "first_message") {
        debugLog("skipping: the greeting is not a turn", index);
        return;
    }

    const message = ctx().chat?.[index];
    if (!message || message.is_user || message.is_system) return;
    if (!String(message.mes ?? "").trim()) return;

    // A failure placeholder counts as an image here. It already holds a directive
    // this prompter wrote, and its Retry button is a cheaper and more faithful way
    // to get the picture than a second LLM call that would invent a new prompt.
    if (countComfyImages(message.mes) > 0 || countFailedTags(message.mes) > 0) {
        debugLog("skipping: the message already has an image or a failed one", index);
        return;
    }

    if (inFlight) {
        debugLog("skipping: a prompter request is already in flight", index);
        return;
    }

    await runDirector(index, { manual: false });
}

/**
 * Reading context must never outlive its chat: abort whatever is in flight and
 * drop the state, then re-mount the manual buttons for the new chat.
 */
function onChatChanged() {
    if (controller) {
        controller.abort(new DOMException("Chat changed", "AbortError"));
        controller = null;
    }
    inFlight = false;
    lastStableBlock = null;
    resetAppearanceState();
    scheduleDirectButtons();
}

/**
 * Swaps the manual button between its icon and a spinner.
 * @param {HTMLElement} button
 * @param {boolean} busy
 */
function setButtonBusy(button, busy) {
    button.classList.toggle(DIRECT_ICON_CLASS, !busy);
    button.classList.toggle("fa-spinner", busy);
    button.classList.toggle("fa-spin", busy);
    button.style.pointerEvents = busy ? "none" : "";
}

/**
 * Adds the manual trigger to every bot message's button row, and removes them
 * all again when the dedicated path is switched off.
 *
 * Like the retry buttons, these are pure DOM injection and never persisted —
 * ST's sanitizer strips anything custom out of a message's saved text.
 */
export function addDirectButtons() {
    const enabled = dedicatedEnabled();

    if (!enabled) {
        document.querySelectorAll(`.${DIRECT_BUTTON_CLASS}`).forEach(button => button.remove());
        return;
    }

    for (const node of document.querySelectorAll("#chat .mes")) {
        if (node.getAttribute("is_user") === "true") continue;
        if (node.getAttribute("is_system") === "true") continue;

        const row = node.querySelector(".extraMesButtons");
        if (!row || row.querySelector(`.${DIRECT_BUTTON_CLASS}`)) continue;

        const button = document.createElement("div");
        button.className = `mes_button ${DIRECT_BUTTON_CLASS} fa-solid ${DIRECT_ICON_CLASS}`;
        button.title = "ComfyInject: ask the prompter to illustrate this message";
        row.prepend(button);
    }
}

/**
 * ST re-renders the message DOM after swipes and edits, so the buttons are
 * re-added on the same 100 ms delay the retry buttons use.
 */
function scheduleDirectButtons() {
    setTimeout(addDirectButtons, 100);
}

/**
 * Delegated click handler, bound once. The buttons themselves come and go with
 * every re-render.
 * @param {MouseEvent} event
 */
async function onDirectClick(event) {
    const target = /** @type {HTMLElement | null} */ (event.target);
    const button = target?.closest?.(`.${DIRECT_BUTTON_CLASS}`);
    if (!(button instanceof HTMLElement)) return;

    event.preventDefault();
    event.stopPropagation();

    if (inFlight) {
        toastr.info("The prompter is already working on a message.", "ComfyInject");
        return;
    }

    const index = Number(button.closest(".mes")?.getAttribute("mesid"));
    if (!Number.isInteger(index) || index < 0) return;

    setButtonBusy(button, true);
    try {
        await runDirector(index, { manual: true });
    } finally {
        setButtonBusy(button, false);
    }
}

/**
 * Registers the dedicated path's listeners.
 * Must be called after initDom(): ST's event emitter awaits listeners in
 * registration order, which is what gives the marker path first refusal on a new
 * message in both mode.
 */
export function initDirector() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessage);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    for (const type of [event_types.MESSAGE_SWIPED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_EDITED]) {
        eventSource.on(type, scheduleDirectButtons);
    }
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, scheduleDirectButtons);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, scheduleDirectButtons);

    document.addEventListener("click", onDirectClick, true);

    scheduleDirectButtons();

    console.log("[ComfyInject] Prompter director initialized");
}
