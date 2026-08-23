// Assembles the dedicated prompter's system prompt from live SillyTavern state:
// character card(s), persona, author's note, running summary, world info,
// the appearance registry, recent history and the message being illustrated.
//
// Everything is read through SillyTavern.getContext() — no static imports from
// core — and every optional call is probed with typeof so an older or newer
// SillyTavern degrades to a smaller prompt instead of throwing.

import { MODULE_NAME } from "../../settings.js";
import { substituteTrimmed } from "../macros.js";
import { buildAppearanceSection } from "./appearance.js";
import { debugLog } from "./log.js";
import { renderOutputRules } from "./schema.js";
import { ensureCardsLoaded, getGroupName, listCastMembers, renderSections } from "./sources.js";

// Image markers and already-generated <img> tags are stripped from anything the
// prompter sees. Leaving them in teaches it to imitate the marker syntax it is
// meant to replace, and burns tokens on base64-free but very long tag soup.
// SillyTavern's sanitizer prefixes the class with "custom-" in the rendered DOM
// while `mes` keeps the bare class, so both are matched.
const IMG_TAG_REGEX = /<img class="(?:custom-)?comfyinject-image"[^>]*>/g;
const MARKER_REGEX = /\[\[IMG:\s*(.+?)\s*\]\]/gs;

/**
 * @typedef {{ title: string, body: string }} Section
 * @typedef {{ role: string, content: string }} Message
 * @typedef {{ messages: Message[], stable: Section[], volatile: Section[], sections: Section[], systemPrompt: string, volatilePrompt: string, chars: number, target: { index: number, name: string, text: string } }} BuiltContext
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
 *
 * Macros are expanded here rather than over the finished prompt: world info,
 * history and the target message are already resolved by core, and roleplay text
 * may legitimately contain braces the user wrote in character.
 * @returns {Section[]}
 */
function buildTaskSection(settings) {
    const body = substituteTrimmed(settings.prompter_system_prompt);
    return body ? [{ title: "TASK", body }] : [];
}

/** @returns {Section[]} */
function buildSessionSection() {
    const context = ctx();
    const characterName = getGroupName()
        || context.characters?.[context.characterId]?.name
        || "(no character)";

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
    const [member] = listCastMembers();
    if (!member) return [];

    const parts = [`Name: ${member.name}`];
    if (member.description) parts.push(`### Description\n${member.description}`);
    if (member.personality) parts.push(`### Personality\n${member.personality}`);
    if (member.scenario) parts.push(`### Scenario\n${member.scenario}`);
    if (member.depthPrompt) parts.push(`### Always-on note (depth prompt)\n${member.depthPrompt}`);

    return [{ title: "CHARACTER CARD", body: parts.join("\n\n") }];
}

/**
 * One short block per group member. A group of eight full cards would drown
 * everything else, and for a tagging task only the appearance-bearing fields
 * matter.
 * @returns {Section[]}
 */
function buildGroupCardSection() {
    const members = listCastMembers();
    if (!members.length) return [];

    const blocks = members.map(member => {
        const parts = [`### ${member.name}`];
        if (member.description) parts.push(member.description);
        if (member.personality) parts.push(`Personality: ${member.personality}`);
        return parts.join("\n");
    });

    return [{
        title: `GROUP CAST — ${getGroupName() || "Group"} (${members.length} members)`,
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

export { renderSections };

/**
 * Builds the prompter's request as two messages.
 *
 * The split is on the static/volatile line, and it is a cost decision as much as
 * a stylistic one. Everything that does not change from message to message —
 * role, cast, persona, output contract — goes in the system message, so a backend
 * that caches prompt prefixes can actually read that cache back. Everything that
 * changes every turn goes in the user message, where it belongs anyway: the
 * conventional shape is instructions in the system message, material in the user
 * message, and that is what most backends are tuned for.
 *
 * Section order within each block still follows the one rule: reference data
 * first, standing orders last. FINAL INSTRUCTIONS remains the last thing the
 * model reads before the ask.
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
    const stable = [];
    /** @type {Section[]} */
    const volatileSections = [];

    stable.push(...buildTaskSection(settings));
    stable.push(...buildAppearanceSection(settings));
    stable.push(...buildSessionSection());

    if (settings.prompter_include_card) {
        stable.push(...(context.groupId ? buildGroupCardSection() : buildSoloCardSection()));
    }
    if (settings.prompter_include_persona) stable.push(...buildPersonaSection());
    if (settings.prompter_include_author_note) stable.push(...buildAuthorNoteSection());

    stable.push({
        title: "OUTPUT RULES",
        body: renderOutputRules({
            maxImages: settings.prompter_max_images_per_message,
            // Read live rather than captured at module load, so an edited example
            // takes effect on the next request instead of the next page reload.
            examplePrompt: substituteTrimmed(settings.prompter_example_prompt),
        }),
    });

    if (settings.prompter_include_summary) volatileSections.push(...buildSummarySection());
    volatileSections.push(...(await buildWorldInfoSection(settings, targetIndex)));
    volatileSections.push(...buildHistorySection(settings, targetIndex));

    volatileSections.push({
        title: "TARGET MESSAGE (illustrate this one)",
        body: `${targetName}: ${targetText}`,
    });

    // Last, deliberately. This is the only section the user fully owns, and the
    // position is the point: a rule stated here is the last thing the model reads
    // before the ask, and therefore beats a contradicting rule in TASK. Omitted
    // when empty, so a user who never touches it sees no change at all.
    const finalInstructions = substituteTrimmed(settings.prompter_final_instructions);
    if (finalInstructions) {
        volatileSections.push({ title: "FINAL INSTRUCTIONS", body: finalInstructions });
    }

    const systemPrompt = renderSections(stable);
    const volatilePrompt = renderSections(volatileSections);

    return {
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: volatilePrompt },
        ],
        stable,
        volatile: volatileSections,
        // The concatenation, so the preview and anything else that just wants
        // "every section in order" keeps working.
        sections: [...stable, ...volatileSections],
        systemPrompt,
        volatilePrompt,
        chars: systemPrompt.length + volatilePrompt.length,
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
