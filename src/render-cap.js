// Caps how many ComfyInject images a long chat keeps in the DOM, and shows a
// small placeholder everywhere else that can flip the message back to full
// rendering on tap.
//
// A phone on a long roleplay accumulates one decoded <img> per generation, and
// lazy loading alone does not shrink the DOM tree — the elements and their
// layout cost stay. The strip has to keep two promises at once, which is why it
// is a two-phase design rather than a sanitizer hook:
//
// - mes is never touched. The prompt/seed on the tag are the source of truth
//   for retry, the gallery, and prompter continuity, and the cap is a display
//   preference the user flips on and off — writing to mes would make a render
//   setting destructive.
//
// - The cap counts tags in mes, not rendered nodes. Deciding from the DOM
//   ("remove img beyond N") breaks down the moment a message is hidden: with
//   the cap on, some messages show no img at all, and counting from the DOM
//   then assigns a stripped message's indices to later images — the numbering
//   the strip itself introduced — and the walk can un-hide an image it had
//   already hidden. Counting from mes over the full chat ignores what is
//   rendered, so both walks stay stable, and it is also O(chat) once per event
//   rather than per rendered message.
//
// Reveal keeps the same discipline: the placeholder only sets a flag on
// message.extra and re-renders. extra survives saves (the chat endpoint
// serialises it), but ST snapshots it into swipe_info on a swipe, so a reveal
// applies to the swipe that was on screen — not to every swipe of the message.
// Nothing here feeds extra into a prompt: ST's prompt builder reads mes, not
// extra, and the extension never writes this key anywhere else.
//
// Swipe note: applyToChat counts every tag in mes, and a swipe replaces mes —
// the boundary can move under an already-rendered chat, leaving stale DOM until
// the next event. The capped messages are by definition older than the last N
// images, so the cost of being a render off is low; MESSAGE_SWIPED re-applies
// so the cap settles on the new boundary immediately rather than on the next
// message.

import { MODULE_NAME } from "../settings.js";
import { parseImageTags } from "./imgtag.js";
import { addImageRetryButtons, rerenderMessage } from "./dom.js";

// Matches dom.js's rendered selector: ST's sanitizer rewrites the class to
// "custom-comfyinject-image" in the DOM while mes keeps the bare class.
const RENDERED_IMG_SELECTOR = ".custom-comfyinject-image";

// The class the click delegation listens for.
const SHOW_ALL_CLASS = "comfyinject-show-all-images";

// message.extra key holding the reveal flag. extra survives saves but is
// snapshotted per swipe, and nothing else in the extension writes this key.
const EXTRA_SHOW_ALL = "comfyinject_show_all_images";

// The strip leaves this behind; the placeholder's click handler is what knows
// how to undo it, so the two stay in one file.
const PLACEHOLDER_CLASS = "comfyinject-image-hidden";

let lastKeep = 0;

function settings() {
    return SillyTavern.getContext().extensionSettings[MODULE_NAME];
}

/**
 * How many ComfyInject images, counted from the newest in the chat, stay
 * rendered. 0 disables the cap.
 * @returns {number}
 */
function keepCount() {
    const keep = parseInt(settings()?.render_recent_images, 10);
    return Number.isFinite(keep) && keep > 0 ? keep : 0;
}

/**
 * Every message index holding a ComfyInject image, from the newest image
 * backwards, so the walk can stop once it has credited the keep allowance.
 * Returns chat indices in scan order: newest image first.
 * @returns {number[]}
 */
function imageIndicesNewestFirst() {
    const chat = SillyTavern.getContext().chat ?? [];
    const order = [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (parseImageTags(chat[i]?.mes ?? "").length > 0) order.push(i);
    }
    return order;
}

/**
 * The set of message indices whose images the cap keeps rendered: the messages
 * covering the newest `keep` tags in mes order, plus every message the user
 * revealed by hand. When the cap is off the set is empty, which the strip
 * reads as "nothing to hide".
 * @param {number} keep
 * @returns {Set<number>}
 */
function allowedIndices(keep) {
    const allowed = new Set();
    if (keep === 0) return allowed;

    const chat = SillyTavern.getContext().chat ?? [];
    let remaining = keep;
    for (const index of imageIndicesNewestFirst()) {
        if (remaining <= 0) break;
        allowed.add(index);
        remaining -= parseImageTags(chat[index].mes).length;
    }

    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.extra?.[EXTRA_SHOW_ALL]) allowed.add(i);
    }
    return allowed;
}

