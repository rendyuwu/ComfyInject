// The one reader and writer of a saved ComfyInject <img> tag.
//
// `data-prompt` and `data-seed` on the tag itself are the source of truth for
// what an image was generated from — metadata is supplementary, and is keyed by
// send_date so it does not follow a swipe. Four copies of the same regex trio
// grew up around that fact (state.js, gallery.js, outbound.js, dom.js), and they
// had already begun to disagree: prompter/context.js accepts the sanitizer's
// "custom-" class prefix while the others match the bare class only.
//
// buildImgTag lives here rather than in dom.js so the escape and its inverse sit
// in one file, the way failtag.js already keeps them. Splitting them is how the
// `>` bug below got in: the writer escaped `"` and nothing else, and the reader
// was written against that assumption instead of against HTML.
//
// Pure string handling on purpose — no SillyTavern access, no settings read, no
// metadata — so the node smoke tests exercise it without a mocked context.

// The class match accepts the optional "custom-" prefix. SillyTavern's sanitizer
// adds it in the rendered DOM while `mes` keeps the bare class; a superset is
// harmless on `mes` and correct on rendered DOM.
//
// `(?:[^>"]|"[^"]*")*` rather than `[^>]*`, because a `>` inside an attribute
// value must not end the tag. The plain version did, and a prompt carrying LoRA
// syntax — `<lora:style:1>`, which a user's own final instructions can legitimately
// ask the prompter to append — truncated the match mid-attribute. The truncated
// match has no closing quote on data-prompt, so `prompt` read back as "" and
// `seed` as null: continuity lost, retry and the gallery reading blanks, and the
// tag's tail left in the message as literal HTML for the roleplay model to copy.
// The two branches cannot both match the same first character, so the alternation
// has no ambiguity to backtrack over.
const IMG_TAG_REGEX = /<img class="(?:custom-)?comfyinject-image"(?:[^>"]|"[^"]*")*>/g;

const SRC_REGEX = /src="([^"]*)"/;
const PROMPT_REGEX = /data-prompt="([^"]*)"/;
const SEED_REGEX = /data-seed="([^"]*)"/;

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
 *
 * Tags written before escapeAttr existed hold a raw `<` or `>`, which this leaves
 * alone — so the quote-aware regex above is what recovers those, and this is what
 * keeps the ones written from now on readable.
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
 * Builds the <img> tag string that gets injected into the message.
 * Stores prompt and seed as data attributes for outbound.js and the gallery to
 * read. The shape is shared by the marker path and the dedicated prompter path,
 * which is what lets retry, the gallery, the outbound rewrite and cleanup stay
 * unaware of which one produced a given image.
 * @param {string} imageUrl - The full ComfyUI /view URL
 * @param {string} prompt - The raw prompt returned by generateImage()
 * @param {number} seed - The resolved seed used for generation
 * @returns {string} The HTML img tag string
 */
export function buildImgTag(imageUrl, prompt, seed) {
    return `<img class="comfyinject-image" src="${escapeAttr(imageUrl)}" data-prompt="${escapeAttr(prompt)}" data-seed="${seed}" />`;
}

/**
 * @typedef {{ tag: string, url: string | null, prompt: string, seed: number | null, offset: number }} ImageTag
 */

/**
 * The per-tag read, shared by the reader and the rewriter so the two can never
 * disagree about what a tag says.
 * @param {string} tag
 * @param {number} offset - Where the tag starts in the text it was found in
 * @returns {ImageTag}
 */
function parseOne(tag, offset) {
    const seed = parseInt(tag.match(SEED_REGEX)?.[1], 10);

    return {
        tag,
        offset,
        url: unescapeAttr(tag.match(SRC_REGEX)?.[1] ?? "") || null,
        prompt: unescapeAttr(tag.match(PROMPT_REGEX)?.[1] ?? ""),
        // null rather than NaN, so a caller can tell "no seed recorded" from
        // "seed 0".
        seed: Number.isFinite(seed) ? seed : null,
    };
}

/**
 * Every ComfyInject image in a message's text, in the order it appears.
 *
 * Order is load-bearing: retryImage() and the gallery both map a metadata entry
 * to a tag positionally, so this must never reorder or skip.
 *
 * `prompt` is unescaped — buildImgTag() escapes `&`, `"`, `<` and `>`, and this
 * reverses it. `seed` is a finite number or null; null rather than NaN so a
 * caller can tell "no seed recorded" from "seed 0". `offset` is where the tag
 * starts, which is how a retried failure placeholder works out how many images
 * precede it and therefore where its metadata entry belongs.
 *
 * @param {any} mes - A message's mes field
 * @returns {ImageTag[]}
 */
export function parseImageTags(mes) {
    const text = String(mes ?? "");
    if (!text) return [];

    return [...text.matchAll(IMG_TAG_REGEX)].map(match => parseOne(match[0], match.index ?? 0));
}

/**
 * How many ComfyInject images a message's text holds.
 * @param {any} mes
 * @returns {number}
 */
export function countImageTags(mes) {
    return parseImageTags(mes).length;
}

/**
 * Rewrites every ComfyInject image in a message's text.
 *
 * The replacer sees the same parsed shape parseImageTags returns, plus the tag's
 * position, and returns the text to put in its place. Returning the tag itself
 * leaves it alone, which is how a positional rewrite — replace the Nth image and
 * nothing else — is expressed without a second regex.
 *
 * The regex lives here and only here: the whole point of this module is that a
 * caller never writes `/<img class="comfyinject-image"[^>]*>/` again, whether it
 * is reading or writing.
 *
 * @param {any} mes
 * @param {(parsed: ImageTag, index: number) => string} replacer
 * @returns {string}
 */
export function replaceImageTags(mes, replacer) {
    const text = String(mes ?? "");
    if (!text) return text;

    let index = 0;
    return text.replace(IMG_TAG_REGEX, (tag, offset) => replacer(parseOne(tag, offset), index++));
}
