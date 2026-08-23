// Assembles the dedicated prompter's system prompt from live SillyTavern state:
// character card(s), persona, author's note, running summary, world info,
// the appearance registry, recent history and the message being illustrated.
//
// Everything is read through SillyTavern.getContext() — no static imports from
// core — and every optional call is probed with typeof so an older or newer
// SillyTavern degrades to a smaller prompt instead of throwing.

import { MODULE_NAME } from "../../settings.js";
import { parseImageTags, replaceImageTags } from "../imgtag.js";
import { substituteTrimmed } from "../macros.js";
import { getImageData } from "../state.js";
import { appearanceSectionIsVolatile, buildAppearanceSection } from "./appearance.js";
import { debugLog } from "./log.js";
import { schemaBelongsInPrompt } from "./llm.js";
import { renderOutputRules } from "./schema.js";
import { ensureCardsLoaded, getGroupName, listCastMembers, renderSections } from "./sources.js";
import { parseTagList, stripBannedTags } from "./tags.js";

// Image markers are stripped from anything the prompter sees, along with the
// <img> tags themselves (via replaceImageTags). Leaving them in teaches it to
// imitate the marker syntax it is meant to replace, and burns tokens on
// base64-free but very long tag soup.
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
    return replaceImageTags(text, () => "")
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

/**
 * Standing rules about the renderer rather than about the story.
 *
 * Placed in the stable block right after TASK, which is the whole reason this is a
 * field and not advice to edit TASK: these statements outlive character cards,
 * chats and policy switches, and a long block of them in FINAL INSTRUCTIONS would
 * be re-sent at the volatile block's full price on every single message.
 * @returns {Section[]}
 */
