// The prompter's output contract.
//
// One schema, used three ways:
//   - as a backend-enforced JSON schema (native structured output)
//   - as prompt text, when the backend refuses schemas
//   - as the validator the parsed reply has to survive before it reaches ComfyUI
//
// The AR and SHOT enums are derived from the marker parser's Sets so the two
// paths can never drift apart.

import { VALID_AR, VALID_SHOT, DEFAULT_AR, DEFAULT_SHOT } from "../parse.js";
import { DEFAULT_PROMPTER_EXAMPLE_PROMPT } from "../../settings.js";
import { parseTagList, stripBannedTags, tagFingerprint } from "./tags.js";

// Schema name sent to the backend. Some providers surface it in errors.
export const SCHEMA_NAME = "ComfyInjectDirective";

// fillWorkflow() substitutes the prompt into serialized workflow JSON, so an
// unbounded prompt is a real hazard rather than just a waste of tokens.
export const MAX_PROMPT_CHARS = 2000;

// How much of the banned list is recited in OUTPUT RULES. The asymmetry with
// enforcement is the point: the stated form costs prompt tokens on every single
// request, the enforced form costs a Set lookup. Someone with a hundred banned
// tags should pay for the enforcement, not for the recital.
export const MAX_STATED_BANNED_CHARS = 400;

// A LoRA, LyCORIS, hypernetwork or embedding call in prompt-syntax form:
// `<lora:character_style:0.7>`. Angle-bracketed and with no nesting, so unlike the
// `<img>` tag regex in imgtag.js this needs no quote awareness — the only thing
// that can appear between the brackets is the call itself.
const LORA_CALL_REGEX = /<(?:lora|lyco|lycoris|hypernet|embedding):[^<>]+>/gi;

/**
 * Every LoRA-style call in a string, in the order they appear.
 * @param {any} text
 * @returns {string[]}
 */
export function extractLoraCalls(text) {
    return String(text ?? "").match(LORA_CALL_REGEX) || [];
}

/**
 * The registry tag a LoRA call renders, or "" when it renders no single tag.
 *
 * A call names what it draws: `<lora:pubic_hair:1.0>` is the pubic hair one. When
 * the entry that pinned it also carries that tag, the call belongs to the tag
 * rather than to the character, and a frame the tag is out of is a frame the call
 * is out of too — which is what lets validateDirective decline to re-insert it.
 * A character LoRA (`<lora:aiko_v2:0.8>`) matches no tag in the entry, comes back
 * "", and keeps the unconditional guarantee it needs.
 *
 * Matched on whole words in the call's own name, longest tag winning, so `ass`
 * cannot anchor itself to `classic_dress` and `hair` cannot outrank `pubic hair`.
 *
 * @param {string} call - One LoRA-style call, as extractLoraCalls returns it
 * @param {Iterable<string>} candidateTags - The tags of the entry that pinned it
 * @returns {string} The anchor tag's fingerprint, or "" if it has none
 */
export function loraAnchorTag(call, candidateTags) {
    const name = String(call ?? "").match(/^<[^:<>]+:([^:<>]+)/)?.[1] ?? "";
    const fingerprint = tagFingerprint(name);
    if (!fingerprint) return "";

    const haystack = ` ${fingerprint} `;
    let best = "";
    for (const tag of candidateTags) {
        // Skips the call itself, which arrives in this list as one of the tags.
        if (String(tag ?? "").includes("<")) continue;
        const candidate = tagFingerprint(tag);
        if (!candidate || candidate.length <= best.length) continue;
        if (haystack.includes(` ${candidate} `)) best = candidate;
    }
    return best;
}

/**
 * Builds the directive schema from the live token Sets.
 * @returns {object} A JSON Schema describing one prompter reply
 */
