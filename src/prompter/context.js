// Assembles the dedicated prompter's system prompt from live SillyTavern state:
// character card(s), persona, author's note, running summary, world info,
// the appearance registry, recent history and the message being illustrated.
//
// Everything is read through SillyTavern.getContext() — no static imports from
// core — and every optional call is probed with typeof so an older or newer
// SillyTavern degrades to a smaller prompt instead of throwing.

import { MODULE_NAME } from "../../settings.js";
import { debugLog } from "./log.js";
import { renderOutputRules } from "./schema.js";

// Where the per-chat appearance registry lives. The registry itself is written
// by a later phase; reading it here is all this module needs to do.
export const APPEARANCE_METADATA_KEY = "comfyinject_appearance";

// Image markers and already-generated <img> tags are stripped from anything the
// prompter sees. Leaving them in teaches it to imitate the marker syntax it is
// meant to replace, and burns tokens on base64-free but very long tag soup.
// SillyTavern's sanitizer prefixes the class with "custom-" in the rendered DOM
// while `mes` keeps the bare class, so both are matched.
const IMG_TAG_REGEX = /<img class="(?:custom-)?comfyinject-image"[^>]*>/g;
const MARKER_REGEX = /\[\[IMG:\s*(.+?)\s*\]\]/gs;

/**
 * @typedef {{ title: string, body: string }} Section
 * @typedef {{ systemPrompt: string, sections: Section[], chars: number, target: { index: number, name: string, text: string } }} BuiltContext
 */

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
 * Removes ComfyInject's own image tags and markers from message text.
 * @param {any} text
 * @returns {string}
 */
function stripImages(text) {
    return String(text ?? "")
        .replace(IMG_TAG_REGEX, "")
        .replace(MARKER_REGEX, "")
        .trim();
}

/**
 * Character cards are metadata-only ("shallow") right after a page load, so
 * reading them before unshallowing yields empty strings.
 */
async function ensureCardsLoaded() {
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
 * Picks the message to illustrate: the requested index, or the newest visible
 * non-empty message.
 * @param {any[]} chat
 * @param {number | null} messageIndex
 * @returns {number}
 */
export function resolveTargetIndex(chat, messageIndex = null) {
    if (Number.isInteger(messageIndex) && messageIndex >= 0 && messageIndex < chat.length) {
        return messageIndex;
    }
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        if (stripImages(message.mes)) return i;
    }
    return -1;
}

/**
 * The prompter's own role and standing instructions.
 * @returns {Section[]}
 */
function buildTaskSection(settings) {
    const body = trim(settings.prompter_system_prompt);
    return body ? [{ title: "TASK", body }] : [];
}

/**
 * The per-chat appearance registry, injected early because it is reference data
 * rather than instruction.
 * @returns {Section[]}
 */
function buildAppearanceSection(settings) {
    if (!settings.prompter_appearance_enabled) return [];

    const registry = ctx().chatMetadata?.[APPEARANCE_METADATA_KEY];
    if (!registry || typeof registry !== "object") return [];

    const lines = [];
    for (const entry of Object.values(registry)) {
        const tags = trim(entry?.tags);
        const name = trim(entry?.name);
        if (tags && name) lines.push(`${name}: ${tags}`);
    }
    if (!lines.length) return [];

    return [{
        title: "APPEARANCE REGISTRY (use these tags verbatim for these characters)",
        body: lines.join("\n"),
    }];
}

/** @returns {Section[]} */
function buildSessionSection() {
    const context = ctx();
    const characterName = context.groupId
        ? (context.groups?.find((/** @type {any} */ g) => g.id === context.groupId)?.name || "Group")
        : (context.characters?.[context.characterId]?.name || "(no character)");

    return [{
        title: "SESSION",
        body: [
            `Character/group: ${characterName}`,
            `Chat file: ${context.getCurrentChatId?.() || "(no chat)"}`,
            `User persona name: ${trim(context.name1) || "User"}`,
        ].join("\n"),
    }];
}

/**
 * Solo card fields via the core resolver, so macros and chat-level overrides are
 * respected. The first message and example dialogue are deliberately omitted:
 * they cost tokens and teach prose style, which the prompter must not imitate.
 * @returns {Section[]}
 */
