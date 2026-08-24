// The per-chat appearance registry.
//
// A text-to-image model has no memory: unless every prompt spells out the same
// hair, eyes and outfit, the same character comes out different every time. The
// registry is where those tags are pinned down once and then reused.
//
//   chatMetadata.comfyinject_appearance = {
//     "<key>": { name, tags, source: "seed" | "grown" | "user", updatedAt }
//   }
//
// It lives in chat metadata rather than settings because the same character can
// legitimately look different in different chats — an outfit change, a timeskip,
// an alternate universe.
//
// Three ways an entry gets written:
//   seed  — one extra LLM call on the first dedicated run in a chat, reading the
//           character cards, every bound lorebook (triggering or not), and the
//           chat itself. Repeated every prompter_seed_refresh_messages messages,
//           because a pass that only ever fires on the greeting cannot know who
//           walks in on message forty — and a registry that never revisits the
//           chat is per-character in everything but where it is stored.
//   grown — a character the prompter drew who was not in the registry yet. This
//           is the brand-new NPC case: no card, no lorebook entry, nothing to
//           seed from, but by the second image they have a stable entry.
//   user  — hand-edited in the registry editor.
//
// A "user" entry is never overwritten by seeding or growth. That is the whole
// point of the registry being editable: a bad automatic guess is fixable by hand
// instead of by re-rolling the model.
//
// A "user" entry with no tags is a tombstone: the key exists, deliberately blank.
// buildAppearanceSection skips it because it has no tags, and both automatic
// sources refuse it because it is "user", so it is the one durable way to say
// "never write an entry for this name". Deleting an entry outright is not durable
// — the next seeding pass simply writes it again. This is what a card that is a
// world, a narrator or a game master rather than a person needs, since such a
// card is still in CAST and the seeding pass will keep attributing a body to it.
// Only a hand edit may store a blank entry; an automatic source that produces
// nothing usable is still dropped rather than written empty.

import {
    MODULE_NAME,
    DEFAULT_PROMPTER_SEED_SYSTEM_PROMPT,
    DEFAULT_PROMPTER_SEED_EXAMPLE_TAGS,
    DEFAULT_PROMPTER_SEED_USER_TURN,
} from "../../settings.js";
import { substituteTrimmed } from "../macros.js";
import { debugLog, warnLog } from "./log.js";
import { runPrompter, schemaBelongsInPrompt } from "./llm.js";
import { extractLoraCalls, parseDirective } from "./schema.js";
import { ensureCardsLoaded, listCastMembers, readBoundLore, renderSections, stripImages } from "./sources.js";
import { parseTagList, stripBannedTags, tagFingerprint } from "./tags.js";

export const APPEARANCE_METADATA_KEY = "comfyinject_appearance";
export const APPEARANCE_SEEDED_KEY = "comfyinject_appearance_seeded";

// How many visible messages the chat held when it was last seeded. The refresh
// interval is measured against this rather than against the timestamp: a chat is
// stale because the story moved on, not because time passed.
export const APPEARANCE_SEEDED_COUNT_KEY = "comfyinject_appearance_seeded_count";

// Structured output name for the seeding call.
const SEED_SCHEMA_NAME = "ComfyInjectAppearance";

// A registry entry is reference data, not a prompt. The cap keeps a runaway reply
// from turning every later request into a wall of tags.
//
// 800 rather than the 400 this shipped with. 400 was set before the seeding
// instructions grew a wardrobe ladder, and a body block plus eight to fourteen
// coloured garment tags plus footwear and accessories lands at roughly 600 — so
// the old number was cutting the exact configuration the feature encourages.
// Raising it is the honest fix; reporting the cut, which is what the previous
// commit did, only makes a wrong number visible.
//
// The clamp is the whole cost control. A registry entry is injected into every
// subsequent request, so this number multiplies by MAX_ENTRIES and by every
// message in the chat. At the "all" scope the section sits in the cacheable half,
// which is what makes the raise affordable at all; at "present" it does not.
export const DEFAULT_REGISTRY_MAX_CHARS = 800;
export const MIN_REGISTRY_MAX_CHARS = 100;
export const MAX_REGISTRY_MAX_CHARS = 2000;

const MAX_ENTRIES = 40;

// Growth is held to the entry cap and to nothing extra. It used to have a harder
// cap of its own, on the reasoning that a distilled image prompt is a first guess
// rather than a considered one — but truncating a guess does not make it a better
// guess, it makes it the same guess with the wardrobe tail missing, frozen into
// every request after it. Consistency is the only reason the registry exists, and
// cost is what the entry cap is already for. A grown entry is still marked
// "grown", which is how the editor says it is a first guess.

/**
 * How many characters one registry entry may hold, from the live setting.
 *
 * Clamped rather than trusted. The floor stops a typo emptying every entry the
 * next seeding pass writes; the ceiling is a stated limit on a number that is
 * paid for on every request, so a runaway one cannot be typed in by accident.
 *
 * @returns {number}
 */