export function buildDirectiveSchema() {
    return {
        type: "object",
        additionalProperties: false,
        required: ["generate", "reason", "images"],
        properties: {
            generate: {
                type: "boolean",
                description: "True to illustrate the target message, false to skip it.",
            },
            reason: {
                type: "string",
                description: "One short clause: why generate, or why skip.",
            },
            images: {
                type: "array",
                description: "The images to generate. Empty when generate is false.",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["prompt", "ar", "shot", "characters"],
                    properties: {
                        prompt: {
                            type: "string",
                            description: "Booru-style comma-separated tags, most important first.",
                        },
                        ar: {
                            type: "string",
                            enum: [...VALID_AR],
                            description: "Aspect ratio token.",
                        },
                        shot: {
                            type: "string",
                            enum: [...VALID_SHOT],
                            description: "Camera framing token.",
                        },
                        characters: {
                            type: "array",
                            items: { type: "string" },
                            description: "Names of the characters visible in this image.",
                        },
                    },
                },
            },
        },
    };
}

// Built once at load. The token Sets are module constants, so this cannot go stale.
export const DIRECTIVE_SCHEMA = buildDirectiveSchema();

/**
 * Recursively forces `additionalProperties: false` and a full `required` list on
 * every object in the schema, which is what strict structured-output modes demand.
 * @param {any} schema
 * @returns {any}
 */
export function toStrictJsonSchema(schema) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;

    const strict = structuredClone(schema);
    if (strict.type === "object" && strict.properties) {
        strict.additionalProperties = false;
        strict.required = Object.keys(strict.properties);
        for (const key of Object.keys(strict.properties)) {
            strict.properties[key] = toStrictJsonSchema(strict.properties[key]);
        }
    }
    if (strict.type === "array" && strict.items) {
        strict.items = toStrictJsonSchema(strict.items);
    }
    return strict;
}

/**
 * The banned-tag rule as one line of OUTPUT RULES, or nothing when the list is
 * empty.
 *
 * Stating it is the cheap complement to enforcing it, not a substitute: §20.4's
 * argument applies with extra force here, since models follow "do not write X"
 * far less reliably than "write Y". The line is what covers a model writing the
 * banned idea as prose; the validator covers the common case.
 *
 * @param {any} bannedTags - Comma-separated string, or an array of tags
 * @returns {string[]} Zero or one line
 */
function renderBannedTagsLine(bannedTags) {
    const { tags } = parseTagList(bannedTags);
    if (!tags.length) return [];

    const listed = [];
    let used = 0;
    for (const tag of tags) {
        const next = used ? used + 2 + tag.length : tag.length;
        // At least one tag is always recited, however long it is — a line that
        // names nothing would just be noise.
        if (listed.length && next > MAX_STATED_BANNED_CHARS) break;
        listed.push(tag);
        used = next;
    }

    const rest = tags.length - listed.length;
    const list = rest ? `${listed.join(", ")}, and ${rest} more not listed here` : listed.join(", ");
    return [`- "prompt" must not contain any of these tags: ${list}. They are removed if present.`];
}

/**
 * The OUTPUT RULES section body: the schema, a filled example, and the hard
 * constraints the validator enforces anyway. Sent in both structured modes —
 * native enforcement can be refused mid-request, and this is what makes the
 * degraded request work without rebuilding the prompt.
 *
 * The example prompt is a parameter rather than a constant so an edited setting
 * takes effect on the next request instead of on the next page reload. This
 * module deliberately has no ctx() accessor: it is the one the node smoke tests
 * exercise without a mocked SillyTavern, and that is worth keeping.
 *
 * @param {object} [options]
 * @param {number} [options.maxImages=1]
 * @param {string} [options.examplePrompt] - The example reply's `prompt` string
 * @param {number} [options.maxTags=0] - Tag cap to state; 0 states nothing
 * @param {any} [options.bannedTags] - Banned tags to recite; empty states nothing
 * @param {boolean} [options.includeSchema=true] - Restate the schema JSON in the prompt
 * @param {boolean} [options.allowRegistryLora=false] - Permit LoRA calls copied from the registry
 * @returns {string}
 */
