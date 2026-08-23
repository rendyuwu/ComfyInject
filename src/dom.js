import { MARKER_REGEX, processAllImageMarkers, hasImageMarker } from "./parse.js";
import { generateImage } from "./comfy.js";
import { saveLastSeed, getImageData } from "./state.js";
import { notifyFailure, notifyRepair, notifyWarning, repairToastsEnabled } from "./notify.js";
import { MODULE_NAME } from "../settings.js";

// Matches every already-injected ComfyInject image in a message's text.
const IMG_TAG_REGEX_GLOBAL = /<img class="comfyinject-image"[^>]*>/g;

/**
 * Builds the <img> tag string that gets injected into the message.
 * Stores prompt and seed as data attributes for outbound.js to read.
 * The shape is shared by the marker path and the dedicated prompter path, which
 * is what lets retry, the gallery, the outbound rewrite and cleanup stay unaware
 * of which one produced a given image.
 * @param {string} imageUrl - The full ComfyUI /view URL
 * @param {string} prompt - The raw prompt returned by generateImage()
 * @param {number} seed - The resolved seed used for generation
 * @returns {string} The HTML img tag string
 */
export function buildImgTag(imageUrl, prompt, seed) {
    return `<img class="comfyinject-image" src="${imageUrl}" data-prompt="${prompt.replace(/"/g, '&quot;')}" data-seed="${seed}" />`;
}

/**
 * Counts the ComfyInject images already present in a message's text.
 * @param {string} text - A message's mes field
 * @returns {number}
 */
export function countComfyImages(text) {
    return (String(text ?? "").match(IMG_TAG_REGEX_GLOBAL) || []).length;
}

/**
 * Finds the current array index of a message by its send_date.
 * Messages shift while an image is generating, so anything that awaits has to
 * re-resolve the index instead of holding onto the one it started with.
 * @param {string} sendDate - The send_date to look for
 * @returns {number} The current index, or -1 if not found
 */
export function findIndexBySendDate(sendDate) {
    const context = SillyTavern.getContext();
    for (let i = 0; i < context.chat.length; i++) {
        if (context.chat[i].send_date === sendDate) return i;
    }
    return -1;
}

/**
 * Returns the current trigger mode.
 * @returns {"marker" | "dedicated" | "both"}
 */
function getTriggerMode() {
    return SillyTavern.getContext().extensionSettings[MODULE_NAME]?.trigger_mode || "marker";
}

/**
 * True when [[IMG: ... ]] markers should still be parsed and generated from.
 * In dedicated mode they are left alone as plain text.
 * @returns {boolean}
 */
function markerPathEnabled() {
    const mode = getTriggerMode();
    return mode === "marker" || mode === "both";
}

/**
 * Returns true if a repairMeta object contains any meaningful repair info.
 * Non-canonical formatting alone does not count unless something was actually
 * defaulted, ignored, or flagged.
 * @param {object|null} repairMeta
 * @returns {boolean}
 */
function hasMeaningfulRepair(repairMeta) {
    if (!repairMeta || typeof repairMeta !== "object") return false;

    const defaulted = Array.isArray(repairMeta.defaulted) ? repairMeta.defaulted : [];
    const duplicateTokens = repairMeta.duplicateTokens || {};

    const duplicateAr = Array.isArray(duplicateTokens.AR) ? duplicateTokens.AR : [];
    const duplicateShot = Array.isArray(duplicateTokens.SHOT) ? duplicateTokens.SHOT : [];
    const duplicateSeed = Array.isArray(duplicateTokens.SEED) ? duplicateTokens.SEED : [];

    return (
        defaulted.length > 0 ||
        duplicateAr.length > 0 ||
        duplicateShot.length > 0 ||
        duplicateSeed.length > 0 ||
        repairMeta.possibleSeedInPrompt === true
    );
}

/**
 * Shows a grouped repair toast for one live-rendered message.
 * This is only used for successful repaired markers.
 * @param {number} repairedCount
 * @param {number} totalCount
 */
