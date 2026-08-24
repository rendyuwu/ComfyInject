// The one reader and writer of a failed-generation placeholder.
//
// A generation that fails used to be written into the message as
// `<span class="comfyinject-error">[Image generation failed]</span>` — text, and
// nothing else. The marker it replaced was already gone by then, so the prompt
// that produced the failure was destroyed along with it. A ComfyUI that happened
// to be switched off therefore cost the image permanently, on both generation
// paths.
//
// The placeholder this module builds carries everything a second attempt needs —
// prompt, aspect ratio, shot and the seed that was resolved — in data attributes
// on the span, exactly the way `<img>` carries `data-prompt` and `data-seed`
// (src/imgtag.js). Switch ComfyUI on, press Retry, and the placeholder turns into
// the image it was always meant to be.
//
// Pure string handling on purpose — no SillyTavern access, no settings read — so
// it behaves the same on `message.mes` and on rendered DOM.

// SillyTavern's sanitizer prefixes custom classes with "custom-" in the rendered
// DOM while `mes` keeps the bare class, so both are accepted. Data attributes
// pass through the sanitizer untouched (only `class` is rewritten — see
// public/scripts/chats.js's uponSanitizeAttribute hook).
const FAILED_TAG_REGEX = /<span class="(?:custom-)?comfyinject-failed"[^>]*>.*?<\/span>/gs;

const PROMPT_REGEX = /data-prompt="([^"]*)"/;
const AR_REGEX = /data-ar="([^"]*)"/;
const SHOT_REGEX = /data-shot="([^"]*)"/;
const SEED_REGEX = /data-seed="([^"]*)"/;
const ERROR_REGEX = /data-error="([^"]*)"/;

// What the user reads in the message body. The failure's own text goes in a
// tooltip instead: a ComfyUI stack trace in the middle of a scene is noise.
export const FAILED_LABEL = "[Image generation failed]";

// A backend error message can be a whole HTML page. Only enough of it to tell a
// refused connection from a bad checkpoint name is kept.
const MAX_ERROR_CHARS = 200;

const ESCAPES = { "&": "&amp;", "\"": "&quot;", "<": "&lt;", ">": "&gt;" };

/**
 * @param {any} value
 * @returns {string}
 */
function escapeAttr(value) {
    return String(value ?? "").replace(/[&"<>]/g, char => ESCAPES[char]);
}

/**
 * The inverse of escapeAttr. `&amp;` is undone last, or an escaped `&quot;`
 * written by a user would come back as a quote character.
 * @param {any} value
 * @returns {string}
 */
function unescapeAttr(value) {
    return String(value ?? "")
        .replace(/&quot;/g, "\"")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

/**
 * @typedef {{ tag: string, prompt: string, ar: string, shot: string, seed: number | null, error: string, offset: number }} FailedTag
 */

/**
 * Builds the placeholder that stands in for an image that could not be generated.
 *
 * @param {object} params
 * @param {string} params.prompt - The prompt the failed attempt used
 * @param {string} params.ar - Aspect ratio token
 * @param {string} params.shot - Shot token
 * @param {number} [params.seed] - The seed that was resolved, when one was
 * @param {any} [params.error] - Why it failed; shown as a tooltip, not as body text
 * @returns {string}
 */
export function buildFailedTag({ prompt, ar, shot, seed, error = "" }) {
    // `class` stays first: the tag regex anchors on it.
    const attributes = [
        "class=\"comfyinject-failed\"",
        `data-prompt="${escapeAttr(prompt)}"`,
        `data-ar="${escapeAttr(ar)}"`,
        `data-shot="${escapeAttr(shot)}"`,
    ];

    const numericSeed = Number(seed);
    if (Number.isFinite(numericSeed)) attributes.push(`data-seed="${numericSeed}"`);

    const reason = escapeAttr(String(error?.message ?? error ?? "").slice(0, MAX_ERROR_CHARS));
    if (reason) attributes.push(`data-error="${reason}"`);

    return `<span ${attributes.join(" ")}>${FAILED_LABEL}</span>`;
}

/**
 * @param {string} tag
 * @param {number} offset
 * @returns {FailedTag}
 */
function parseOne(tag, offset) {
    const seed = parseInt(tag.match(SEED_REGEX)?.[1] ?? "", 10);

    return {
        tag,
        offset,
        prompt: unescapeAttr(tag.match(PROMPT_REGEX)?.[1] ?? ""),
        ar: unescapeAttr(tag.match(AR_REGEX)?.[1] ?? ""),
        shot: unescapeAttr(tag.match(SHOT_REGEX)?.[1] ?? ""),
        // null rather than NaN, so a caller can tell "no seed recorded" from
        // "seed 0" — the same distinction imgtag.js draws.
        seed: Number.isFinite(seed) ? seed : null,
        error: unescapeAttr(tag.match(ERROR_REGEX)?.[1] ?? ""),
    };
}

/**
 * Every failed-generation placeholder in a message's text, in the order it
 * appears. `offset` is the placeholder's position in the string, which is what
 * lets a caller work out where a retried image lands among the real ones.
 *
 * @param {any} mes - A message's mes field
 * @returns {FailedTag[]}
 */
export function parseFailedTags(mes) {
    const text = String(mes ?? "");
    if (!text) return [];

    return [...text.matchAll(FAILED_TAG_REGEX)].map(match => parseOne(match[0], match.index ?? 0));
}

/**
 * How many failed placeholders a message's text holds.
 * @param {any} mes
 * @returns {number}
 */
export function countFailedTags(mes) {
    return parseFailedTags(mes).length;
}

/**
 * Rewrites every failed placeholder in a message's text.
 *
 * The replacer sees the same parsed shape parseFailedTags returns plus the
 * placeholder's position, and returns the text to put in its place. Returning
 * `parsed.tag` leaves it alone, which is how "replace the Nth one and nothing
 * else" is written without a second regex.
 *
 * @param {any} mes
 * @param {(parsed: FailedTag, index: number) => string} replacer
 * @returns {string}
 */
export function replaceFailedTags(mes, replacer) {
    const text = String(mes ?? "");
    if (!text) return text;

    let index = 0;
    return text.replace(FAILED_TAG_REGEX, (tag, offset) => replacer(parseOne(tag, offset), index++));
}

/**
 * Removes every failed placeholder. Used on anything a language model reads: a
 * placeholder is an extension-internal artifact, and an image that does not exist
 * is worse than no image at all to a model trying to keep a scene consistent.
 * @param {any} mes
 * @returns {string}
 */
export function stripFailedTags(mes) {
    return replaceFailedTags(mes, () => "");
}
