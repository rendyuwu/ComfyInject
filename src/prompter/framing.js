// Frame direction rotation — one rolled framing directive per image slot.
//
// Left to itself the prompter picks its framing from the scene, so a scene that
// does not move gets the same framing turn after turn. The PREVIOUS IMAGES
// section makes that worse rather than better: it is the model's own last answer,
// quoted back. This module is the counterweight. A focus region and a manner are
// drawn from two user-written pools and stated to the model as a directive, one
// draw per image slot the request allows, so successive frames of a static scene
// differ by construction instead of by the model's inclination.
//
// Both pools ship empty and the feature is inert until at least one is filled.
// The vocabulary that suits a checkpoint is the user's to write, and a shipped
// list would be a shipped opinion about framing applied to every install.
//
// Selection is deterministic — a hash of the target message's send_date and the
// slot index, never Math.random(). Two callers depend on that:
//   - buildPrompterContext is rebuilt mid-flight when a backend refuses schema
//     mode, and the second build must ask for the same frames as the first.
//   - Preview Context promises byte-identical output to what the real request
//     sends, which a fresh draw on every build would quietly break.
// The same property is what lets the director re-derive the roll it recorded
// without threading it through the builder.
//
// The last roll is kept in chat metadata so the next one can avoid it. Frame
// rotation is per-chat state, not a setting: it means nothing outside the chat
// whose messages it was hashed from.

import { substituteTrimmed } from "../macros.js";
import { debugLog } from "./log.js";

// A chat-metadata key of its own, prefixed, exactly as the appearance registry's
// APPEARANCE_METADATA_KEY is. The alternative was a named sibling inside
// chatMetadata[MODULE_NAME], and it does happen to be safe today because every
// reader of that store looks up one send_date or one legacy index rather than
// enumerating it. But that store means "image metadata per message", a rotation
// roll is not that, and buying the shared namespace with a standing rule that all
// future code must skip a foreign key is a bad trade for one string.
export const FRAME_DIRECTIONS_KEY = "comfyinject_frame_directions";

// Mixed into the hash so focus and manner do not move in lockstep: with one salt
// a pool pair of equal length would advance together and the two fields would
// behave as one.
const FOCUS_SALT = "focus";
const MANNER_SALT = "manner";

// How to read the section. Not a setting, for the same reason REGISTRY_DISCIPLINE
// is not: it explains a section this extension generates. The last sentence is
// what makes a half-configured feature legible — with one pool filled, every line
// carries one field, and silence about the other has to read as "unconstrained"
// rather than as an omission the model should fill in.
const FRAME_DIRECTION_DISCIPLINE = [
    'One line per image slot this request allows; "image 1" is the first entry in',
    '"images". That slot\'s frame emphasises the named region and carries the named',
    "manner; how it gets there is yours to choose. An absent field is unconstrained.",
].join("\n");

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
 * The comparison key for two pool values: case and inner spacing are not a
 * difference. A pool re-typed as "Candid" is the same value the previous turn
 * used as "candid", and the exclusion has to agree with that or it stops
 * excluding the moment the user tidies their list.
 * @param {string} value
 * @returns {string}
 */