function maybeShowGroupedRepairToast(repairedCount, totalCount) {
    if (repairedCount <= 0) return;

    notifyRepair(
        `Repaired ${repairedCount}/${totalCount} markers in this message. See Image Gallery for details.`
    );
}

/**
 * Logs a grouped repair warning for one live-rendered message.
 * This mirrors the user-facing grouped repair toast.
 * @param {number} messageIndex
 * @param {number} repairedCount
 * @param {number} totalCount
 */
function maybeLogGroupedRepairWarning(messageIndex, repairedCount, totalCount) {
    if (!repairToastsEnabled()) return;
    if (repairedCount <= 0) return;

    console.warn("[ComfyInject] Repaired markers in message:", {
        messageIndex,
        repairedCount,
        totalCount,
    });
}

/**
 * Shows a parse-failure toast based on the user's marker repair toast setting.
 * @param {string} errorText
 */
function maybeShowParseFailureToast(errorText) {
    notifyWarning(errorText);
}

/**
 * Shows one bulk-scan repair summary toast after scanning old messages.
 * This avoids spamming one toast per message during chat load.
 * @param {number} repairedMessages
 * @param {number} repairedMarkers
 */
function maybeShowBulkRepairSummaryToast(repairedMessages, repairedMarkers) {
    if (repairedMarkers <= 0) return;

    notifyRepair(
        `Repaired ${repairedMarkers} markers across ${repairedMessages} existing messages. See Image Gallery for details.`
    );
}

/**
 * Logs one bulk-scan repair summary warning after scanning old messages.
 * @param {number} repairedMessages
 * @param {number} repairedMarkers
 */
function maybeLogBulkRepairSummaryWarning(repairedMessages, repairedMarkers) {
    if (!repairToastsEnabled()) return;
    if (repairedMarkers <= 0) return;

    console.warn("[ComfyInject] Repaired markers during bulk scan:", {
        repairedMessages,
        repairedMarkers,
    });
}

/**
 * Formats a marker position label within a message.
 * Only includes numbering when the message had multiple markers.
 * @param {number} markerNumber - 1-based marker number within the message
 * @param {number} totalMarkers - Total markers in the message
 * @returns {string}
 */
function formatMarkerPosition(markerNumber, totalMarkers) {
    return totalMarkers > 1 ? ` ${markerNumber}/${totalMarkers}` : "";
}

/**
 * Adds retry buttons to all rendered comfyinject images in a message.
 * This is done via DOM manipulation (not in message.mes) because
 * ST's HTML sanitizer strips custom divs when rendering messages.
 * Each button stores send_date and imgindex for the retry handler.
 * @param {number} index - The current message array index (for DOM lookup via mesid)
 */
function addRetryButtons(index) {
    const context = SillyTavern.getContext();
    const message = context.chat[index];
    if (!message) return;

    const messageNode = document.querySelector(`[mesid="${index}"]`);
    if (!messageNode) return;

    // ST's sanitizer prefixes custom classes with "custom-" in the rendered DOM
    const images = messageNode.querySelectorAll(".custom-comfyinject-image");
    if (images.length === 0) return;

    const sendDate = message.send_date;

    images.forEach((img, imgIndex) => {
        // Don't add a second retry button if one already exists
        if (img.parentElement?.querySelector(".comfyinject-retry")) return;

        // Wrap the image in a relative container so we can position the button
        const wrapper = document.createElement("div");
        wrapper.className = "comfyinject-wrapper";
        wrapper.style.cssText = "position: relative; display: inline-block;";
        img.parentElement.insertBefore(wrapper, img);
        wrapper.appendChild(img);

        // Create the retry button
        const btn = document.createElement("div");
        btn.className = "comfyinject-retry";
        btn.dataset.senddate = sendDate;
        btn.dataset.imgindex = imgIndex;
        btn.title = "Regenerate with new seed";
        btn.style.cssText = "position: absolute; top: 6px; right: 6px; cursor: pointer; background: rgba(0,0,0,0.6); color: white; border-radius: 4px; padding: 2px 8px; font-size: 12px; z-index: 10;";
        btn.innerHTML = `<i class="fa-solid fa-rotate"></i>`;

        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            e.preventDefault();
            await retryImage(sendDate, imgIndex);
        });

        wrapper.appendChild(btn);
    });
}