/**
 * Hides every rendered ComfyInject image in a message behind a placeholder
 * carrying the message index, so the click handler can find the message back
 * after a swipe or a deletion has shifted the array. Retry buttons ride the
 * wrapper the image sits in, so stripping the image removes them with it.
 * @param {number} index
 */
function stripMessage(index) {
    const node = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (!node) return;

    for (const img of node.querySelectorAll(RENDERED_IMG_SELECTOR)) {
        const placeholder = document.createElement("span");
        placeholder.className = PLACEHOLDER_CLASS;
        placeholder.dataset.mesid = String(index);
        placeholder.style.cssText = "display: inline-block; opacity: 0.75; border: 1px dashed var(--SmartThemeBorderColor); border-radius: 4px; padding: 1px 6px; font-size: 12px; cursor: pointer;";
        placeholder.innerHTML =
            `<i class="fa-solid fa-image"></i> image hidden — ` +
            `<span class="${SHOW_ALL_CLASS}">tap to show</span>`;
        img.replaceWith(placeholder);
    }
}

/**
 * Brings a stripped message back to its rendered form. rerenderMessage re-runs
 * mes through the sanitizer — the strip only ever rewrote DOM, so the images
 * come back from mes untouched — and swallows the reasoning-handler throw the
 * way every other re-render in the extension does.
 *
 * addRetryButtons would re-add every placeholder button too, but a stripped
 * message was already carrying them and this file never touches those — only
 * the image retry, which the strip removed with its wrapper, needs re-adding.
 * @param {number} index
 */
function rerender(index) {
    const chat = SillyTavern.getContext().chat ?? [];
    const message = chat[index];
    if (!message) return;

    rerenderMessage(index, message);

    const node = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (node) addImageRetryButtons(node, message.send_date);
}

/**
 * One pass over the chat: strip every message the cap does not allow, re-render
 * every message that is allowed but currently stripped, and re-render messages
 * whose reveal flag was cleared. The strip and the unstrip share the pass so a
 * boundary move (setting change, swipe, deletion) is one walk, not two.
 */
function applyToChat() {
    const keep = keepCount();
    if (keep === lastKeep) return;

    const chat = SillyTavern.getContext().chat ?? [];
    const allowed = allowedIndices(keep);

    for (let i = 0; i < chat.length; i++) {
        if (parseImageTags(chat[i]?.mes ?? "").length === 0) continue;

        const isStripped = !!document.querySelector(
            `#chat .mes[mesid="${i}"] .${PLACEHOLDER_CLASS}`
        );

        if (allowed.has(i)) {
            // An allowed message is only re-rendered when the DOM says it is
            // stripped — re-rendering an already-shown message on every event
            // would reflow the chat on each new reply.
            if (isStripped) rerender(i);
        } else {
            // The reveal flag and the cap disagree: the flag lost, so the
            // message renders capped and the flag is spent. Clearing it here —
            // not at click time — is what keeps a raise of the cap from
            // resurrecting a message the user never re-asked for.
            if (chat[i].extra?.[EXTRA_SHOW_ALL]) {
                delete chat[i].extra[EXTRA_SHOW_ALL];
            }
            stripMessage(i);
        }
    }

    lastKeep = keep;
}

/**
 * Registers the click delegation and the event listeners that keep the cap
 * applied. Called once from index.js on load.
 */
export function initRenderCap() {
    const { eventSource, event_types } = SillyTavern.getContext();

    document.addEventListener("click", (event) => {
        const trigger = event.target.closest?.(`.${SHOW_ALL_CLASS}`);
        if (!trigger) return;

        const placeholder = trigger.closest(`.${PLACEHOLDER_CLASS}`);
        const index = parseInt(placeholder?.dataset.mesid, 10);
        const chat = SillyTavern.getContext().chat ?? [];
        if (!Number.isFinite(index) || !chat[index]) return;

        chat[index].extra = chat[index].extra ?? {};
        chat[index].extra[EXTRA_SHOW_ALL] = true;
        rerender(index);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        // A chat switch swaps every message at once; the remembered allowance
        // belongs to the previous chat and must not suppress this pass.
        lastKeep = -1;
        applyToChat();
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, applyToChat);
    eventSource.on(event_types.MESSAGE_SWIPED, applyToChat);
    eventSource.on(event_types.MESSAGE_DELETED, applyToChat);
}
