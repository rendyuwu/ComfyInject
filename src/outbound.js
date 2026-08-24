import { MODULE_NAME } from "../settings.js";
import { stripFailedTags } from "./failtag.js";
import { replaceImageTags } from "./imgtag.js";

/**
 * Returns the current trigger mode, defaulting to "marker" so that a missing
 * or unreadable settings object behaves exactly like a pre-feature install.
 * @returns {"marker" | "dedicated" | "both"}
 */
function getTriggerMode() {
    try {
        return SillyTavern.getContext().extensionSettings[MODULE_NAME]?.trigger_mode || "marker";
    } catch {
        return "marker";
    }
}

/**
 * Rewrites one img tag into the compact marker the main model is taught to emit.
 * Used in "marker" and "both" mode, where echoing the marker syntax back is
 * exactly what we want: it reinforces the format and carries the seed forward
 * for visual continuity.
 *
 * @param {string} prompt - The prompt read from data-prompt
 * @param {number} seed - The seed read from data-seed, or 0 when none was recorded
 * @returns {string}
 */
function toMarkerToken(prompt, seed) {
    return `[[IMG: ${prompt} | ${seed} ]]`;
}

/**
 * Collapses the blank lines a removed tag leaves behind.
 *
 * appendImageToMessage joins with "\n\n" (dom.js), so deleting the tag leaves a
 * trailing gap — and two images leave two. Left alone it is whitespace that
 * changes as images arrive, which is exactly the kind of churn a cached prefix
 * cannot absorb.
 *
 * @param {string} text
 * @returns {string}
 */
function tidyGaps(text) {
    return text.replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Prompt interceptor — called by SillyTavern before every generation
 * (public/script.js:4505, the only call site of runGenerationInterceptors).
 * Rewrites <img> tags out of outgoing messages.
 *
 * What replaces them depends on trigger_mode:
 *   marker / both -> [[IMG: prompt | seed ]]
 *   dedicated     -> nothing at all
 *
 * On the marker path the echo is the point: the main model is the one emitting
 * markers, so seeing its own back reinforces the format and carries the seed
 * forward for visual continuity.
 *
 * On the dedicated path there is nothing to reinforce, and a reason not to. The
 * echo used to be `[image: <the whole booru prompt>]`, which put thirty-odd
 * comma-separated tags into the model's own message history — the keyword-listing
 * style that dedicated mode exists to keep out of its prose. In-context learning
 * does the rest: give a model a format in its own voice and it writes more of it.
 * So the tag is deleted outright. Continuity is not lost by this, because it was
 * never coming from here — the prompter reads the saved chat directly for its
 * PREVIOUS IMAGES section (src/prompter/context.js).
 *
 * This mutates a copy. `coreChat` is rebuilt per message before the interceptor
 * runs (public/script.js:4479), so nothing here reaches the saved chat, the
 * rendered message, the gallery or the data attributes retry depends on.
 *
 * The dedicated prompter's own LLM call is unaffected by this function: it goes
 * through ConnectionManagerRequestService or generateRaw, neither of which runs
 * generation interceptors.
 *
 * @param {object[]} chat - The mutable chat array passed by ST's interceptor system
 * @param {number} contextSize - Current context size in tokens
 * @param {Function} abort - Call this to cancel generation entirely
 * @param {string} type - The generation trigger type (e.g. 'normal', 'swipe', 'quiet')
 */
globalThis.comfyInjectInterceptor = async function(chat, contextSize, abort, type) {
    // Skip quiet generations (summaries, silent background calls etc)
    // so we don't accidentally interfere with other extensions
    if (type === "quiet") return;

    const dedicatedOnly = getTriggerMode() === "dedicated";

    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];

        // Only process bot messages
        if (message.is_user) continue;
        if (!message.mes) continue;

        const before = message.mes;
        let deletedAnImage = false;

        // A message with no tags comes back byte-identical, so there is nothing to
        // pre-check — and no shared regex lastIndex to leak between iterations.
        message.mes = replaceImageTags(message.mes, ({ prompt, seed }) => {
            if (!dedicatedOnly) return prompt ? toMarkerToken(prompt, seed ?? 0) : "[image]";

            deletedAnImage = true;
            return "";
        });

        // A failed image is an extension-internal artifact. Sending its
        // placeholder would hand the main model a picture that does not exist,
        // plus the prompt text of one it is not supposed to be writing.
        message.mes = stripFailedTags(message.mes);

        // Only when something was actually removed: tidyGaps trims, and trimming a
        // message nothing was taken out of would be an edit of the user's own text.
        if (message.mes === before) continue;
        message.mes = tidyGaps(message.mes);

        // A message that held nothing but an image is now empty, and an empty
        // assistant turn is not a smaller message — it is a rejected request on
        // Claude, and one fewer turn in the role alternation everywhere else.
        // `[image]` is the smallest thing that keeps the turn a turn, and it carries
        // none of the tag style deleting the tag was for.
        //
        // Only when a real image was what emptied it. A message whose entire content
        // was a *failure* placeholder empties too, and there `[image]` would be the
        // exact lie stripFailedTags exists to prevent. That case predates this
        // deletion — stripFailedTags has always been able to empty a message — and
        // inventing content for it is not this function's call to make.
        if (!message.mes && deletedAnImage) message.mes = "[image]";
    }
};