function buildSoloCardSection() {
    const context = ctx();
    const character = context.characters?.[context.characterId];
    if (!character) return [];

    let fields = {};
    try {
        fields = context.getCharacterCardFields?.() || {};
    } catch (err) {
        debugLog("getCharacterCardFields failed, falling back to the raw card", err);
    }

    const parts = [`Name: ${character.name || "Character"}`];
    const description = trim(fields.description) || trim(character.description);
    const personality = trim(fields.personality) || trim(character.personality);
    const scenario = trim(fields.scenario) || trim(character.scenario);
    const depthPrompt = trim(fields.charDepthPrompt);

    if (description) parts.push(`### Description\n${description}`);
    if (personality) parts.push(`### Personality\n${personality}`);
    if (scenario) parts.push(`### Scenario\n${scenario}`);
    if (depthPrompt) parts.push(`### Always-on note (depth prompt)\n${depthPrompt}`);

    return [{ title: "CHARACTER CARD", body: parts.join("\n\n") }];
}

/**
 * One short block per group member. A group of eight full cards would drown
 * everything else, and for a tagging task only the appearance-bearing fields
 * matter.
 * @returns {Section[]}
 */
function buildGroupCardSection() {
    const context = ctx();
    const group = context.groups?.find((/** @type {any} */ g) => g.id === context.groupId);
    if (!group) return [];

    const members = (group.members || [])
        .map((/** @type {string} */ avatar) => context.characters?.find((/** @type {any} */ c) => c.avatar === avatar))
        .filter(Boolean);
    if (!members.length) return [];

    const blocks = members.map((/** @type {any} */ member) => {
        const parts = [`### ${member.name}`];
        if (trim(member.description)) parts.push(trim(member.description));
        if (trim(member.personality)) parts.push(`Personality: ${trim(member.personality)}`);
        return parts.join("\n");
    });

    return [{
        title: `GROUP CAST — ${group.name || "Group"} (${members.length} members)`,
        body: blocks.join("\n\n"),
    }];
}

/** @returns {Section[]} */
function buildPersonaSection() {
    const context = ctx();
    const description = trim(context.powerUserSettings?.persona_description);
    if (!description) return [];
    const name = trim(context.name1);
    return [{ title: `USER PERSONA${name ? ` — ${name}` : ""}`, body: description }];
}

/** @returns {Section[]} */
function buildAuthorNoteSection() {
    const note = trim(ctx().chatMetadata?.note_prompt);
    return note ? [{ title: "AUTHOR NOTE", body: note }] : [];
}

/**
 * The running summary kept by SillyTavern's Summarize extension, stored on the
 * newest message that carries one. It is what keeps a long chat legible past
 * the history window.
 * @returns {Section[]}
 */
function buildSummarySection() {
    const chat = Array.isArray(ctx().chat) ? ctx().chat : [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const summary = trim(chat[i]?.extra?.memory);
        if (summary) return [{ title: "RUNNING SUMMARY (of the story so far)", body: summary }];
    }
    return [];
}

/**
 * Only the entries SillyTavern would actually activate for the current chat tail.
 *
 * The scanner runs in dry-run mode: no WORLD_INFO_ACTIVATED event is emitted and
 * sticky / cooldown / recursion state in the main chat is left untouched.
 * Reading context must never mutate main-chat state.
 *
 * @param {number} targetIndex
 * @returns {Promise<Section[]>}
 */
async function buildWorldInfoSection(settings, targetIndex) {
    const context = ctx();
    if (settings.prompter_lore_mode !== "activated") return [];
    if (typeof context.getWorldInfoPrompt !== "function") return [];

    const chat = Array.isArray(context.chat) ? context.chat : [];

    // The scanner wants plain strings, newest first.
    const scanChat = chat
        .slice(0, targetIndex + 1)
        .filter((/** @type {any} */ m) => m && !m.is_system)
        .map((/** @type {any} */ m) => stripImages(m.mes))
        .filter(Boolean)
        .reverse();
    if (!scanChat.length) return [];

    try {
        const result = await context.getWorldInfoPrompt(scanChat, Number(context.maxContext) || 4096, true);
        let body = trim(result?.worldInfoString);
        if (!body) return [];

        const budget = Math.max(500, Number(settings.prompter_lore_max_chars) || 4000);
        if (body.length > budget) {
            body = `${body.slice(0, budget).trim()}\n\n[Lore truncated at ${budget} characters. Raise the lore budget in ComfyInject's settings if this matters.]`;
        }

        return [{ title: "WORLD INFO (entries currently active in the main chat)", body }];
    } catch (err) {
        debugLog("getWorldInfoPrompt failed", err);
        return [];
    }
}

