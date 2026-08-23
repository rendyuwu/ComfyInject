// The one reader of a saved ComfyInject <img> tag.
//
// `data-prompt` and `data-seed` on the tag itself are the source of truth for
// what an image was generated from — metadata is supplementary, and is keyed by
// send_date so it does not follow a swipe. Four copies of the same regex trio
// grew up around that fact (state.js, gallery.js, outbound.js, dom.js), and they
// had already begun to disagree: prompter/context.js accepts the sanitizer's
// "custom-" class prefix while the others match the bare class only.
//
// Pure string handling on purpose — no SillyTavern access, no settings read, no
// metadata — so the node smoke tests exercise it without a mocked context.

// The class match accepts the optional "custom-" prefix. SillyTavern's sanitizer
// adds it in the rendered DOM while `mes` keeps the bare class; a superset is
// harmless on `mes` and correct on rendered DOM.
const IMG_TAG_REGEX = /<img class="(?:custom-)?comfyinject-image"[^>]*>/g;

const SRC_REGEX = /src="([^"]*)"/;
const PROMPT_REGEX = /data-prompt="([^"]*)"/;
const SEED_REGEX = /data-seed="([^"]*)"/;

/**
 * @typedef {{ tag: string, url: string | null, prompt: string, seed: number | null }} ImageTag
 */

/**
 * Every ComfyInject image in a message's text, in the order it appears.
 *
 * Order is load-bearing: retryImage() and the gallery both map a metadata entry
 * to a tag positionally, so this must never reorder or skip.
 *
 * `prompt` is unescaped — buildImgTag() writes `"` as `&quot;` (dom.js) and this
 * reverses it. `seed` is a finite number or null; null rather than NaN so a
 * caller can tell "no seed recorded" from "seed 0".
 *
 * @param {any} mes - A message's mes field
 * @returns {ImageTag[]}
 */
export function parseImageTags(mes) {
    const text = String(mes ?? "");
    if (!text) return [];

    return [...text.matchAll(IMG_TAG_REGEX)].map((match) => {
        const tag = match[0];
        const seed = parseInt(tag.match(SEED_REGEX)?.[1], 10);

        return {
            tag,
            url: tag.match(SRC_REGEX)?.[1] || null,
            prompt: tag.match(PROMPT_REGEX)?.[1]?.replace(/&quot;/g, '"') || "",
            seed: Number.isFinite(seed) ? seed : null,
        };
    });
}

/**
 * How many ComfyInject images a message's text holds.
 * @param {any} mes
 * @returns {number}
 */
export function countImageTags(mes) {
    return parseImageTags(mes).length;
}
