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
 * Rewrites one img tag into a neutral placeholder.
 * Used in "dedicated" mode, where the main model is not supposed to emit
 * markers at all. Echoing marker syntax there would teach it a format we do
 * not want back, so the image is described as a plain bracketed note instead.
 *
 * The seed is deliberately dropped: nothing on the dedicated path asks the main
 * model to reuse a seed, and it is only noise in the context.
 *
 * @param {string} prompt - The prompt read from data-prompt
 * @returns {string}
 */
function toNeutralTag(prompt) {
    return `[image: ${prompt}]`;
}

/**
 * Prompt interceptor — called by SillyTavern before every generation
 * (public/script.js:4505, the only call site of runGenerationInterceptors).
 * Replaces <img> tags in outgoing messages with a token-efficient stand-in so
 * the LLM can reference its previous visual descriptions.
 *
 * The stand-in depends on trigger_mode:
 *   marker / both -> [[IMG: prompt | seed ]]   (the main model emits these)
 *   dedicated     -> [image: prompt]           (the main model must not)
 *
 * Reads prompt and seed directly from the img tag's data attributes
 * rather than metadata, so it always matches the current message content.
 *
 * The dedicated prompter's own LLM call is unaffected by this function: it goes
 * through ConnectionManagerRequestService or generateRaw, neither of which runs
 * generation interceptors, and it strips img tags itself in
 * src/prompter/context.js.
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

        // Replace each img tag with a compact token read from its data attributes.
        // A message with no tags comes back byte-identical, so there is nothing to
        // pre-check — and no shared regex lastIndex to leak between iterations.
        message.mes = replaceImageTags(message.mes, ({ prompt, seed }) => {
            if (!prompt) return "[image]";

            return dedicatedOnly ? toNeutralTag(prompt) : toMarkerToken(prompt, seed ?? 0);
        });

        // A failed image is an extension-internal artifact. Sending its
        // placeholder would hand the main model a picture that does not exist,
        // plus the prompt text of one it is not supposed to be writing.
        message.mes = stripFailedTags(message.mes);
    }
};
