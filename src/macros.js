// SillyTavern macro expansion for the strings ComfyInject owns.
//
// Core resolves {{char}}, {{user}} and friends for text it assembles itself —
// getCharacterCardFields() comes back already substituted. Nothing ComfyInject
// stores goes through that path, so without this helper every macro a user types
// into a prompter field or into Prepend Prompt reaches the model as the literal
// string "{{char}}".
//
// Two rules, both load-bearing:
//
//   1. Substitute at render time, never at save time. A field substituted on save
//      would be frozen to whatever the macros meant when it was typed.
//   2. Substitute each editable string as it is placed into its section, never the
//      assembled prompt. World info, history and the target message are already
//      resolved by core, and roleplay text may legitimately contain braces the
//      user wrote in character.

/**
 * Expands SillyTavern macros in one string.
 *
 * Degrades to the raw string when the core function is missing, so an older or
 * newer SillyTavern loses macro support rather than throwing.
 *
 * Note this is not only names: {{random}}, {{pick}}, {{roll}} and {{time}} expand
 * too, so a macro of that kind in a per-request field re-rolls on every request.
 *
 * @param {any} text
 * @returns {string}
 */
export function substituteMacros(text) {
    const raw = typeof text === "string" ? text : "";
    if (!raw || !raw.includes("{{")) return raw;

    try {
        const context = SillyTavern.getContext();
        if (typeof context.substituteParams === "function") {
            const out = context.substituteParams(raw);
            return typeof out === "string" ? out : raw;
        }
    } catch (err) {
        console.warn("[ComfyInject] substituteParams failed, using the raw text", err);
    }
    return raw;
}

/**
 * substituteMacros() over a trimmed string, which is what every settings read in
 * the prompter path wants.
 * @param {any} text
 * @returns {string}
 */
export function substituteTrimmed(text) {
    return substituteMacros(typeof text === "string" ? text.trim() : "");
}