export function registryMaxChars() {
    const raw = Math.floor(Number(getSettings()?.prompter_registry_max_chars) || 0);
    if (!raw) return DEFAULT_REGISTRY_MAX_CHARS;
    return Math.min(MAX_REGISTRY_MAX_CHARS, Math.max(MIN_REGISTRY_MAX_CHARS, raw));
}

// The one instruction the registry needs, kept in the section body so it is sent
// exactly when the data is. Not a setting: it is the contract that makes the
// registry worth having, and a registry the model is free to contradict is not a
// registry.
export const REGISTRY_DISCIPLINE =
    "Use these tags verbatim for the characters listed. Do not invent hair, eye or outfit details that contradict them.";

// Chats whose seeding pass failed this session. A transport error should not
// re-fire on every single message, but it should not be remembered across a
// reload either, so this is deliberately in memory only.
const seedFailures = new Set();

let seedingInFlight = false;

/** @returns {any} */
function ctx() {
    return SillyTavern.getContext();
}

/** @returns {Record<string, any>} */
function getSettings() {
    return ctx().extensionSettings[MODULE_NAME];
}

/**
 * @param {any} value
 * @returns {string}
 */
function trim(value) {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalizes a tag string: comma-separated, deduplicated, trimmed, capped — and
 * says how much the cap took.
 *
 * The dropped count is the whole reason this exists next to normalizeTags(). A
 * silent cut here is indistinguishable from a model that simply stopped writing:
 * an entry that comes back ending in `cream blouse, cream skirt` with no legwear,
 * footwear or accessory looks like a lazy reply and is actually a truncation. Any
 * seeding configuration that asks for a full wardrobe ladder sits right on this
 * limit, so the caller has to be able to say so.
 *
 * @param {any} value
 * @param {number} maxChars - 0 disables the cap
 * @returns {{tags: string, dropped: number}}
 */
function normalizeTagsInfo(value, maxChars) {
    const seen = new Set();
    const tags = [];

    for (const raw of String(value ?? "").split(",")) {
        const tag = raw.trim().replace(/\s+/g, " ");
        if (!tag) continue;
        // The shared fingerprint, so "silver_hair" and "silver hair" are one tag
        // here for the same reason a ban on either catches both.
        const fingerprint = tagFingerprint(tag);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        tags.push(tag);
    }

    const full = tags.join(", ");
    if (!maxChars || full.length <= maxChars) return { tags: full, dropped: 0 };

    // Cut on a tag boundary rather than mid-word.
    let out = full.slice(0, maxChars);
    const lastComma = out.lastIndexOf(",");
    out = (lastComma > 0 ? out.slice(0, lastComma) : out).trim();
    return { tags: out, dropped: full.length - out.length };
}

/**
 * normalizeTagsInfo() when the caller only wants the tags, and warns on a cut so
 * a truncation is never entirely silent.
 * @param {any} value
 * @param {number} maxChars - 0 disables the cap
 * @param {string} [label] - Who the tags belong to, for the warning
 * @returns {string}
 */
function normalizeTags(value, maxChars, label = "") {
    const result = normalizeTagsInfo(value, maxChars);
    if (result.dropped) warnTruncation(label, maxChars, result.dropped);
    return result.tags;
}

/**
 * @param {string} label
 * @param {number} maxChars
 * @param {number} dropped
 * @param {string} [source] - Who wrote the entry, which decides what advice applies
 */
function warnTruncation(label, maxChars, dropped, source = "seed") {
    // Which lever actually lifts the cut depends on who wrote the entry. Growth
    // never reads the Seeding Instructions — it distils the prompt of the image
    // that introduced the character — so naming that field here would be advice
    // that cannot work, which is worse than none.
    const lever = source === "grown"
        ? `Raise "Registry entry size", lower "Max tags" so the prompt it distils is shorter, or edit the entry by hand.`
        : `Raise "Registry entry size", shorten what the seeding pass is asked for, or edit the entry by hand.`;
    warnLog(`the appearance tags for "${label || "?"}" hit the ${maxChars}-character cap — ${dropped} character(s) were dropped from the end. ${lever}`);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * The registry as stored, or a detached empty object when there is none.
 * Safe for reading; writes must go through mutableRegistry().
 * @returns {Record<string, any>}
 */
export function readRegistry() {
    const registry = ctx().chatMetadata?.[APPEARANCE_METADATA_KEY];
    return registry && typeof registry === "object" && !Array.isArray(registry) ? registry : {};
}

/**
 * The registry, created and attached to chat metadata if it does not exist yet.
 * @returns {Record<string, any>}
 */
function mutableRegistry() {
    const metadata = ctx().chatMetadata;
    if (!metadata) throw new Error("No chat is open.");

    const existing = metadata[APPEARANCE_METADATA_KEY];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        metadata[APPEARANCE_METADATA_KEY] = {};
    }
    return metadata[APPEARANCE_METADATA_KEY];
}

/**
 * Registry entries in display order.
 *
 * `truncated` is whether the cap cut this entry's tags when it was written, so
 * the editor can mark a row that stops mid-wardrobe as cut rather than as the
 * model's own idea of complete. `truncatedAt` is the cap that did it, which is
 * not the same as the cap in force now: raising the setting does not lengthen an
 * entry already stored, and reporting today's number against yesterday's cut
 * would read as though the raise had not taken. 0 means it was not cut, or was
 * cut before the number was recorded.
 *
 * @returns {Array<{key: string, name: string, tags: string, source: string, updatedAt: number, truncated: boolean, truncatedAt: number}>}
 */
export function listRegistryEntries() {
    const entries = [];
    for (const [key, value] of Object.entries(readRegistry())) {
        if (!value || typeof value !== "object") continue;
        const truncatedAt = Math.max(0, Math.floor(Number(value.truncatedAt) || 0));
        entries.push({
            key,
            name: trim(value.name) || key,
            tags: trim(value.tags),
            source: trim(value.source) || "seed",
            updatedAt: Number(value.updatedAt) || 0,
            truncated: !!value.truncated || truncatedAt > 0,
            truncatedAt,
        });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The LoRA-style calls the registry has pinned, per character.
 *
 * Empty unless both the registry and `prompter_allow_registry_lora` are on, so
 * the default install never carries a call past the validator. What this feeds is
 * validateDirective's re-insertion: a call the user pinned to a character reaches
 * every image that character is in whether or not the model copied it.
 *
 * @returns {Array<{name: string, loras: string[]}>}
 */
export function listRegistryLoraCalls() {
    const settings = getSettings();
    if (!settings.prompter_appearance_enabled || !settings.prompter_allow_registry_lora) return [];

    const out = [];
    for (const entry of listRegistryEntries()) {
        const loras = extractLoraCalls(entry.tags);
        if (loras.length) out.push({ name: entry.name, loras });
    }
    return out;
}

/** Persists chat metadata. Debounced — the registry is never urgent. */
export function saveRegistry() {
    const context = ctx();
    if (typeof context.saveMetadataDebounced === "function") context.saveMetadataDebounced();
    else if (typeof context.saveMetadata === "function") context.saveMetadata();
}

/**
 * Writes one entry.
 *
 * A hand-edited entry is never overwritten by an automatic source — the caller
 * gets `false` back and is expected to carry on rather than treat it as an error.
 *
 * An entry with no usable tags is refused from an automatic source, because an
 * unusable reply is not worth storing. A hand edit may store one: that is the
 * tombstone described at the top of this file, and the only durable way to keep a
 * key out of every later request.
 *
 * @param {string} key
 * @param {object} entry
 * @param {string} entry.name
 * @param {string} entry.tags
 * @param {"seed" | "grown" | "user"} entry.source
 * @returns {boolean} True when the entry was written
 */
export function setRegistryEntry(key, { name, tags, source }) {
    const registry = mutableRegistry();
    const existing = registry[key];

    if (existing?.source === "user" && source !== "user") {
        debugLog("keeping the hand-edited entry for", key);
        return false;
    }

    if (!existing && Object.keys(registry).length >= MAX_ENTRIES) {
        warnLog(`appearance registry is full at ${MAX_ENTRIES} entries, not adding "${name}"`);
        return false;
    }

    const maxChars = registryMaxChars();
    const clean = normalizeTagsInfo(tags, maxChars);
    if (clean.dropped) warnTruncation(trim(name) || key, maxChars, clean.dropped, source);
    if (!clean.tags && source !== "user") return false;

    registry[key] = {
        name: trim(name) || key,
        tags: clean.tags,
        source,
        updatedAt: Date.now(),
        truncated: clean.dropped > 0,
        // The cap that cut it, not the cap in force whenever the row is next
        // rendered. Those diverge the moment the setting is raised.
        truncatedAt: clean.dropped > 0 ? maxChars : 0,
    };
    return true;
}

/**
 * @param {string} key
 * @returns {boolean} True when something was removed
 */
export function deleteRegistryEntry(key) {
    const registry = mutableRegistry();
    if (!(key in registry)) return false;
    delete registry[key];
    return true;
}

/** Empties the registry and forgets that this chat was ever seeded. */
export function clearRegistry() {
    const metadata = ctx().chatMetadata;
    if (!metadata) return;
    metadata[APPEARANCE_METADATA_KEY] = {};
    delete metadata[APPEARANCE_SEEDED_KEY];
    delete metadata[APPEARANCE_SEEDED_COUNT_KEY];
    saveRegistry();
}

/**
 * The master switch. With it off the registry is neither sent, seeded nor grown,
 * but what is already stored is kept and stays editable.
 * @returns {boolean}
 */
export function appearanceEnabled() {
    return !!getSettings().prompter_appearance_enabled;
}

/** @returns {boolean} */
export function isRegistrySeeded() {
    return !!ctx().chatMetadata?.[APPEARANCE_SEEDED_KEY];
}

/**
 * Visible messages in the current chat — the yardstick the refresh interval is
 * measured in.
 * @returns {number}
 */
function visibleMessageCount() {
    const chat = Array.isArray(ctx().chat) ? ctx().chat : [];
    return chat.filter((/** @type {any} */ m) => m && !m.is_system).length;
}

/**
 * True when this chat has moved far enough past its last seeding pass to be worth
 * seeding again.
 *
 * A chat seeded on its greeting knows nothing about who walks into it later, and
 * a once-per-chat registry is exactly as static as a per-character one — which is
 * the complaint this interval exists to answer.
 *
 * A chat seeded before this counter existed has no baseline. It is treated as `0`
 * rather than as "never refresh", so such a chat re-seeds once with the chat in
 * view and then follows the interval like any other.
 *
 * @param {Record<string, any>} settings
 * @returns {boolean}
 */
export function seedIsStale(settings) {
    const interval = Math.max(0, Math.floor(Number(settings.prompter_seed_refresh_messages) || 0));
    if (!interval) return false;

    const seededAt = Number(ctx().chatMetadata?.[APPEARANCE_SEEDED_COUNT_KEY]);
    const baseline = Number.isFinite(seededAt) ? seededAt : 0;
    return visibleMessageCount() - baseline >= interval;
}

/**
 * One line for the registry editor: whether this chat has been seeded, and how
 * many messages are left before it is seeded again.
 *
 * The editor is where someone goes when the registry surprises them, and "the
 * entries look like the last chat's" and "the entries are the last chat's" are
 * two very different problems. This says which one they are looking at.
 *
 * @returns {string}
 */
export function describeSeedingState() {
    if (!isRegistrySeeded()) return "not run yet";

    const settings = getSettings();
    const interval = Math.max(0, Math.floor(Number(settings.prompter_seed_refresh_messages) || 0));
    if (!interval) return "done, and set to never run again in this chat";

    const seededAt = Number(ctx().chatMetadata?.[APPEARANCE_SEEDED_COUNT_KEY]);
    const baseline = Number.isFinite(seededAt) ? seededAt : 0;
    const remaining = interval - (visibleMessageCount() - baseline);
    return remaining <= 0
        ? "done, and due to run again on the next image"
        : `done, and due to run again in ${remaining} message(s)`;
}

/**
 * The registry key for a character name: the avatar filename when the name
 * belongs to a card in this chat, an `npc:` slug otherwise. Avatar filenames
 * survive a rename; a discovered NPC has nothing better than their name.
 * @param {string} name
 * @returns {string}
 */
export function resolveCharacterKey(name) {
    const wanted = trim(name).toLowerCase();
    if (!wanted) return "";

    for (const member of listCastMembers()) {
        if (member.name.toLowerCase() === wanted) return member.key;
    }

    const slug = `npc:${wanted.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
    return slug === "npc:" ? "" : slug;
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

/**
 * True when `name` appears in `haystack` as a whole word.
 *
 * Word boundaries, not substrings: "Ana" must not match "Anastasia", or the whole
 * filter degrades to "keep anything whose name is a common prefix".
 * @param {string} haystack
 * @param {string} name
 * @returns {boolean}
 */
function mentionsName(haystack, name) {
    if (!haystack || !name) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
        return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(haystack);
    } catch (err) {
        // A name that will not compile into a pattern is kept rather than dropped.
        debugLog(`could not build a mention pattern for "${name}"`, err);
        return true;
    }
}

/**
 * True when the scope setting puts the registry in the volatile half of the
 * request rather than the cacheable half.
 *
 * "present" makes the section depend on the target message, so leaving it in the
 * stable block would invalidate the cached prefix on every single turn — which
 * costs far more than the entries it drops save.
 * @param {Record<string, any>} settings
 * @returns {boolean}
 */
export function appearanceSectionIsVolatile(settings) {
    return settings.prompter_appearance_scope === "present";
}

/**
 * The registry as a prompt section — reference data, so it is placed early rather
 * than among the instructions.
 *
 * On the default `"all"` scope every entry with tags is sent. On `"present"` an
 * entry is kept when it belongs to a cast member, or when its name appears in the
 * target message or the history window that was actually rendered. Cast members
 * are unconditional on purpose: the character this chat is about is in frame far
 * more often than their name is written, and dropping them is the worst failure an
 * appearance registry has available.
 *
 * @param {Record<string, any>} settings
 * @param {object} [frame]
 * @param {string} [frame.targetText] - The message being illustrated
 * @param {string} [frame.historyText] - The rendered history window
 * @returns {Array<{title: string, body: string}>}
 */
export function buildAppearanceSection(settings, { targetText = "", historyText = "" } = {}) {
    if (!settings.prompter_appearance_enabled) return [];

    const entries = listRegistryEntries().filter(entry => entry.tags);
    if (!entries.length) return [];

    let kept = entries;
    if (appearanceSectionIsVolatile(settings)) {
        const castKeys = new Set(listCastMembers().map(member => member.key));
        kept = entries.filter(entry => castKeys.has(entry.key)
            || mentionsName(targetText, entry.name)
            || mentionsName(historyText, entry.name));

        const dropped = entries.length - kept.length;
        if (dropped) {
            debugLog(`appearance scope "present" dropped ${dropped} of ${entries.length} entries`, {
                kept: kept.map(entry => entry.name),
            });
        }
    }
    if (!kept.length) return [];

    return [{
        title: "APPEARANCE REGISTRY",
        // The instruction travels with the data rather than living in TASK.
        // buildAppearanceSection returns nothing when the feature is off, when no
        // entry has tags, or when "present" scope drops everyone — and seeding is
        // a once-per-chat call that runs *before* the first directive, so a bullet
        // in TASK told every fresh chat to consult a section that was not there.
        body: [
            REGISTRY_DISCIPLINE,
            "",
            ...kept.map(entry => `${entry.name}: ${substituteTrimmed(entry.tags)}`),
        ].join("\n"),
    }];
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * The seeding call's own output contract — a different job from the per-message
 * directive, so a different schema.
 * @returns {object}
 */
export function buildAppearanceSchema() {
    return {
        type: "object",
        additionalProperties: false,
        required: ["characters"],
        properties: {
            characters: {
                type: "array",
                description: "One entry per character with a described appearance.",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["name", "tags"],
                    properties: {
                        name: {
                            type: "string",
                            description: "The character's name, exactly as given in CAST.",
                        },
                        tags: {
                            type: "string",
                            description: "Booru-style comma-separated appearance tags.",
                        },
                    },
                },
            },
        },
    };
}

export const APPEARANCE_SCHEMA = buildAppearanceSchema();

/**
 * Schema and example as prompt text, for backends that cannot enforce a schema.
 * Sent in both modes so a mid-flight degrade needs no prompt rebuild.
 *
 * The example tags are a parameter, read live by the caller, so an edited setting
 * takes effect on the next seeding pass rather than on the next page reload.
 *
 * The cap is stated from the live setting rather than from a constant. Stating a
 * number the writer is not actually held to is worse than stating none: the pass
 * writes to the figure it was given and the difference is silently cut off the
 * end.
 *
 * @param {object} [options]
 * @param {string} [options.exampleTags] - The example entry's tag string
 * @param {boolean} [options.includeSchema=true] - Restate the schema JSON in the prompt
 * @param {number} [options.maxChars] - The per-character cap to state
 * @returns {string}
 */
function renderSeedOutputRules({ exampleTags = "", includeSchema = true, maxChars = DEFAULT_REGISTRY_MAX_CHARS } = {}) {
    const tags = String(exampleTags || "").trim() || DEFAULT_PROMPTER_SEED_EXAMPLE_TAGS;
    const example = {
        characters: [
            { name: "Character name", tags },
        ],
    };

    return [
        "Return exactly one JSON object and nothing else. No prose before or after it, no code fence.",
        // Omitted while the backend enforces the schema itself, on the same
        // reasoning as the directive pass's. The example always stays.
        ...(includeSchema ? ["", "Schema:", JSON.stringify(APPEARANCE_SCHEMA, null, 2)] : []),
        "",
        "Example of a filled reply:",
        JSON.stringify(example, null, 2),
        "",
        "Hard rules:",
        `- "tags" is capped at ${maxChars} characters per character.`,
        `- Return an empty "characters" array if nothing in the source describes anyone's appearance.`,
    ].join("\n");
}

/**
 * The chat's own content, which is what makes a registry belong to a chat rather
 * than to a character card.
 *
 * The cards and the lorebooks are identical in every chat that character is ever
 * in, so a pass that reads only those writes the same answer every time — the
 * registry is stored per chat but its contents are per character. These two
 * sections are the difference: who has actually turned up, and what this
 * particular story has done to how they look.
 *
 * Rendered last among the reference material, immediately before OUTPUT RULES, so
 * recency backs up the instruction that the chat outranks the card.
 *
 * @param {Record<string, any>} settings
 * @returns {Array<{title: string, body: string}>}
 */
function buildSeedChatSections(settings) {
    const sections = [];
    const chat = Array.isArray(ctx().chat) ? ctx().chat : [];

    if (settings.prompter_seed_include_summary) {
        // Newest first: the running summary lives on the last message that has
        // one, the same way the directive pass finds it.
        for (let i = chat.length - 1; i >= 0; i--) {
            const summary = trim(chat[i]?.extra?.memory);
            if (!summary) continue;
            sections.push({ title: "RUNNING SUMMARY (of the story so far)", body: summary });
            break;
        }
    }

    const count = Math.max(0, Math.floor(Number(settings.prompter_seed_history_count) || 0));
    if (!count) return sections;

    const visible = chat.filter((/** @type {any} */ m) => m && !m.is_system);
    const lines = visible.slice(-count).map((/** @type {any} */ message) => {
        const speaker = message.name || (message.is_user ? "User" : "Character");
        const text = stripImages(message.mes);
        return text ? `${speaker}: ${text}` : "";
    }).filter(Boolean);
    if (!lines.length) return sections;

    sections.push({
        title: `CHAT SO FAR (last ${lines.length} of ${visible.length} messages)`,
        body: lines.join("\n\n"),
    });
    return sections;
}

/**
 * Builds the seeding prompt from the cast, every bound lorebook, and the chat.
 * @param {object} [options]
 * @param {"native" | "json" | null} [options.structuredMode] - Forces whether OUTPUT RULES restates the schema
 * @returns {Promise<{systemPrompt: string, sections: Array<{title: string, body: string}>, cast: string[]} | null>}
 */
async function buildSeedContext({ structuredMode = null } = {}) {
    await ensureCardsLoaded();

    const settings = getSettings();
    const cast = listCastMembers();
    if (!cast.length) return null;

    const seedInstructions = substituteTrimmed(settings.prompter_seed_system_prompt)
        || substituteTrimmed(DEFAULT_PROMPTER_SEED_SYSTEM_PROMPT);
    const sections = [{ title: "TASK", body: seedInstructions }];

    sections.push({
        title: `CAST (${cast.length} character${cast.length === 1 ? "" : "s"})`,
        body: cast.map(member => {
            const parts = [`### ${member.name}`];
            if (member.description) parts.push(member.description);
            if (member.personality) parts.push(`Personality: ${member.personality}`);
            if (member.scenario) parts.push(`Scenario: ${member.scenario}`);
            if (member.depthPrompt) parts.push(`Always-on note: ${member.depthPrompt}`);
            return parts.join("\n");
        }).join("\n\n"),
    });

    // Full-book read, not the activation scanner: an entry that describes a
    // character still describes them when nothing in the last few messages
    // happens to mention their name.
    const lore = await readBoundLore(settings.prompter_lore_max_chars);
    if (lore.text) {
        sections.push({
            title: `LOREBOOKS (${lore.books.join(", ")})${lore.truncated ? " — truncated" : ""}`,
            body: lore.text,
        });
    }

    const persona = trim(ctx().powerUserSettings?.persona_description);
    if (persona && settings.prompter_include_persona) {
        const name = trim(ctx().name1) || "User";
        sections.push({ title: `USER PERSONA — ${name}`, body: persona });
    }

    sections.push(...buildSeedChatSections(settings));

    sections.push({
        title: "OUTPUT RULES",
        body: renderSeedOutputRules({
            exampleTags: substituteTrimmed(settings.prompter_seed_example_tags),
            includeSchema: schemaBelongsInPrompt(structuredMode),
            maxChars: registryMaxChars(),
        }),
    });

    // The seeding pass's own last word, and deliberately not shared with the
    // directive pass's. The two ask different questions: generation policy is
    // meaningless here, and a standing framing that only reaches the directive pass
    // leaves the registry empty — which then degrades every image after it.
    const finalInstructions = substituteTrimmed(settings.prompter_seed_final_instructions);
    if (finalInstructions) {
        sections.push({ title: "FINAL INSTRUCTIONS", body: finalInstructions });
    }

    return {
        systemPrompt: renderSections(sections),
        sections,
        cast: cast.map(member => member.name),
    };
}

/**
 * Validates a seeding reply.
 *
 * Banned tags are stripped here as well as in validateDirective, and not for
 * symmetry's sake: a banned tag that reaches a registry entry is injected into
 * every subsequent request, where validateDirective only catches it if the model
 * happens to copy it into `prompt`. A tag the user has banned should not be able
 * to enter the registry at all.
 *
 * Growth needs no equivalent — it distills its tags from an image prompt that has
 * already been through validateDirective.
 *
 * @param {any} parsed
 * @param {object} [options]
 * @param {any} [options.bannedTags] - Tags to strip; comma-separated string or array
 * @returns {Array<{name: string, tags: string}>}
 */
export function validateAppearanceReply(parsed, { bannedTags = "" } = {}) {
    if (!parsed || typeof parsed !== "object") return [];

    const raw = Array.isArray(parsed.characters) ? parsed.characters : [];
    const banned = parseTagList(bannedTags).fingerprints;
    const out = [];

    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const name = trim(entry.name);
        const stripped = stripBannedTags(entry.tags, banned);
        if (stripped.removed.length) {
            warnLog(`dropped ${stripped.removed.length} banned tag(s) from the seeded entry for "${name || "?"}":`, stripped.removed.join(", "));
        }
        // An entry left with nothing is dropped rather than written empty — the
        // same rule an unusable reply has always taken.
        //
        // Uncapped on purpose: setRegistryEntry applies the cap, and it has to be
        // the only place that does. Capping twice means the second call sees text
        // that already fits and records the entry as untruncated, which is exactly
        // the silence gap 2 was about.
        const tags = normalizeTags(stripped.prompt, 0);
        if (!name || !tags) continue;
        out.push({ name, tags });
    }

    return out;
}

/**
 * Runs the seeding pass: one LLM call over the cards, the bound lorebooks and the
 * chat, writing a registry entry per character it can describe.
 *
 * @param {object} [options]
 * @param {AbortSignal | null} [options.signal]
 * @returns {Promise<{written: string[], skipped: string[], seen: number}>}
 * @throws {Error} On a transport or parse failure — the caller decides how loud that is
 */
export async function seedRegistry({ signal = null } = {}) {
    if (seedingInFlight) throw new Error("A seeding pass is already running.");

    seedingInFlight = true;
    try {
        const built = await buildSeedContext();
        if (!built) throw new Error("No character card to seed from.");

        debugLog("seeding the appearance registry", { cast: built.cast, chars: built.systemPrompt.length });
        debugLog("seeding prompt\n", built.systemPrompt);

        const result = await runPrompter({
            // One system message, unlike the directive pass: the seeding call runs
            // once per chat, so there is no prefix to reuse and nothing to gain
            // from splitting it.
            messages: [{ role: "system", content: built.systemPrompt }],
            signal,
            schema: APPEARANCE_SCHEMA,
            schemaName: SEED_SCHEMA_NAME,
            // Resolved here rather than by widening runPrompter's order, so an
            // emptied seeding turn falls back to the seeding default and never
            // silently inherits `prompter_user_turn` — which asks for an image
            // directive, not a registry.
            userTurn: substituteTrimmed(getSettings().prompter_seed_user_turn)
                || substituteTrimmed(DEFAULT_PROMPTER_SEED_USER_TURN),
            // Put the schema JSON back if the backend refuses to enforce it.
            rebuild: async (structuredMode) => {
                const rebuilt = await buildSeedContext({ structuredMode });
                return rebuilt ? [{ role: "system", content: rebuilt.systemPrompt }] : [];
            },
            // A full cast needs more room than a single image directive does.
            maxTokens: Math.max(1024, Number(getSettings().prompter_max_tokens) || 1024),
        });

        const characters = validateAppearanceReply(parseDirective(result.payload), {
            bannedTags: getSettings().prompter_banned_tags,
        });

        const written = [];
        const skipped = [];
        for (const character of characters) {
            const key = resolveCharacterKey(character.name);
            if (!key) continue;
            if (setRegistryEntry(key, { name: character.name, tags: character.tags, source: "seed" })) {
                written.push(character.name);
            } else {
                skipped.push(character.name);
            }
        }

        markSeeded();
        await persistNow();

        debugLog("seeding done", { written, skipped });
        return { written, skipped, seen: characters.length };
    } finally {
        seedingInFlight = false;
    }
}

/** Records that this chat has just been seeded, and how far along it was. */
function markSeeded() {
    const metadata = ctx().chatMetadata;
    if (!metadata) return;
    metadata[APPEARANCE_SEEDED_KEY] = Date.now();
    metadata[APPEARANCE_SEEDED_COUNT_KEY] = visibleMessageCount();
}

/** Flushes chat metadata immediately — a seeding pass is worth not losing. */
async function persistNow() {
    const context = ctx();
    if (typeof context.saveMetadata === "function") await context.saveMetadata();
    else saveRegistry();
}

/**
 * Seeds the registry the first time the dedicated path runs in a chat, and again
 * every `prompter_seed_refresh_messages` messages after that.
 *
 * The refresh is not a nicety. The first automatic pass fires on the first
 * character message, which in a fresh chat is the greeting — at that point the
 * chat has told the pass nothing, and a registry built from the card alone is the
 * same registry every chat on that card would get. The interval is what lets the
 * registry catch up with a story that has since introduced people and changed
 * what they are wearing. Hand-edited entries are never touched by it.
 *
 * Failure is never fatal to the run that triggered it: the prompter works
 * perfectly well without a registry, it just has to describe the character from
 * the card every time.
 *
 * @param {object} [options]
 * @param {AbortSignal | null} [options.signal]
 * @returns {Promise<boolean>} True when a seeding pass actually ran
 */
export async function ensureRegistrySeeded({ signal = null } = {}) {
    const settings = getSettings();
    if (!settings.prompter_appearance_enabled) return false;
    if (!settings.prompter_appearance_autoseed) return false;
    if (seedingInFlight) return false;
    if (isRegistrySeeded() && !seedIsStale(settings)) return false;

    const chatId = String(ctx().getCurrentChatId?.() || "");
    if (seedFailures.has(chatId)) return false;

    try {
        await seedRegistry({ signal });
        return true;
    } catch (err) {
        if (signal?.aborted) return false;
        seedFailures.add(chatId);
        warnLog("appearance seeding failed, continuing without a registry", err?.message || err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

// Tags that describe the moment rather than the person. Growth freezes tags
// taken from one image's prompt, so the per-image vocabulary has to come out
// first or "rain, night, city street" becomes part of who someone is.
//
// This is a heuristic and it is meant to be: grown entries are marked "grown"
// precisely so the registry editor can show which ones are a first guess.
const TRANSIENT_TAG_PATTERNS = [
    // camera and composition
    /\b(close-?up|upper body|full body|cowboy shot|portrait|from (above|below|behind|the side)|pov|dutch angle|profile|bird'?s.eye|depth of field|bokeh|wide shot|face focus|solo focus)\b/i,
    // pose and action
    /\b(standing|sitting|kneeling|lying|walking|running|leaning|crouching|jumping|dancing|sleeping|hugging|holding|reaching|looking|arms? (up|crossed|out)|hands? on|head tilt|turning)\b/i,
    // expression
    /\b(smile|smiling|grin|grinning|laughing|crying|tears|blush|blushing|frown|angry|surprised|open mouth|closed eyes|half-closed eyes|serious|smirk|embarrassed|worried|shouting)\b/i,
    // setting, weather, time of day
    /\b(indoors?|outdoors?|night|day|daytime|nighttime|evening|morning|dusk|dawn|sunset|sunrise|rain|raining|snow|snowing|storm|fog|mist|forest|city|town|street|alley|road|room|bedroom|bathroom|kitchen|office|classroom|beach|ocean|mountain|field|sky|clouds?|window|doorway|bed|couch|chair|table|wall|floor|background|scenery|landscape|pavement|ruins|castle|tavern)\b/i,
    // light and mood
    /\b(lighting|backlit|sunlight|moonlight|candlelight|firelight|neon|shadows?|glow|glowing|dramatic|cinematic|atmospheric|wet|soaked|steam|dust|sparkles?|motion blur)\b/i,
    // quality and medium boilerplate
    /\b(masterpiece|best quality|high quality|highly detailed|absurdres|highres|8k|4k|ultra[- ]detailed|illustration|artwork|sketch|painting)\b/i,
];

/**
 * Reduces an image prompt to the tags that plausibly describe the character
 * rather than the moment.
 *
 * Uncapped, for the same reason validateAppearanceReply is: setRegistryEntry
 * applies the entry cap, and one cap in one place is what lets the entry record
 * that it was cut.
 *
 * @param {string} prompt
 * @returns {string}
 */
export function distillAppearanceTags(prompt) {
    const kept = String(prompt ?? "")
        .split(",")
        .map(tag => tag.trim())
        .filter(tag => tag
            // A long tag is a sentence fragment, not a booru tag.
            && tag.length <= 40
            && !TRANSIENT_TAG_PATTERNS.some(pattern => pattern.test(tag)));

    return normalizeTags(kept.join(", "), 0);
}

/**
 * Adds registry entries for characters the prompter drew but did not know about.
 *
 * Only images with exactly one character grow the registry. In a two-character
 * image there is no way to tell whose hair is whose, and guessing would poison
 * the very thing the registry exists to keep consistent.
 *
 * @param {Array<{prompt: string, characters: string[]}>} images
 * @returns {string[]} The names added
 */
export function growRegistry(images) {
    if (!getSettings().prompter_appearance_enabled) return [];

    const grown = [];

    for (const image of images || []) {
        const names = Array.isArray(image?.characters) ? image.characters.filter(Boolean) : [];
        if (names.length !== 1) {
            if (names.length > 1) debugLog("not growing the registry from a multi-character image", names);
            continue;
        }

        const name = trim(names[0]);
        const key = resolveCharacterKey(name);
        if (!key || readRegistry()[key]) continue;

        const tags = distillAppearanceTags(image.prompt);
        if (!tags) continue;

        if (setRegistryEntry(key, { name, tags, source: "grown" })) grown.push(name);
    }

    if (grown.length) {
        saveRegistry();
        debugLog("appearance registry grew", grown);
    }
    return grown;
}

/** Drops the in-memory seeding-failure memory. Called on CHAT_CHANGED. */
export function resetAppearanceState() {
    seedFailures.clear();
}