/**
 * Adds retry buttons to all rendered comfyinject images across the entire chat.
 * Called after scanning existing messages on chat load.
 */
function addAllRetryButtons() {
    const context = SillyTavern.getContext();
    for (let i = 0; i < context.chat.length; i++) {
        addRetryButtons(i);
    }
}

/**
 * Appends an <img> tag to the end of a message's text.
 * This is how the dedicated prompter path places images: it has no marker to
 * replace, and end-of-message is the only placement that is always correct.
 * @param {object} message - A SillyTavern chat message object
 * @param {string} imgTag - Output of buildImgTag()
 */
export function appendImageToMessage(message, imgTag) {
    const text = String(message.mes ?? "").trimEnd();
    message.mes = text ? `${text}\n\n${imgTag}` : imgTag;
}

/**
 * Re-renders a message and re-adds its retry buttons.
 * updateMessageBlock calls ST's reasoning handler, which can throw on some
 * messages, so every call to it in this extension is wrapped.
 * @param {number} index - The current message array index
 * @param {object} message - The message object to render
 */
export function rerenderMessage(index, message) {
    try {
        SillyTavern.getContext().updateMessageBlock(index, message);
    } catch (e) {
        // ST's reasoning handler may crash on some messages, that's okay
    }
    addRetryButtons(index);
}

/**
 * Renders a message with a temporary suffix — a pending placeholder — without
 * writing the suffix into the message itself.
 * @param {number} index - The current message array index
 * @param {object} message - The message object to render
 * @param {string} suffixHtml - HTML appended for this render only
 */
export function renderMessageWithSuffix(index, message, suffixHtml) {
    const original = message.mes;
    message.mes = `${String(original ?? "").trimEnd()}\n\n${suffixHtml}`;
    try {
        SillyTavern.getContext().updateMessageBlock(index, message);
    } catch (e) {
        // ST's reasoning handler may crash on some messages, that's okay
    }
    message.mes = original;
}

/**
 * The shared tail of both generation paths: re-render, re-add retry buttons,
 * write image metadata keyed by send_date, and persist chat and metadata.
 *
 * Metadata entry order must line up with <img> tag order in the message, because
 * that is how retryImage() maps a button back to its metadata. The marker path
 * replaces the message's entries wholesale; the dedicated path appends its own
 * after whatever is already there, which is what keeps both-mode ordering right.
 *
 * @param {number} index - The current message array index
 * @param {object} message - The message object, already carrying its new <img> tags
 * @param {object[]} entries - One metadata entry per newly generated image
 * @param {object} [options]
 * @param {boolean} [options.appendMetadata=false] - Append to existing entries instead of replacing them
 */
export async function persistMessageImages(index, message, entries, { appendMetadata = false } = {}) {
    const context = SillyTavern.getContext();

    rerenderMessage(index, message);

    if (!context.chatMetadata[MODULE_NAME]) {
        context.chatMetadata[MODULE_NAME] = {};
    }
    const store = context.chatMetadata[MODULE_NAME];

    if (appendMetadata) {
        // Legacy chats key metadata by array index instead of send_date. Seed
        // from the legacy entry so appended images do not renumber the old ones.
        const existing = getImageData(store, message.send_date);
        const base = existing.length > 0 ? existing : getImageData(store, index);
        store[message.send_date] = [...base, ...entries];
    } else {
        store[message.send_date] = entries;
    }

    await context.saveMetadata();
    await context.saveChat();
}

/**
 * Processes a single message by index.
 * If it contains [[IMG: ... ]] markers, generates the images sequentially,
 * injects <img> tags into both the DOM and the mes field,
 * saves metadata keyed by send_date, and calls saveChat().
 * @param {number} index - The message index in the chat array
 */