export function renderOutputRules({ maxImages = 1, examplePrompt = "", maxTags = 0, bannedTags = "", includeSchema = true, allowRegistryLora = false } = {}) {
    const cap = Math.max(1, Number(maxImages) || 1);
    const tagCap = Math.max(0, Math.floor(Number(maxTags) || 0));
    const example = {
        generate: true,
        reason: "New scene, character just stepped into the rain.",
        images: [{
            prompt: String(examplePrompt || "").trim() || DEFAULT_PROMPTER_EXAMPLE_PROMPT,
            ar: DEFAULT_AR,
            shot: DEFAULT_SHOT,
            characters: ["Character name"],
        }],
    };

    return [
        "Return exactly one JSON object and nothing else. No prose before or after it, no code fence.",
        // About 1,900 characters. Redundant while the backend is enforcing the
        // schema itself, and on a small local model it is 1,900 characters of
        // noise competing with the instructions — worst exactly where the feature
        // is needed most. The prose rules and the worked example always stay: the
        // example is the highest-leverage part and costs a tenth as much.
        ...(includeSchema ? ["", "Schema:", JSON.stringify(DIRECTIVE_SCHEMA, null, 2)] : []),
        "",
        "Example of a filled reply:",
        JSON.stringify(example, null, 2),
        "",
        "Hard rules:",
        `- "generate" is a boolean. When it is false, "images" must be an empty array.`,
        `- "reason" is always required, generate or skip.`,
        `- At most ${cap} image${cap === 1 ? "" : "s"} per message. Extra entries are discarded.`,
        `- "ar" must be one of: ${[...VALID_AR].join(", ")}.`,
        `- "shot" must be one of: ${[...VALID_SHOT].join(", ")}.`,
        `- "prompt" is capped at ${MAX_PROMPT_CHARS} characters.`,
        // Contract, not taste, so it lives here rather than in TASK. A user is
        // invited to rewrite TASK wholesale; a user who does that must not thereby
        // stop telling the model that LoRA calls and attention weights are
        // forbidden, because that string goes straight into the workflow JSON
        // fillWorkflow substitutes into.
        //
        // The one carve-out is a LoRA call the appearance registry already holds.
        // A checkpoint that renders some feature badly needs the same call pinned
        // to the same character in every image, which is exactly what the registry
        // is for — so the setting relaxes the clause to "copied, never invented"
        // rather than deleting it. Inventing one is still forbidden either way,
        // and validateDirective re-inserts a registry call the model drops, so the
        // permission does not depend on the model honouring this line.
        allowRegistryLora
            ? `- "prompt" contains no seeds, no attention weights, no negative-prompt content and no {{macros}}. The only LoRA or embedding calls allowed are ones copied verbatim from APPEARANCE REGISTRY for a character in that image — never invent one, never change its weight. Negative prompt, prefix and suffix tags are added by the extension.`
            : `- "prompt" contains no seeds, no attention weights, no LoRA or embedding calls, no negative-prompt content and no {{macros}}. Negative prompt, prefix and suffix tags are added by the extension.`,
        // Stated as well as enforced. The cap is enforced in validateDirective
        // because a small model follows instructions poorly — but a silent cap
        // keeps the first N tags, and "most important first" is a convention, not
        // a guarantee. A model that ignores instructions is exactly the model that
        // will bury the setting at tag 22. No line at all when the cap is off.
        ...(tagCap
            ? [`- "prompt" must contain at most ${tagCap} comma-separated tags, most important first. Extra tags are discarded.`]
            : []),
        ...renderBannedTagsLine(bannedTags),
        `- "characters" lists the names of the characters visible in that image.`,
    ].join("\n");
}

/**
 * Parses the model's reply into an object.
 *
 * Deliberately not a salvage cascade — the whole point of the dedicated path is
 * that structured output removes the need for one. Two deterministic cleanups
 * only: strip a code fence, then take the outermost braces. Anything else fails.
 *
 * @param {string | object} raw
 * @returns {object} The parsed reply
 * @throws {Error} When the reply is not usable JSON
 */
