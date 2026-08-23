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
//           character cards and every bound lorebook, triggering or not.
//   grown — a character the prompter drew who was not in the registry yet. This
//           is the brand-new NPC case: no card, no lorebook entry, nothing to
//           seed from, but by the second image they have a stable entry.
//   user  — hand-edited in the registry editor.
//
// A "user" entry is never overwritten by seeding or growth. That is the whole
// point of the registry being editable: a bad automatic guess is fixable by hand
// instead of by re-rolling the model.

import { MODULE_NAME } from "../../settings.js";
import { debugLog, warnLog } from "./log.js";
import { runPrompter } from "./llm.js";
import { parseDirective } from "./schema.js";
import { ensureCardsLoaded, listCastMembers, readBoundLore, renderSections } from "./sources.js";

export const APPEARANCE_METADATA_KEY = "comfyinject_appearance";
export const APPEARANCE_SEEDED_KEY = "comfyinject_appearance_seeded";

// Structured output name for the seeding call.
const SEED_SCHEMA_NAME = "ComfyInjectAppearance";

// A registry entry is reference data, not a prompt. These caps keep a runaway
// reply from turning every later request into a wall of tags.
const MAX_TAGS_CHARS = 400;
const MAX_ENTRIES = 40;

// Growth takes its tags from the prompt of the image that introduced the
// character, so it is capped harder — it is a first guess, not a considered one.
const MAX_GROWN_TAGS_CHARS = 240;

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
 * Normalizes a tag string: comma-separated, deduplicated, trimmed, capped.
 * @param {any} value
 * @param {number} [maxChars]
 * @returns {string}
 */
function normalizeTags(value, maxChars = MAX_TAGS_CHARS) {
    const seen = new Set();
    const tags = [];

    for (const raw of String(value ?? "").split(",")) {
        const tag = raw.trim().replace(/\s+/g, " ");
        if (!tag) continue;
        const fingerprint = tag.toLowerCase();
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        tags.push(tag);
    }

    let out = tags.join(", ");
    if (out.length > maxChars) {
        // Cut on a tag boundary rather than mid-word.
        out = out.slice(0, maxChars);
        const lastComma = out.lastIndexOf(",");
        out = (lastComma > 0 ? out.slice(0, lastComma) : out).trim();
    }
    return out;
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
 * @returns {Array<{key: string, name: string, tags: string, source: string, updatedAt: number}>}
 */
export function listRegistryEntries() {
    const entries = [];
    for (const [key, value] of Object.entries(readRegistry())) {
        if (!value || typeof value !== "object") continue;
        entries.push({
            key,
            name: trim(value.name) || key,
            tags: trim(value.tags),
            source: trim(value.source) || "seed",
            updatedAt: Number(value.updatedAt) || 0,
        });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
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

    const cleanTags = normalizeTags(tags, source === "grown" ? MAX_GROWN_TAGS_CHARS : MAX_TAGS_CHARS);
    if (!cleanTags) return false;

    registry[key] = {
        name: trim(name) || key,
        tags: cleanTags,
        source,
        updatedAt: Date.now(),
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
 * The registry as a prompt section, placed early in the context because it is
 * reference data rather than instruction.
 * @param {Record<string, any>} settings
 * @returns {Array<{title: string, body: string}>}
 */
export function buildAppearanceSection(settings) {
    if (!settings.prompter_appearance_enabled) return [];

    const lines = listRegistryEntries()
        .filter(entry => entry.tags)
        .map(entry => `${entry.name}: ${entry.tags}`);
    if (!lines.length) return [];

    return [{
        title: "APPEARANCE REGISTRY (use these tags verbatim for these characters)",
        body: lines.join("\n"),
    }];
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const SEED_SYSTEM_PROMPT = `You extract stable physical appearance tags for the characters of a roleplay, so a text-to-image model can draw the same person the same way every time.

Rules:
- One entry per character in the CAST section. Use each character's name exactly as it appears there.
- Booru-style comma-separated tags only. No sentences, no narration.
- Include only what is stable and visible: apparent gender and age, hair colour, length and style, eye colour, skin tone, build, height, distinguishing marks, and the outfit the character normally wears.
- Do not include pose, expression, camera framing, lighting, setting, weather, mood or quality tags. Those change from image to image and must not be pinned to a character.
- Do not invent details the source text does not support. Five accurate tags are worth more than twenty guessed ones.
- Omit a character entirely if the source text says nothing about how they look.`;

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
 * @returns {string}
 */
function renderSeedOutputRules() {
    const example = {
        characters: [
            { name: "Character name", tags: "1girl, long silver hair, red eyes, pale skin, slender, black military coat, gold epaulettes" },
        ],
    };

    return [
        "Return exactly one JSON object and nothing else. No prose before or after it, no code fence.",
        "",
        "Schema:",
        JSON.stringify(APPEARANCE_SCHEMA, null, 2),
        "",
        "Example of a filled reply:",
        JSON.stringify(example, null, 2),
        "",
        "Hard rules:",
        `- "tags" is capped at ${MAX_TAGS_CHARS} characters per character.`,
        `- Return an empty "characters" array if nothing in the source describes anyone's appearance.`,
    ].join("\n");
}

/**
 * Builds the seeding prompt from the cast and every bound lorebook.
 * @returns {Promise<{systemPrompt: string, sections: Array<{title: string, body: string}>, cast: string[]} | null>}
 */
async function buildSeedContext() {
    await ensureCardsLoaded();

    const settings = getSettings();
    const cast = listCastMembers();
    if (!cast.length) return null;

    const sections = [{ title: "TASK", body: SEED_SYSTEM_PROMPT }];

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

    sections.push({ title: "OUTPUT RULES", body: renderSeedOutputRules() });

    return {
        systemPrompt: renderSections(sections),
        sections,
        cast: cast.map(member => member.name),
    };
}

/**
 * Validates a seeding reply.
 * @param {any} parsed
 * @returns {Array<{name: string, tags: string}>}
 */
export function validateAppearanceReply(parsed) {
    if (!parsed || typeof parsed !== "object") return [];

    const raw = Array.isArray(parsed.characters) ? parsed.characters : [];
    const out = [];

    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const name = trim(entry.name);
        const tags = normalizeTags(entry.tags);
        if (!name || !tags) continue;
        out.push({ name, tags });
    }

    return out;
}

/**
 * Runs the seeding pass: one LLM call over the cards and the bound lorebooks,
 * writing a registry entry per character it can describe.
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

        const result = await runPrompter({
            systemPrompt: built.systemPrompt,
            signal,
            schema: APPEARANCE_SCHEMA,
            schemaName: SEED_SCHEMA_NAME,
            userTurn: "Return the JSON appearance registry now.",
            // A full cast needs more room than a single image directive does.
            maxTokens: Math.max(1024, Number(getSettings().prompter_max_tokens) || 1024),
        });

        const characters = validateAppearanceReply(parseDirective(result.payload));

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

/** Records that this chat has had its one automatic seeding pass. */
function markSeeded() {
    const metadata = ctx().chatMetadata;
    if (metadata) metadata[APPEARANCE_SEEDED_KEY] = Date.now();
}

/** Flushes chat metadata immediately — a seeding pass is worth not losing. */
async function persistNow() {
    const context = ctx();
    if (typeof context.saveMetadata === "function") await context.saveMetadata();
    else saveRegistry();
}

/**
 * Seeds the registry the first time the dedicated path runs in a chat.
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
    if (isRegistrySeeded() || seedingInFlight) return false;

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

    return normalizeTags(kept.join(", "), MAX_GROWN_TAGS_CHARS);
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