async function processMessage(index, options = {}) {
    const context = SillyTavern.getContext();
    const message = context.chat[index];
    const { updateMessageBlock } = SillyTavern.getContext();
    const { suppressRepairNotifications = false } = options;

    if (!message) return { repairedCount: 0, totalCount: 0 };

    // Only process bot messages
    if (message.is_user) return { repairedCount: 0, totalCount: 0 };

    // In dedicated mode markers are not a trigger at all — the prompter decides,
    // and any marker the roleplay model still emits stays plain text.
    if (!markerPathEnabled()) return { repairedCount: 0, totalCount: 0 };

    // Skip if no marker present
    if (!hasImageMarker(message.mes)) return { repairedCount: 0, totalCount: 0 };

    console.log(`[ComfyInject] Processing message ${index}`);

    // Count markers for the placeholder
    const markerCount = (message.mes.match(/\[\[IMG:\s*.+?\s*\]\]/gs) || []).length;

    // Show placeholders by patching mes temporarily
    const originalMes = message.mes;
    let placeholderIndex = 0;
    message.mes = message.mes.replace(/\[\[IMG:\s*.+?\s*\]\]/gs, () => {
        placeholderIndex++;
        return `<span class="comfyinject-pending">[Generating image ${placeholderIndex}/${markerCount}...]</span>`;
    });
    try {
        updateMessageBlock(index, message);
    } catch (e) {
        // ST's reasoning handler may crash on some messages, that's okay
    }
    message.mes = originalMes;

    // Process all markers sequentially
    const results = await processAllImageMarkers(message.mes, index);

    if (results.length === 0) return { repairedCount: 0, totalCount: 0 };

    // Replace each marker with either a generated image or a structured error state.
    // Only successful generations should be saved into metadata.
    const metadataArray = [];
    let repairedCount = 0;

    for (let markerIndex = 0; markerIndex < results.length; markerIndex++) {
        const result = results[markerIndex];
        const markerNumber = markerIndex + 1;
        const markerPosition = formatMarkerPosition(markerNumber, results.length);

        if (result?.status === "ok") {
            const {
                imageUrl,
                seed,
                prompt,
                ar,
                shot,
                promptId,
                filename,
                effectiveAr,
                effectiveShot,
                resolution,
                shotTags,
                repairMeta,
            } = result;

            if (hasMeaningfulRepair(repairMeta)) {
                repairedCount++;
            }

            const imgTag = buildImgTag(imageUrl, prompt, seed);
            message.mes = message.mes.replace(MARKER_REGEX, imgTag);
            metadataArray.push({
                ar,
                shot,
                promptId,
                filename,
                effectiveAr,
                effectiveShot,
                resolution,
                shotTags,
                repairMeta,
            });
        } else if (result?.status === "parse_error") {
            // The marker was found, but parsing could not recover a usable prompt.
            const reason = result?.reason;
            let errorText;
            switch (reason) {
                case "empty_prompt":
                    errorText = `[Image marker${markerPosition} invalid: empty prompt]`;
                    break;
                case "empty_marker":
                    errorText = `[Image marker${markerPosition} invalid: empty marker]`;
                    break;
                default:
                    errorText = `[Image marker${markerPosition} invalid]`;
                    break;
            }

            console.warn("[ComfyInject] Image marker parse failed:", {
                reason,
                rawMarker: result?.rawMarker || null,
                messageIndex: index,
                markerNumber,
                totalMarkers: results.length,
            });

            if (!suppressRepairNotifications) {
                maybeShowParseFailureToast(errorText);
            }

            message.mes = message.mes.replace(
                MARKER_REGEX,
                `<span class="comfyinject-error">${errorText}</span>`
            );
        } else if (result?.status === "generation_error") {
            // Marker parsed successfully, but image generation failed.
            const errorText = `[Image generation failed${markerPosition ? `: marker${markerPosition}` : ""}]`;

            console.error("[ComfyInject] Image generation failed:", {
                messageIndex: index,
                markerNumber,
                totalMarkers: results.length,
                reason: result?.error?.message ?? result?.error ?? null,
            });

            message.mes = message.mes.replace(
                MARKER_REGEX,
                `<span class="comfyinject-error">${errorText}</span>`
            );
        } else {
            // Fallback guard for any unexpected result shape.
            const errorText = `[Image generation failed${markerPosition ?`: marker${markerPosition}` : ""}]`;

            console.error("[ComfyInject] Unexpected marker result shape:", {
                result,
                messageIndex: index,
                markerNumber,
                totalMarkers: results.length,
            });

            message.mes = message.mes.replace(
                MARKER_REGEX,
                `<span class="comfyinject-error">${errorText}</span>`
            );
        }
    }

    // Re-render, re-add retry buttons, write metadata keyed by send_date, save.
    // Shared with the dedicated prompter path so the two cannot drift.
    await persistMessageImages(index, message, metadataArray);

    if (!suppressRepairNotifications) {
        maybeShowGroupedRepairToast(repairedCount, results.length);
        maybeLogGroupedRepairWarning(index, repairedCount, results.length);
    }

    const successCount = results.filter((result) => result?.status === "ok").length;
    console.log(`[ComfyInject] Message ${index} saved with ${successCount} injected image(s)`);

    return {
        repairedCount,
        totalCount: results.length,
    };
}