export function parseDirective(raw) {
    // Native structured output can hand back an already-parsed object.
    if (raw && typeof raw === "object") return raw;

    const text = String(raw ?? "").trim();
    if (!text) throw new Error("The prompter returned an empty response.");

    const fence = text.match(/```(?:\w+)?\s*\n?([\s\S]*?)```/);
    const unfenced = (fence ? fence[1] : text).trim();

    try {
        return JSON.parse(unfenced);
    } catch (err) {
        const start = unfenced.indexOf("{");
        const end = unfenced.lastIndexOf("}");
        if (start !== -1 && end > start) {
            try {
                return JSON.parse(unfenced.slice(start, end + 1));
            } catch (innerErr) {
                throw new Error(`The prompter's reply is not valid JSON: ${innerErr.message}`);
            }
        }
        throw new Error(`The prompter's reply is not valid JSON: ${err.message}`);
    }
}

/**
 * Truncates a comma-separated tag list to `maxTags` tags, never mid-tag.
 * @param {string} prompt
 * @param {number} maxTags - 0 disables the cap
 * @returns {{prompt: string, dropped: number, kept: number}}
 */
function capTags(prompt, maxTags) {
    const limit = Math.max(0, Math.floor(Number(maxTags) || 0));
    if (!limit) return { prompt, dropped: 0, kept: 0 };

    const tags = prompt.split(",").map(tag => tag.trim()).filter(Boolean);
    if (tags.length <= limit) return { prompt: tags.join(", "), dropped: 0, kept: tags.length };

    return { prompt: tags.slice(0, limit).join(", "), dropped: tags.length - limit, kept: limit };
}

/**
 * A prompt with one LoRA call put in beside the tag it renders.
 *
 * An anchorless call goes last, which is where an unconditional guarantee has to
 * go — there is no tag for it to sit beside. An anchored one goes immediately
 * after its anchor, so it lands in the anatomy block PROMPT SHAPE puts it in
 * rather than trailing the setting tags at the weight of a footnote.
 *
 * @param {string} prompt
 * @param {string} call
 * @param {string} anchor - Fingerprint of the tag this call renders, or ""
 * @returns {string|null} null when the anchor tag is not in this prompt
 */
function withLoraCall(prompt, call, anchor) {
    const tags = String(prompt).split(",").map(tag => tag.trim()).filter(Boolean);
    if (!anchor) return [...tags, call].join(", ");

    // The anchor may arrive inside a longer tag: an entry carrying both `pubic
    // hair` and `excessive pubic hair` licenses the call from either, and a frame
    // that kept only the rung tag still renders the anatomy. Whole words only, so
    // `ass` is not anchored by `classic dress`. The call goes after the last
    // member of that group, which is the order the registry entry itself uses.
    let at = -1;
    for (let i = 0; i < tags.length; i++) {
        if (` ${tagFingerprint(tags[i])} `.includes(` ${anchor} `)) at = i;
    }
    if (at < 0) return null;

    tags.splice(at + 1, 0, call);
    return tags.join(", ");
}

/**
 * Validates and clamps a parsed reply into something safe to hand to ComfyUI.
 *
 * Fails closed: anything ambiguous becomes a skip rather than a guess.
 *
 * @param {any} parsed - Output of parseDirective
 * @param {object} [options]
 * @param {number} [options.maxImages=1] - Hard cap on returned images
 * @param {number} [options.maxTags=0] - Hard cap on tags per prompt; 0 disables it
 * @param {any} [options.bannedTags] - Tags to strip; comma-separated string or array
 * @param {"always" | "judge"} [options.policy="judge"] - Whether the model is the judge
 * @param {Array<{name: string, loras: Array<{call: string, anchor: string}>}>} [options.registryLoras] - Registry-pinned LoRA calls to guarantee
 * @returns {{generate: boolean, reason: string, images: Array<{prompt: string, ar: string, shot: string, characters: string[]}>, notes: string[]}}
 */