/**
 * The messages leading up to the target, so the prompter can tell a new scene
 * from a continuation of the last one. The target itself is rendered separately.
 * @param {number} targetIndex
 * @returns {Section[]}
 */
function buildHistorySection(settings, targetIndex) {
    const chat = Array.isArray(ctx().chat) ? ctx().chat : [];
    const count = Math.max(0, Number(settings.prompter_history_count) || 0);
    if (!count) return [];

    const visible = chat
        .slice(0, targetIndex)
        .filter((/** @type {any} */ m) => m && !m.is_system);
    const slice = visible.slice(-count);

    const lines = slice.map((/** @type {any} */ message) => {
        const speaker = message.name || (message.is_user ? "User" : "Character");
        const text = stripImages(message.mes);
        return text ? `${speaker}: ${text}` : "";
    }).filter(Boolean);
    if (!lines.length) return [];

    return [{
        title: `RECENT HISTORY (last ${lines.length} of ${visible.length} messages before the target)`,
        body: lines.join("\n\n"),
    }];
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

/**
 * Builds the prompter's full system prompt.
 *
 * Section order follows one rule: reference data first, standing orders last,
 * because recency beats everything else when the model has to choose between an
 * instruction and its own habits.
 *
 * @param {object} [options]
 * @param {number | null} [options.messageIndex] - Message to illustrate. Defaults to the newest visible one.
 * @returns {Promise<BuiltContext>}
 * @throws {Error} When there is no chat, or nothing illustratable in it
 */
export async function buildPrompterContext({ messageIndex = null } = {}) {
    await ensureCardsLoaded();

    const context = ctx();
    const settings = getSettings();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    if (!chat.length) throw new Error("No chat is open.");

    const targetIndex = resolveTargetIndex(chat, messageIndex);
    if (targetIndex === -1) throw new Error("No message with text to illustrate.");

    const targetMessage = chat[targetIndex];
    const targetText = stripImages(targetMessage.mes);
    if (!targetText) throw new Error("The target message has no text to illustrate.");
    const targetName = targetMessage.name || (targetMessage.is_user ? "User" : "Character");

    /** @type {Section[]} */
    const sections = [];

    sections.push(...buildTaskSection(settings));
    sections.push(...buildAppearanceSection(settings));
    sections.push(...buildSessionSection());

    if (settings.prompter_include_card) {
        sections.push(...(context.groupId ? buildGroupCardSection() : buildSoloCardSection()));
    }
    if (settings.prompter_include_persona) sections.push(...buildPersonaSection());
    if (settings.prompter_include_author_note) sections.push(...buildAuthorNoteSection());
    if (settings.prompter_include_summary) sections.push(...buildSummarySection());

    sections.push(...(await buildWorldInfoSection(settings, targetIndex)));
    sections.push(...buildHistorySection(settings, targetIndex));

    sections.push({
        title: "TARGET MESSAGE (illustrate this one)",
        body: `${targetName}: ${targetText}`,
    });

    sections.push({
        title: "OUTPUT RULES",
        body: renderOutputRules(settings.prompter_max_images_per_message),
    });

    const systemPrompt = renderSections(sections);
    return {
        systemPrompt,
        sections,
        chars: systemPrompt.length,
        target: { index: targetIndex, name: targetName, text: targetText },
    };
}

/**
 * Rough token count for the preview. Falls back to a 4-chars-per-token estimate
 * when the tokenizer is unavailable. Preview only — nothing is budgeted by tokens.
 * @param {string} text
 * @returns {Promise<{count: number, estimated: boolean}>}
 */
export async function countTokens(text) {
    const context = ctx();
    try {
        if (typeof context.getTokenCountAsync === "function") {
            return { count: await context.getTokenCountAsync(text), estimated: false };
        }
    } catch (err) {
        debugLog("getTokenCountAsync failed", err);
    }
    return { count: Math.ceil(text.length / 4), estimated: true };
}