function poolKey(value) {
    return value.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Splits a pool setting into its values.
 *
 * Commas and newlines both separate, because a list long enough to want one per
 * line is exactly the list a user will paste in.
 *
 * @param {any} raw
 * @returns {string[]}
 */
export function parsePool(raw) {
    const seen = new Set();
    const values = [];

    for (const part of String(raw ?? "").split(/[,\n]/)) {
        const value = part.trim().replace(/\s+/g, " ");
        if (!value) continue;
        const key = poolKey(value);
        if (seen.has(key)) continue;
        seen.add(key);
        values.push(value);
    }
    return values;
}

/**
 * FNV-1a, 32-bit. Small, dependency-free and stable across reloads, which is all
 * that is asked of it — the hash decides a starting index in a list of a dozen
 * strings, so its distribution matters and its cryptographic properties do not.
 * @param {string} text
 * @returns {number}
 */
function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * Picks one value for a slot, avoiding the one that slot carried last turn.
 *
 * The hash fixes where the walk starts; `avoid` is what moves it. Advancing
 * forward with a wrap rather than re-hashing keeps the choice a pure function of
 * the message and the pool, and bounding the walk by the pool length means a pool
 * that somehow offers nothing else falls back to the hashed value instead of
 * spinning.
 *
 * @param {string[]} pool
 * @param {string} key - The message identity being hashed
 * @param {number} slot
 * @param {string} salt
 * @param {string} avoid - The value this slot used last turn, or ""
 * @returns {string}
 */
function pick(pool, key, slot, salt, avoid) {
    if (!pool.length) return "";

    const start = fnv1a(`${salt}:${key}:${slot}`) % pool.length;
    if (pool.length === 1 || !avoid) return pool[start];

    for (let step = 0; step < pool.length; step++) {
        const value = pool[(start + step) % pool.length];
        if (poolKey(value) !== poolKey(avoid)) return value;
    }
    return pool[start];
}

/**
 * What a slot was given last turn. Exclusion is per slot rather than across the
 * whole previous roll: slot 2 taking what slot 1 had is still a change for both
 * of them, and excluding every value the last turn used anywhere dead-ends a pool
 * no larger than the slot count.
 *
 * @param {Array<any>} previous
 * @param {number} slot
 * @returns {{focus: string, manner: string}}
 */
function previousForSlot(previous, slot) {
    if (!Array.isArray(previous)) return { focus: "", manner: "" };

    for (const entry of previous) {
        if (!entry || typeof entry !== "object") continue;
        if (Number(entry.slot) !== slot) continue;
        return { focus: trim(entry.focus), manner: trim(entry.manner) };
    }
    return { focus: "", manner: "" };
}

/**
 * Rolls one focus and one manner per slot.
 *
 * @param {object} options
 * @param {any} [options.sendDate] - The target message's send_date; the roll's identity
 * @param {number} [options.slots] - How many images this request allows
 * @param {string[]} [options.focusPool]
 * @param {string[]} [options.mannerPool]
 * @param {Array<any>} [options.previous] - The last recorded roll
 * @returns {Array<{slot: number, focus: string, manner: string}>}
 */
export function rollFrameDirections({ sendDate, slots, focusPool = [], mannerPool = [], previous = [] } = {}) {
    const count = Math.max(0, Math.floor(Number(slots) || 0));
    if (!count) return [];
    if (!focusPool.length && !mannerPool.length) return [];

    const key = String(sendDate ?? "");
    const directions = [];

    for (let slot = 0; slot < count; slot++) {
        const before = previousForSlot(previous, slot);
        directions.push({
            slot,
            focus: pick(focusPool, key, slot, FOCUS_SALT, before.focus),
            manner: pick(mannerPool, key, slot, MANNER_SALT, before.manner),
        });
    }
    return directions;
}

/**
 * The roll for one request: the gate, the pools and the previous turn's roll,
 * resolved from live state.
 *
 * Shared by the section builder and by the director's record step, which is the
 * only reason it is exported. The director records what was sent, and re-deriving
 * it is safe precisely because the roll is deterministic — nothing between the
 * build and the recording writes the send_date, the pools or the stored roll.
 *
 * @param {Record<string, any>} settings
 * @param {any} targetMessage - The message being illustrated
 * @param {number} slots - prompter_max_images_per_message
 * @returns {Array<{slot: number, focus: string, manner: string}>}
 */
export function frameDirectionsFor(settings, targetMessage, slots) {
    if (!settings?.prompter_frame_rotation_enabled) return [];

    const focusPool = parsePool(settings.prompter_frame_focus_pool);
    const mannerPool = parsePool(settings.prompter_frame_manner_pool);
    if (!focusPool.length && !mannerPool.length) return [];

    return rollFrameDirections({
        sendDate: targetMessage?.send_date,
        slots,
        focusPool,
        mannerPool,
        previous: readPreviousFrameDirections(),
    });
}

/**
 * The roll as a prompt section, or nothing at all when the feature is off, the
 * pools are empty or no slot is allowed.
 *
 * Values are macro-substituted here rather than at parse time, following the
 * render-time rule: these are editable strings being placed into their section,
 * and the roll itself is over the raw text so an expansion cannot change which
 * value a slot gets.
 *
 * @param {Record<string, any>} settings
 * @param {any} targetMessage
 * @param {number} slots
 * @returns {Array<{title: string, body: string}>}
 */
export function buildFrameDirectionSection(settings, targetMessage, slots) {
    const directions = frameDirectionsFor(settings, targetMessage, slots);
    if (!directions.length) return [];

    const lines = [];
    for (const direction of directions) {
        const parts = [];
        const focus = substituteTrimmed(direction.focus);
        const manner = substituteTrimmed(direction.manner);
        if (focus) parts.push(`focus: ${focus}`);
        if (manner) parts.push(`manner: ${manner}`);
        if (!parts.length) continue;
        lines.push(`image ${direction.slot + 1} — ${parts.join("; ")}`);
    }
    if (!lines.length) return [];

    return [{
        title: "FRAME DIRECTION",
        body: [FRAME_DIRECTION_DISCIPLINE, ...lines].join("\n"),
    }];
}

/**
 * The last recorded roll, or an empty array when this chat has none.
 * @returns {Array<{slot: number, focus: string, manner: string}>}
 */
export function readPreviousFrameDirections() {
    const stored = ctx().chatMetadata?.[FRAME_DIRECTIONS_KEY];
    if (!Array.isArray(stored)) return [];

    const out = [];
    for (const entry of stored) {
        if (!entry || typeof entry !== "object") continue;
        const slot = Math.floor(Number(entry.slot));
        if (!Number.isFinite(slot) || slot < 0) continue;
        out.push({ slot, focus: trim(entry.focus), manner: trim(entry.manner) });
    }
    return out;
}

/**
 * Records the roll a request actually drew frames from, replacing the previous
 * one — only the most recent turn is an exclusion.
 *
 * The caller decides when this is earned. A roll recorded by a run that produced
 * no image would spend the rotation on a frame nobody ever saw, and the next turn
 * would then skip the very values that never reached ComfyUI.
 *
 * @param {Array<{slot: number, focus: string, manner: string}>} directions
 */
export function recordFrameDirections(directions) {
    if (!Array.isArray(directions) || !directions.length) return;

    const context = ctx();
    const metadata = context.chatMetadata;
    if (!metadata) return;

    metadata[FRAME_DIRECTIONS_KEY] = directions.map(direction => ({
        slot: Math.max(0, Math.floor(Number(direction.slot) || 0)),
        focus: trim(direction.focus),
        manner: trim(direction.manner),
    }));

    if (typeof context.saveMetadataDebounced === "function") context.saveMetadataDebounced();
    else if (typeof context.saveMetadata === "function") context.saveMetadata();

    debugLog("frame direction rotation recorded", directions);
}