/**
 * Scans all existing messages in the current chat and processes
 * any that still have an unprocessed [[IMG: ... ]] marker.
 * Called on APP_READY and CHAT_CHANGED.
 */
async function scanExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;

    console.log(`[ComfyInject] Scanning ${context.chat.length} existing messages`);

    let repairedMessages = 0;
    let repairedMarkers = 0;

    for (let i = 0; i < context.chat.length; i++) {
        const message = context.chat[i];
        if (!message.is_user && hasImageMarker(message.mes)) {
            const summary = await processMessage(i, { suppressRepairNotifications: true });

            if (summary?.repairedCount > 0) {
                repairedMessages++;
                repairedMarkers += summary.repairedCount;
            }
        }
    }

    maybeShowBulkRepairSummaryToast(repairedMessages, repairedMarkers);
    maybeLogBulkRepairSummaryWarning(repairedMessages, repairedMarkers);

    // Add retry buttons to all already-rendered images (including ones from previous sessions)
    addAllRetryButtons();
}

/**
 * Retries image generation for a specific image within a message with a new random seed.
 * Uses send_date to look up metadata (stable across deletions).
 * @param {string} sendDate - The send_date of the message to retry
 * @param {number} imgIndex - Which image within the message to retry (0-based)
 */
async function retryImage(sendDate, imgIndex) {
    const context = SillyTavern.getContext();
    const { updateMessageBlock } = SillyTavern.getContext();
    const metadata = context.chatMetadata[MODULE_NAME];

    // Find the current array index for this message
    const messageIndex = findIndexBySendDate(sendDate);
    if (messageIndex === -1) return;

    const message = context.chat[messageIndex];
    if (!message || !metadata) return;

    // Parse prompt from the img tag in mes (source of truth, not stored in metadata)
    const imgTags = [...message.mes.matchAll(/<img class="comfyinject-image"[^>]*>/g)];
    const targetTag = imgTags[imgIndex];
    if (!targetTag) return;

    const prompt = targetTag[0].match(/data-prompt="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"') || "";
    if (!prompt) return;

    // Look up metadata for supplementary fields (ar, shot)
    const images = getImageData(metadata, sendDate).length > 0
        ? getImageData(metadata, sendDate)
        : getImageData(metadata, messageIndex);
    const imageData = images[imgIndex] || {};

    const { ar, shot } = imageData;

    // Fall back to the same marker-level defaults used by the parser
    // if metadata is missing or incomplete.
    const retryAr = ar || "SQUARE";
    const retryShot = shot || "MEDIUM";

    // Generate a new random seed using the shared project-wide max safe integer range.
    const newSeed = Math.floor(Math.random() * 9007199254740991);

    // Show generating state on the retry button
    const retryBtn = document.querySelector(`.comfyinject-retry[data-senddate="${sendDate}"][data-imgindex="${imgIndex}"]`);
    if (retryBtn) {
        retryBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
        retryBtn.style.pointerEvents = "none";
    }

    let result;
    try {
        result = await generateImage({
            prompt,
            ar: retryAr,
            shot: retryShot,
            seed: newSeed,
            messageIndex,
            bypassSeedLock: true,
        });
    } catch (err) {
        console.error(`[ComfyInject] Retry failed for message ${messageIndex} image ${imgIndex}:`, err);
        // The user pressed retry, so this always answers whatever the toast mode says.
        notifyFailure("Image retry failed.", { force: true });
        // Restore retry button
        if (retryBtn) {
            retryBtn.innerHTML = `<i class="fa-solid fa-rotate"></i>`;
            retryBtn.style.pointerEvents = "auto";
        }
        return;
    }

    const { imageUrl, seed: effectiveSeed, promptId, filename, effectiveAr, effectiveShot, resolution, shotTags } = result;

    // Save the seed that was actually used so LOCK works
    saveLastSeed(effectiveSeed);

    // Update metadata — try send_date key first, fall back to index for legacy.
    // Guard against missing or malformed entries so retry does not recreate bad metadata.
    const metaKey = metadata[sendDate] ? sendDate : messageIndex;
    const metaEntry = metadata[metaKey];

    if (Array.isArray(metaEntry)) {
        const existingEntry = metaEntry[imgIndex] && typeof metaEntry[imgIndex] === "object"
            ? metaEntry[imgIndex]
            : {};

        metaEntry[imgIndex] = {
            ...existingEntry,
            seed: effectiveSeed,
            ar: existingEntry.ar || retryAr,
            shot: existingEntry.shot || retryShot,
            promptId,
            filename,
            effectiveAr,
            effectiveShot,
            resolution,
            shotTags,
            repairMeta: existingEntry.repairMeta || null,
        };
    } else if (metaEntry && typeof metaEntry === "object") {
        metadata[metaKey] = {
            ...metaEntry,
            seed: effectiveSeed,
            ar: metaEntry.ar || retryAr,
            shot: metaEntry.shot || retryShot,
            promptId,
            filename,
            effectiveAr,
            effectiveShot,
            resolution,
            shotTags,
            repairMeta: metaEntry.repairMeta || null,
        };
    }

    // Replace the Nth img tag in mes (where N = imgIndex)
    const newImgTag = buildImgTag(imageUrl, prompt, effectiveSeed);
    let count = 0;
    message.mes = message.mes.replace(/<img class="comfyinject-image"[^>]*>/g, (match) => {
        if (count === imgIndex) {
            count++;
            return newImgTag;
        }
        count++;
        return match;
    });

    // Re-render
    try {
        updateMessageBlock(messageIndex, message);
    } catch (e) {
        // ST's reasoning handler may crash on some messages, that's okay
    }

    // Re-add retry buttons since updateMessageBlock wipes the DOM
    addRetryButtons(messageIndex);

    // Persist
    await context.saveMetadata();
    await context.saveChat();
}

/**
 * Registers all SillyTavern event listeners.
 * Called once from index.js on load.
 */
export function initDom() {
    const { eventSource, event_types } = SillyTavern.getContext();

    // Process new bot messages as they are rendered
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (index) => {
        await processMessage(index);
    });

    // Re-scan when chat changes
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        await scanExistingMessages();
    });

    // Re-add retry buttons after swipes and edits since ST re-renders the message DOM
    const reAddRetryButtons = (index) => setTimeout(() => addRetryButtons(index), 100);
    eventSource.on(event_types.MESSAGE_SWIPED, reAddRetryButtons);
    eventSource.on(event_types.MESSAGE_UPDATED, reAddRetryButtons);
    eventSource.on(event_types.MESSAGE_EDITED, reAddRetryButtons);

    console.log("[ComfyInject] DOM listener initialized");
}