function buildConstraintsSection(settings) {
    const body = substituteTrimmed(settings.prompter_constraints);
    return body ? [{ title: "CONSTRAINTS", body }] : [];
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
 * Where the history window starts.
 *
 * Sliding the window by one every turn changes the rendered history at its head
 * as well as its tail, so even inside the volatile block the whole thing is new
 * text every request. Anchoring holds the start still at a multiple of the stride
 * and only moves it when the window would otherwise exceed the message count, so
 * between jumps the rendered history is append-only: this turn's text is a prefix
 * of the next turn's.
 *
 * @param {number} total - Visible messages before the target
 * @param {number} count - prompter_history_count
 * @param {number} stride - prompter_history_anchor; 0 slides
 * @returns {number}
 */
function historyWindowStart(total, count, stride) {
    const earliest = Math.max(0, total - count);
    if (stride <= 0) return earliest;

    // A stride wider than the window cannot buy a longer hold — the window would
    // have to jump every `count` messages regardless — and left unclamped it can
    // push the anchor past the end of the chat and render no history at all.
    const step = Math.min(stride, count);

    // Ceil, not floor: the anchor has to be at or after the earliest start the
    // count allows, or the window would grow past prompter_history_count. The
    // result therefore lands in [earliest, earliest + step - 1], so the window is
    // between count - step + 1 and count messages long — the price of holding it
    // still, and the reason a stride near the count is a poor choice.
    return Math.ceil(earliest / step) * step;
}

/**
 * The messages leading up to the target, so the prompter can resolve pronouns and
 * knows where the scene is. The target itself is rendered separately.
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
    const stride = Math.max(0, Math.floor(Number(settings.prompter_history_anchor) || 0));
    const slice = visible.slice(historyWindowStart(visible.length, count, stride));

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

// The largest value prompter_previous_image_count is allowed to take. Three lines
// of tags is already the point where a model starts treating them as a template
// rather than as state.
const MAX_PREVIOUS_IMAGES = 3;

/**
 * How to read the PREVIOUS IMAGES section.
 *
 * Not editable, for the same reason REGISTRY_DISCIPLINE is not: it is an
 * instruction about how to read a section this extension generates, not a
 * statement about what the user wants drawn. The user's own wording for wardrobe
 * carry-over belongs in CONSTRAINTS or FINAL INSTRUCTIONS.
 *
 * The three sentences each do a job. "Not a template to copy" is the mitigation
 * for the section's one real risk. Naming clothing, clothing state, accessories and
 * injuries is what makes it about state rather than identity. The last sentence
 * settles the precedence question the three continuity channels would otherwise
 * leave open.
 *
 * @param {number} count - How many image lines follow
 * @returns {string}
 */
function previousImagesDiscipline(count) {
    return [
        `The last image${count === 1 ? "" : "s"} generated in this chat, newest first. This is the state`,
        "the scene was left in, not a template to copy: carry over clothing, clothing state,",
        "accessories and injuries the story has not since changed, and vary the framing",
        "rather than repeating it. APPEARANCE REGISTRY governs who a character is; this",
        "section governs what has happened to her; the story overrides both.",
    ].join("\n");
}

/**
 * Whether a metadata entry may be trusted to describe a given <img> tag.
 *
 * The pairing is positional — entry N describes tag N — and that is all the
 * codebase has: metadata is keyed by send_date, so it does not follow a swipe, and
 * the marker path replaces a message's entries wholesale.
 *
 * Two tiers, because the seed check on its own would never pass. gallery.js:62
 * guards with `meta.seed === seed`, but neither generation path writes a seed into
 * its metadata entry — the <img> tag's data-seed is the source of truth (§11.1) —
 * so only a *retried* image has one to compare. Falling back to a count match is
 * what keeps the shot label from being permanently absent on fresh images. The
 * residual hole is a swipe-back, where the counts can match while the entries
 * describe the other swipe; that costs a stale shot label on an anti-repetition
 * hint, never a wrong prompt.
 *
 * @param {any} meta - The positionally matching metadata entry, if any
 * @param {number | null} seed - The seed read from the tag
 * @param {number} entryCount
 * @param {number} tagCount
 * @returns {boolean}
 */
function metadataDescribesTag(meta, seed, entryCount, tagCount) {
    if (!meta || typeof meta !== "object") return false;
    if (Number.isFinite(meta.seed)) return meta.seed === seed;
    return entryCount === tagCount;
}

/**
 * What the last few images actually showed, quoted back as tags.
 *
 * The prompter is structurally blind to its own previous output: stripImages()
 * removes every <img> tag from the history window, from the world info scan and
 * from the target message, and that strip is correct — leaving the tags in teaches
 * it to imitate the marker syntax the dedicated path exists to replace. The
 * consequence is what this section fixes. The one artifact recording exactly what
 * the last picture showed is its data-prompt, and until now it was the one thing
 * the prompter never saw. Meanwhile the main roleplay model has had this channel
 * since before the dedicated path existed (outbound.js), so this is a regression
 * against marker mode being closed, not a new capability.
 *
 * Four things this has to get right:
 *  - Walk back from targetIndex - 1, never including the target. On a manual re-run
 *    of a message that already has an image, including it would hand the model the
 *    prompt it is being asked to replace. getLastSavedSeed() sets the same
 *    convention for LOCK.
 *  - Read message.mes, not the swipes array: mes is whatever the current swipe
 *    holds, so reading it is automatically swipe-correct.
 *  - Strip banned tags on the way in. Every quoted prompt has already been through
 *    validateDirective — except in both mode, where a marker-path prompt was
 *    written by the roleplay model and never validated at all. A banned tag in text
 *    the prompter reads becomes a banned tag in text the prompter writes, and the
 *    validator only catches the second one.
 *  - No macro substitution. These are generated strings, and item K's rule is that
 *    editable strings are substituted and generated text is not.
 *
 * @param {Record<string, any>} settings
 * @param {number} targetIndex
 * @returns {Section[]}
 */
function buildPreviousImagesSection(settings, targetIndex) {
    const requested = Math.floor(Number(settings.prompter_previous_image_count) || 0);
    const count = Math.min(MAX_PREVIOUS_IMAGES, Math.max(0, requested));
    if (!count) return [];

    const context = ctx();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const store = context.chatMetadata?.[MODULE_NAME] || {};
    const banned = parseTagList(settings.prompter_banned_tags).fingerprints;

    /** @type {string[]} */
    const lines = [];

    for (let i = targetIndex - 1; i >= 0 && lines.length < count; i--) {
        const message = chat[i];
        if (!message) continue;

        const tags = parseImageTags(message.mes);
        if (!tags.length) continue;

        // Legacy chats key metadata by array index instead of send_date.
        const bySendDate = message.send_date ? getImageData(store, message.send_date) : [];
        const entries = bySendDate.length > 0 ? bySendDate : getImageData(store, i);

        // Newest first within a message too, so a message holding two images
        // reports the later one first.
        for (let n = tags.length - 1; n >= 0 && lines.length < count; n--) {
            const { prompt, seed } = tags[n];
            const stripped = stripBannedTags(prompt, banned).prompt.trim();
            if (!stripped) continue;

            const distance = targetIndex - i;
            const parts = [`${distance} message${distance === 1 ? "" : "s"} ago`];

            const meta = entries[n];
            if (metadataDescribesTag(meta, seed, entries.length, tags.length)) {
                // effectiveShot over shot: the shot lock may have overridden what
                // the model asked for, and this section describes what was drawn.
                const shot = trim(meta.effectiveShot) || trim(meta.shot);
                if (shot) parts.push(`shot ${shot}`);

                const who = Array.isArray(meta.characters)
                    ? meta.characters.map(trim).filter(Boolean).join(", ")
                    : "";
                if (who) parts.push(who);
            }

            lines.push(`- ${parts.join(", ")}: ${stripped}`);
        }
    }

    if (!lines.length) return [];

    return [{
        title: `PREVIOUS IMAGE${lines.length === 1 ? "" : "S"}`,
        body: [previousImagesDiscipline(lines.length), "", ...lines].join("\n"),
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
 * @param {"native" | "json" | null} [options.structuredMode] - Forces whether OUTPUT RULES restates the schema. Used by the rebuild on a mid-flight refusal.
 * @returns {Promise<BuiltContext>}
 * @throws {Error} When there is no chat, or nothing illustratable in it
 */
export async function buildPrompterContext({ messageIndex = null, structuredMode = null } = {}) {
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

    // Both built before the registry section, because scoping the registry to who
    // is in frame needs to know what the model is actually going to read. A
    // character in the last image is in frame by any reasonable reading, so the
    // previous-image body counts as frame text too.
    const historySections = buildHistorySection(settings, targetIndex);
    const previousImageSections = buildPreviousImagesSection(settings, targetIndex);
    const appearanceSections = buildAppearanceSection(settings, {
        targetText,
        historyText: [...historySections, ...previousImageSections]
            .map(section => section.body)
            .join("\n\n"),
    });
    const registryIsVolatile = appearanceSectionIsVolatile(settings);
    if (registryIsVolatile && appearanceSections.length) {
        debugLog("appearance registry is in the volatile block: scope is \"present\", so it depends on the target message and cannot be cached");
    }

    stable.push(...buildTaskSection(settings));
    stable.push(...buildConstraintsSection(settings));
    if (!registryIsVolatile) stable.push(...appearanceSections);
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
            maxTags: settings.prompter_max_tags,
            bannedTags: settings.prompter_banned_tags,
            includeSchema: schemaBelongsInPrompt(structuredMode),
        }),
    });

    if (registryIsVolatile) volatileSections.push(...appearanceSections);
    if (settings.prompter_include_summary) volatileSections.push(...buildSummarySection());
    volatileSections.push(...(await buildWorldInfoSection(settings, targetIndex)));
    volatileSections.push(...historySections);

    // After the history, before the target — a decision, not a default. Last is the
    // strongest position and is exactly wrong here: the failure mode of this
    // section is the model copying the previous prompt instead of updating it, and
    // recency is what would make copying more likely. History, then what the last
    // frame showed, then the message to illustrate, then the ask. The target stays
    // adjacent to the ask, which is where the model's attention belongs.
    volatileSections.push(...previousImageSections);

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
