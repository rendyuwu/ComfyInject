// Read-only SillyTavern accessors shared by the two prompter passes: the
// per-message context builder and the appearance seeding pass.
//
// Both need the same raw material — the cast of the current chat and the
// lorebooks bound to it — and both render it into the same delimited section
// format, so all of that lives here rather than being written twice.
//
// Everything goes through SillyTavern.getContext() and every optional call is
// probed with typeof, so an older or newer SillyTavern degrades to less material
// instead of throwing.

import { debugLog } from "./log.js";

// The chat-bound lorebook is stored under this key in chat metadata.
const CHAT_LOREBOOK_METADATA_KEY = "world_info";

/**
 * @typedef {{ title: string, body: string }} Section
 * @typedef {{ key: string, name: string, description: string, personality: string, scenario: string, depthPrompt: string }} CastMember
 */

/** @returns {any} */
function ctx() {
    return SillyTavern.getContext();
}

/**
 * @param {any} value
 * @returns {string}
 */
function trim(value) {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * Character cards are metadata-only ("shallow") right after a page load, so
 * reading them before unshallowing yields empty strings.
 */
export async function ensureCardsLoaded() {
    const context = ctx();
    try {
        if (context.groupId) {
            await context.unshallowGroupMembers?.(context.groupId);
        } else if (context.characterId !== undefined && context.characterId !== null) {
            await context.unshallowCharacter?.(context.characterId);
        }
    } catch (err) {
        debugLog("unshallow failed", err);
    }
}

/**
 * The active character's card, read through the core resolver so macros and
 * chat-level overrides are respected, with the raw card as a per-field fallback.
 * @param {any} character
 * @returns {CastMember}
 */
function readActiveCard(character) {
    let fields = {};
    try {
        fields = ctx().getCharacterCardFields?.() || {};
    } catch (err) {
        debugLog("getCharacterCardFields failed, falling back to the raw card", err);
    }

    return {
        key: trim(character.avatar) || trim(character.name) || "character",
        name: trim(character.name) || "Character",
        description: trim(fields.description) || trim(character.description),
        personality: trim(fields.personality) || trim(character.personality),
        scenario: trim(fields.scenario) || trim(character.scenario),
        depthPrompt: trim(fields.charDepthPrompt),
    };
}

/**
 * A group member's card. getCharacterCardFields() only ever resolves the active
 * character, so members are read raw.
 * @param {any} character
 * @returns {CastMember}
 */
function readRawCard(character) {
    return {
        key: trim(character.avatar) || trim(character.name) || "character",
        name: trim(character.name) || "Character",
        description: trim(character.description),
        personality: trim(character.personality),
        scenario: trim(character.scenario),
        depthPrompt: trim(character.data?.extensions?.depth_prompt?.prompt),
    };
}

/**
 * The characters this chat is actually about: the solo card, or every member of
 * the group. `key` is the avatar filename, which survives a rename.
 *
 * Call ensureCardsLoaded() first, or the cards may still be shallow.
 * @returns {CastMember[]}
 */
export function listCastMembers() {
    const context = ctx();

    if (context.groupId) {
        const group = context.groups?.find((/** @type {any} */ g) => g.id === context.groupId);
        if (!group) return [];
        return (group.members || [])
            .map((/** @type {string} */ avatar) => context.characters?.find((/** @type {any} */ c) => c.avatar === avatar))
            .filter(Boolean)
            .map(readRawCard);
    }

    const character = context.characters?.[context.characterId];
    return character ? [readActiveCard(character)] : [];
}

/**
 * The name of the current group, or null in a solo chat.
 * @returns {string | null}
 */
export function getGroupName() {
    const context = ctx();
    if (!context.groupId) return null;
    const group = context.groups?.find((/** @type {any} */ g) => g.id === context.groupId);
    return group ? (trim(group.name) || "Group") : null;
}

/**
 * Every lorebook bound to the current chat: the character's own book, each group
 * member's book, the chat book, the persona book, and the global selection.
 *
 * `selected_world_info` is not exposed on the context object, so the globally
 * selected books are read off the World Info panel's multiselect, which core
 * keeps in sync.
 * @returns {string[]}
 */
export function getBoundLorebookNames() {
    const context = ctx();
    const known = new Set(context.getWorldInfoNames?.() || []);
    /** @type {string[]} */
    const names = [];

    const push = (/** @type {any} */ name) => {
        const value = trim(name);
        if (value && known.has(value) && !names.includes(value)) names.push(value);
    };

    push(context.characters?.[context.characterId]?.data?.extensions?.world);

    const group = context.groups?.find((/** @type {any} */ g) => g.id === context.groupId);
    for (const avatar of group?.members || []) {
        push(context.characters?.find((/** @type {any} */ c) => c.avatar === avatar)?.data?.extensions?.world);
    }

    push(context.chatMetadata?.[CHAT_LOREBOOK_METADATA_KEY]);
    push(context.powerUserSettings?.persona_description_lorebook);

    try {
        for (const option of document.querySelectorAll("#world_info option")) {
            if (option instanceof HTMLOptionElement && option.selected) push(option.textContent);
        }
    } catch (err) {
        debugLog("could not read the global world info selection", err);
    }

    return names;
}

/**
 * Every enabled entry in every bound lorebook, whether or not it is currently
 * triggering.
 *
 * The per-message pass deliberately uses the activation scanner instead; this is
 * for the appearance seeding pass, where an entry that describes a character but
 * is not keyed by anything in the last few messages is exactly what is wanted.
 *
 * @param {number} maxChars - Budget across all books
 * @returns {Promise<{ text: string, books: string[], truncated: boolean }>}
 */
export async function readBoundLore(maxChars) {
    const context = ctx();
    const empty = { text: "", books: [], truncated: false };
    if (typeof context.loadWorldInfo !== "function") return empty;

    const names = getBoundLorebookNames();
    if (!names.length) return empty;

    let budget = Math.max(1000, Number(maxChars) || 4000);
    let truncated = false;
    /** @type {string[]} */
    const blocks = [];
    /** @type {string[]} */
    const books = [];

    for (const name of names) {
        if (budget <= 0) {
            truncated = true;
            break;
        }

        let book = null;
        try {
            book = await context.loadWorldInfo(name);
        } catch (err) {
            debugLog(`loadWorldInfo("${name}") failed`, err);
            continue;
        }

        let used = false;
        for (const entry of Object.values(book?.entries || {})) {
            const record = /** @type {any} */ (entry);
            if (!record || record.disable) continue;

            const content = trim(record.content);
            if (!content) continue;

            const keys = Array.isArray(record.key) ? record.key.filter(Boolean) : [];
            const title = trim(record.comment) || keys.join(", ") || `uid ${record.uid}`;
            const block = `### ${name} — ${title}\n${content}`;

            if (block.length > budget) {
                truncated = true;
                break;
            }
            budget -= block.length;
            blocks.push(block);
            used = true;
        }

        if (used) books.push(name);
    }

    return { text: blocks.join("\n\n"), books, truncated };
}

/**
 * Render sections into the delimited form the model sees.
 * @param {Section[]} sections
 * @returns {string}
 */
export function renderSections(sections) {
    return sections
        .map(section => `--- ${section.title} ---\n${section.body}\n--- END ${section.title} ---`)
        .join("\n\n");
}