export function validateDirective(parsed, { maxImages = 1, maxTags = 0, bannedTags = "", policy = "judge", registryLoras = [] } = {}) {
    const notes = [];
    const cap = Math.max(1, Number(maxImages) || 1);
    const alwaysGenerate = policy === "always";
    // Taken as an argument rather than read from settings, so this module stays
    // free of a ctx() accessor and testable without a mocked SillyTavern.
    const banned = parseTagList(bannedTags).fingerprints;

    // Registry-pinned LoRA calls, keyed by lowercased character name. Empty
    // unless the caller passed any, which it only does while the setting that
    // permits registry LoRA calls is on — so the default path is untouched.
    /** @type {Map<string, Array<{call: string, anchor: string}>>} */
    const loraByCharacter = new Map();
    for (const source of Array.isArray(registryLoras) ? registryLoras : []) {
        const name = String(source?.name ?? "").trim().toLowerCase();
        const calls = (Array.isArray(source?.loras) ? source.loras : [])
            .map(pin => ({
                call: String(pin?.call ?? pin ?? "").trim(),
                anchor: tagFingerprint(pin?.anchor ?? ""),
            }))
            .filter(pin => pin.call);
        if (name && calls.length) loraByCharacter.set(name, calls);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { generate: false, reason: "", images: [], notes: ["Reply was not a JSON object — treated as skip."] };
    }

    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";

    // Under "judge" a missing or false `generate` is a skip even when images are
    // present: the model was asked to decide, and it decided.
    //
    // Under "always" it is not the judge, so a usable image is taken whatever the
    // boolean says — the field is near-vestigial there, and discarding good work
    // over it would be the fail-closed rule misfiring. A reply with no usable
    // image is still a skip either way: there is nothing to draw, and inventing
    // something is worse than missing one.
    if (parsed.generate !== true && !alwaysGenerate) {
        if (Array.isArray(parsed.images) && parsed.images.length > 0) {
            notes.push("generate was not true but images were present — treated as skip.");
        }
        return { generate: false, reason, images: [], notes };
    }

    const rawImages = Array.isArray(parsed.images) ? parsed.images : [];
    if (!Array.isArray(parsed.images)) notes.push("images was missing or not an array.");

    const images = [];
    for (const entry of rawImages) {
        if (!entry || typeof entry !== "object") {
            notes.push("Dropped an image entry that was not an object.");
            continue;
        }

        let prompt = typeof entry.prompt === "string" ? entry.prompt.trim() : "";
        if (!prompt) {
            notes.push("Dropped an image with an empty prompt.");
            continue;
        }
        if (prompt.length > MAX_PROMPT_CHARS) {
            prompt = prompt.slice(0, MAX_PROMPT_CHARS).trim();
            notes.push(`Prompt truncated to ${MAX_PROMPT_CHARS} characters.`);
        }

        // Before the count cap, after the character truncation. Both orderings are
        // load-bearing: a banned tag left in place would consume a cap slot and
        // then be removed anyway, leaving fewer tags than the user asked for, and
        // truncating characters last would slice through a tag the strip had just
        // tidied.
        const stripped = stripBannedTags(prompt, banned);
        if (stripped.removed.length) {
            notes.push(`Removed ${stripped.removed.length} banned tag${stripped.removed.length === 1 ? "" : "s"}: ${stripped.removed.join(", ")}.`);
        }
        prompt = stripped.prompt;

        // After the character truncation, not before: the character cap exists to
        // protect fillWorkflow's string substitution, the tag cap to bound scene
        // complexity. Cutting tags first would leave a fragment behind for the
        // character cap to slice through mid-tag.
        const capped = capTags(prompt, maxTags);
        if (capped.dropped) {
            notes.push(`Prompt had ${capped.kept + capped.dropped} tags, capped at ${capped.kept}.`);
        }
        prompt = capped.prompt;

        // A prompt of nothing but separators survives the emptiness check above
        // and comes out of the cap empty. Drop it rather than submitting it.
        if (!prompt) {
            notes.push("Dropped an image whose prompt held no usable tags.");
            continue;
        }

        let ar = typeof entry.ar === "string" ? entry.ar.trim() : "";
        if (!VALID_AR.has(ar)) {
            notes.push(`Invalid ar ${JSON.stringify(entry.ar ?? null)} — used ${DEFAULT_AR}.`);
            ar = DEFAULT_AR;
        }

        let shot = typeof entry.shot === "string" ? entry.shot.trim() : "";
        if (!VALID_SHOT.has(shot)) {
            notes.push(`Invalid shot ${JSON.stringify(entry.shot ?? null)} — used ${DEFAULT_SHOT}.`);
            shot = DEFAULT_SHOT;
        }

        // A single name arriving as a bare string is common and harmless to accept;
        // this list only feeds the appearance registry, never ComfyUI.
        const rawCharacters = Array.isArray(entry.characters)
            ? entry.characters
            : (typeof entry.characters === "string" ? [entry.characters] : []);
        const characters = rawCharacters.map(name => String(name ?? "").trim()).filter(Boolean);

        // Put back a registry-pinned LoRA call the model dropped. This is what
        // makes the pin a guarantee rather than a request: a call the user pinned
        // to a character has to reach every image that character is in, and a
        // model that ignored the instruction is exactly the model the pin exists
        // for.
        //
        // The guarantee is to the character, not to the frame. A call that renders
        // one tag is pinned to that tag, and a frame the tag is out of has nothing
        // for it to render: restoring it there paints the anatomy through her
        // clothes, which is the bug this gate exists for. So an anchored call is
        // only put back where its anchor survived into this prompt, and whatever
        // decided the tag decides the call with it. An anchorless character LoRA
        // stays unconditional.
        //
        // Deliberately after the tag cap and not counted by it. The cap bounds
        // scene complexity, which is the model's work; a pinned call is the
        // user's, and dropping their call to make room for the model's twentieth
        // tag has the priority backwards. The character cap still applies, since
        // that one protects fillWorkflow's string substitution.
        if (loraByCharacter.size) {
            const wanted = [];
            for (const name of characters) {
                for (const pin of loraByCharacter.get(name.toLowerCase()) || []) {
                    const seen = wanted.some(other => other.call.toLowerCase() === pin.call.toLowerCase());
                    if (!seen) wanted.push(pin);
                }
            }

            const present = new Set(extractLoraCalls(prompt).map(call => call.toLowerCase()));
            const restored = [];
            const declined = [];

            for (const pin of wanted) {
                if (present.has(pin.call.toLowerCase())) continue;

                const next = withLoraCall(prompt, pin.call, pin.anchor);
                if (next === null) {
                    declined.push(pin);
                    continue;
                }
                if (next.length > MAX_PROMPT_CHARS) {
                    notes.push(`No room left for the registry LoRA call ${pin.call} — the prompt is at the ${MAX_PROMPT_CHARS}-character cap.`);
                    continue;
                }
                prompt = next;
                restored.push(pin.call);
            }

            if (restored.length) {
                notes.push(`Re-inserted ${restored.length} registry LoRA call${restored.length === 1 ? "" : "s"} the reply dropped: ${restored.join(", ")}.`);
            }
            if (declined.length) {
                const listed = declined.map(pin => `${pin.call} (${pin.anchor})`).join(", ");
                notes.push(`Left out ${declined.length} registry LoRA call${declined.length === 1 ? "" : "s"} whose tag this frame does not carry: ${listed}.`);
            }
        }

        images.push({ prompt, ar, shot, characters });
    }

    if (images.length > cap) {
        notes.push(`Returned ${images.length} images, capped at ${cap}.`);
        images.length = cap;
    }

    if (images.length === 0) {
        notes.push("No usable image survived validation — treated as skip.");
        return { generate: false, reason, images: [], notes };
    }

    // An observation rather than a correction: nothing was lost, and the policy
    // says the boolean is not the model's call. Recorded so the reason a
    // generate: false reply still produced an image is visible.
    if (parsed.generate !== true) {
        notes.push("generate was not true, but the generate policy is always — the returned image was kept.");
    }

    return { generate: true, reason, images, notes };
}
