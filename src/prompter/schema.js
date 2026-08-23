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

// Schema name sent to the backend. Some providers surface it in errors.
export const SCHEMA_NAME = "ComfyInjectDirective";

// fillWorkflow() substitutes the prompt into serialized workflow JSON, so an
// unbounded prompt is a real hazard rather than just a waste of tokens.
export const MAX_PROMPT_CHARS = 2000;

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
 * The OUTPUT RULES section body: the schema, a filled example, and the hard
 * constraints the validator enforces anyway. Sent in both structured modes —
 * native enforcement can be refused mid-request, and this is what makes the
 * degraded request work without rebuilding the prompt.
 * @param {number} maxImages
 * @returns {string}
 */
export function renderOutputRules(maxImages) {
    const cap = Math.max(1, Number(maxImages) || 1);
    const example = {
        generate: true,
        reason: "New scene, character just stepped into the rain.",
        images: [{
            prompt: "1girl, solo, long silver hair, red eyes, black coat, standing, rain, night, city street, neon lights, wet pavement",
            ar: DEFAULT_AR,
            shot: DEFAULT_SHOT,
            characters: ["Character name"],
        }],
    };

    return [
        "Return exactly one JSON object and nothing else. No prose before or after it, no code fence.",
        "",
        "Schema:",
        JSON.stringify(DIRECTIVE_SCHEMA, null, 2),
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
 * Validates and clamps a parsed reply into something safe to hand to ComfyUI.
 *
 * Fails closed: anything ambiguous becomes a skip rather than a guess.
 *
 * @param {any} parsed - Output of parseDirective
 * @param {object} [options]
 * @param {number} [options.maxImages=1] - Hard cap on returned images
 * @returns {{generate: boolean, reason: string, images: Array<{prompt: string, ar: string, shot: string, characters: string[]}>, notes: string[]}}
 */
export function validateDirective(parsed, { maxImages = 1 } = {}) {
    const notes = [];
    const cap = Math.max(1, Number(maxImages) || 1);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { generate: false, reason: "", images: [], notes: ["Reply was not a JSON object — treated as skip."] };
    }

    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";

    // A missing or false `generate` is a skip even when images are present.
    if (parsed.generate !== true) {
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

        images.push({ prompt, ar, shot, characters });
    }

    if (images.length > cap) {
        notes.push(`Returned ${images.length} images, capped at ${cap}.`);
        images.length = cap;
    }

    if (images.length === 0) {
        notes.push("generate was true but no usable image survived validation — treated as skip.");
        return { generate: false, reason, images: [], notes };
    }

    return { generate: true, reason, images, notes };
}
