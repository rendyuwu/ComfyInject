// Tag-level string handling shared by the two validators.
//
// Both passes reduce a booru tag to the same fingerprint before comparing it to
// another one: the appearance registry to deduplicate, the banned list to match.
// One helper rather than two, because the moment they disagree about whether
// `hand_holding` and `hand holding` are the same tag, one of them is wrong.
//
// No SillyTavern access and no settings read, on purpose — this is the layer the
// node smoke tests exercise without a mocked context.

/**
 * The comparison form of one tag: lowercase, underscores folded to spaces, runs
 * of whitespace collapsed.
 *
 * The underscore fold is not optional. Booru tags are written both
 * `hand_holding` and `hand holding` constantly, often in the same prompt, and a
 * user who bans one means both.
 *
 * @param {any} tag
 * @returns {string}
 */
export function tagFingerprint(tag) {
    return String(tag ?? "")
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/**
 * Parses a comma-separated tag list.
 *
 * Returns the tags as the user wrote them — that is what gets recited back in
 * OUTPUT RULES — alongside the fingerprints, which is what gets matched.
 *
 * @param {any} value - Comma-separated string, or an array of tags
 * @returns {{tags: string[], fingerprints: Set<string>}}
 */
export function parseTagList(value) {
    const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
    const tags = [];
    const fingerprints = new Set();

    for (const entry of raw) {
        const tag = String(entry ?? "").replace(/\s+/g, " ").trim();
        if (!tag) continue;
        const fingerprint = tagFingerprint(tag);
        if (!fingerprint || fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint);
        tags.push(tag);
    }

    return { tags, fingerprints };
}

/**
 * Removes whole banned tags from a comma-separated prompt.
 *
 * Whole tags, never substrings: a substring ban on `spine` would also take
 * `spine_tattoo` with it, which is silent tag loss and the reason wildcards are
 * out of scope. The accepted cost is the other direction — a model that writes
 * "two girls" as prose evades a ban on `2girls`, which is what the stated rule in
 * OUTPUT RULES is for.
 *
 * A prompt with nothing to remove comes back byte-identical, so an empty ban list
 * cannot quietly reformat anyone's tags.
 *
 * @param {string} prompt
 * @param {Set<string>} banned - Fingerprints, from parseTagList
 * @returns {{prompt: string, removed: string[]}}
 */
export function stripBannedTags(prompt, banned) {
    const text = String(prompt ?? "");
    if (!banned || !banned.size || !text.trim()) return { prompt: text, removed: [] };

    const kept = [];
    const removed = [];

    for (const raw of text.split(",")) {
        const tag = raw.trim();
        if (!tag) continue;
        if (banned.has(tagFingerprint(tag))) removed.push(tag);
        else kept.push(tag);
    }

    if (!removed.length) return { prompt: text, removed };
    return { prompt: kept.join(", "), removed };
}
