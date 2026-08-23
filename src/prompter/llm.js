// Single dispatch point for the dedicated prompter call.
//
// Two transports, picked automatically:
//   profile     — a SillyTavern Connection Profile, via ConnectionManagerRequestService.
//                 Model, endpoint and API key all live in the profile, so ComfyInject
//                 stores a profile id and never touches a credential.
//   generateRaw — the currently selected main API, used when the Connection Manager
//                 is disabled or no profile is selected.
//
// Structured output is requested through SillyTavern's own `json_schema` payload
// field rather than a raw OpenAI `response_format`: core translates it per backend
// (response_format for OpenAI-style sources, a tool call for Claude, responseSchema
// for Google), so one code path covers every chat-completion source. Text
// completion backends have no equivalent, so those profiles go straight to the
// prompt-engineered mode — the schema and a filled example are in the prompt in
// both modes, which is what makes a mid-flight degrade work without rebuilding it.

import { MODULE_NAME, DEFAULT_PROMPTER_USER_TURN } from "../../settings.js";
import { substituteTrimmed } from "../macros.js";
import { debugLog, warnLog } from "./log.js";
import { DIRECTIVE_SCHEMA, SCHEMA_NAME, toStrictJsonSchema } from "./schema.js";

// Profiles that have already refused schema-constrained output, so a session does
// not keep paying for the same rejected request. Keyed by transport and profile id.
const nativeRefused = new Set();

/** @returns {any} */
function ctx() {
    return SillyTavern.getContext();
}

/** @returns {Record<string, any>} */
function getSettings() {
    return ctx().extensionSettings[MODULE_NAME];
}

/**
 * Pulls the usable payload out of whatever shape the backend returned.
 *
 * Native structured output hands back an already-parsed object; everything else
 * is a string in one of half a dozen envelopes. The `reasoning` fallback matters
 * because some reasoning models return only that field when max_tokens is tight.
 *
 * @param {any} raw
 * @returns {string | object}
 */
export function extractPayload(raw) {
    if (raw === null || raw === undefined) return "";
    if (typeof raw === "string") return raw;

    // json_schema requests come back parsed by core.
    if (raw.content && typeof raw.content === "object") return raw.content;

    const text = raw.content
        ?? raw.message?.content
        ?? raw.choices?.[0]?.message?.content
        ?? raw.choices?.[0]?.text
        ?? raw.response
        ?? raw.text
        ?? null;
    if (typeof text === "string") return text;
    if (text && typeof text === "object") return text;

    const reasoning = raw.reasoning ?? raw.message?.reasoning ?? raw.choices?.[0]?.message?.reasoning;
    if (typeof reasoning === "string") return reasoning;

    return "";
}

/**
 * Flattens an error's cause chain. SillyTavern rewraps every backend failure as
 * `new Error('API request failed', { cause })`, so the real message is only
 * reachable through the chain.
 * @param {any} error
 * @returns {string[]}
 */
export function getErrorChain(error) {
    const chain = [];
    let current = error;
    while (current && chain.length < 10) {
        chain.push(String(current.message ?? current));
        current = current.cause;
    }
    return chain;
}

/**
 * True when the failure looks like the backend refusing schema-constrained
 * output rather than a real problem, so retrying without the schema is worth it.
 * @param {any} error
 * @returns {boolean}
 */
function isSchemaRefusal(error) {
    const chain = getErrorChain(error).join(" | ");
    return /bad request|json_schema|response_format|responseschema|schema/i.test(chain);
}

/**
 * True when the failure is this module's own timeout. SillyTavern rewraps the
 * abort reason, so the name on the outer error is not enough to go on.
 * @param {any} error
 * @returns {boolean}
 */
export function isTimeoutError(error) {
    if (error?.name === "TimeoutError") return true;
    return /timed out|timeouterror/i.test(getErrorChain(error).join(" | "));
}

/**
 * Describes which transport the next prompter call will use, and why.
 * @returns {{transport: "profile" | "generateRaw", profileId: string, reason: string}}
 */
export function getTransportInfo() {
    const context = ctx();
    const settings = getSettings();
    const profileId = String(settings.prompter_profile_id || "").trim();
    const service = context.ConnectionManagerRequestService;
    const disabled = !!context.extensionSettings?.disabledExtensions?.includes("connection-manager");

    if (!disabled && service && typeof service.sendRequest === "function" && profileId) {
        return { transport: "profile", profileId, reason: "" };
    }

    let reason;
    if (disabled) reason = "Connection Manager is disabled — using the active main API.";
    else if (!service || typeof service.sendRequest !== "function") reason = "Connection Manager is unavailable in this SillyTavern build — using the active main API.";
    else reason = "No connection profile selected — using the active main API.";

    return { transport: "generateRaw", profileId: "", reason };
}

/**
 * generateRaw offers no abort signal, so the UI must not render a Stop control
 * on that path.
 * @returns {boolean}
 */
export function canAbortPrompter() {
    return getTransportInfo().transport === "profile";
}

/**
 * Whether a configured prefill would actually be sent, and why not when it would
 * not be. A prefill silently ignored reads as a broken setting, so the settings
 * panel states the current answer instead of a general caveat.
 * @returns {{active: boolean, reason: string}}
 */
export function getPrefillStatus() {
    const settings = getSettings();
    const prefill = String(settings.prompter_prefill ?? "").trim();
    if (!prefill) return { active: false, reason: "" };

    if (getTransportInfo().transport === "profile") {
        return { active: false, reason: "Not sent: the Connection Profile transport has no prefill parameter. It only applies when no profile is selected." };
    }
    if (settings.prompter_structured_mode !== "json") {
        return { active: false, reason: "Only sent on requests that are not schema-constrained. With Structured Output on Native that means the fallback after a refusal, and nothing else — switch to Prompt-engineered to use it on every request." };
    }
    return { active: true, reason: "Sent with every prompter request." };
}

/**
 * True when the profile's backend can enforce a JSON schema. Only chat
 * completion sources can; text completion has no schema field server-side.
 * @param {any} service
 * @param {string} profileId
 * @returns {boolean}
 */
function profileSupportsNativeSchema(service, profileId) {
    try {
        const profile = service.getProfile?.(profileId);
        const selected = ctx().CONNECT_API_MAP?.[profile?.api]?.selected;
        return selected === "openai";
    } catch (err) {
        debugLog("could not determine profile API", err);
        return false;
    }
}

/**
 * The json_schema payload core expects: `{name, value, strict, returnInvalid}`.
 * `returnInvalid` keeps an unparsable reply as a string instead of collapsing it
 * to `{}`, which is the difference between a diagnosable failure and a silent one.
 * @param {object} schema
 * @param {string} name
 * @returns {object}
 */
function buildJsonSchemaPayload(schema, name) {
    return {
        name,
        value: toStrictJsonSchema(schema),
        strict: true,
        returnInvalid: true,
    };
}

/**
 * Composes the caller's abort signal with a timeout.
 * @param {AbortSignal | null} signal
 * @param {number} timeoutMs
 * @returns {{signal: AbortSignal | null, cleanup: () => void}}
 */
function withTimeout(signal, timeoutMs) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
    if (!ms) return { signal: signal ?? null, cleanup: () => {} };

    if (typeof AbortSignal?.timeout === "function" && typeof AbortSignal?.any === "function") {
        const timeout = AbortSignal.timeout(ms);
        return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, cleanup: () => {} };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Prompter request timed out", "TimeoutError")), ms);
    signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

/**
 * Rejects after `timeoutMs` while letting the wrapped promise run on. Used for
 * generateRaw, which cannot be aborted — the request keeps going in the
 * background, but the UI is never left waiting on it forever.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
function raceTimeout(promise, timeoutMs) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
    if (!ms) return promise;

    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new DOMException("Prompter request timed out", "TimeoutError")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Sends via a Connection Profile.
 * @returns {Promise<{payload: string | object, structured: "native" | "json"}>}
 */
async function sendViaProfile({ messages, profileId, wantNative, signal, timeoutMs, maxTokens, schema, schemaName }) {
    const service = ctx().ConnectionManagerRequestService;
    const settings = getSettings();

    const requestedPreset = String(settings.prompter_preset || "").trim();
    const profile = typeof service.getProfile === "function" ? service.getProfile(profileId) : null;
    if (!profile) throw new Error(`Connection profile ${profileId} no longer exists.`);

    // getProfile returns the live profile object, so an override has to be put
    // back or the user's profile stays corrupted.
    const overridePreset = !!requestedPreset;
    const originalPreset = overridePreset ? profile.preset : null;

    const refusalKey = `profile:${profileId}`;
    const native = wantNative
        && !nativeRefused.has(refusalKey)
        && profileSupportsNativeSchema(service, profileId);

    const { signal: composed, cleanup } = withTimeout(signal, timeoutMs);

    const send = async (useNative) => {
        const overridePayload = useNative ? { json_schema: buildJsonSchemaPayload(schema, schemaName) } : {};
        debugLog("profile request", {
            profileId,
            api: profile.api,
            preset: overridePreset ? requestedPreset : profile.preset,
            structured: useNative ? "native" : "json",
            maxTokens,
            messages: messages.map((m, index) => ({ index, role: m.role, contentLength: m.content.length })),
        });
        return await service.sendRequest(profileId, messages, maxTokens, {
            stream: false,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
            signal: composed,
        }, overridePayload);
    };

    try {
        if (overridePreset) profile.preset = requestedPreset;

        if (native) {
            try {
                return { payload: extractPayload(await send(true)), structured: "native" };
            } catch (error) {
                if (signal?.aborted || isTimeoutError(error) || !isSchemaRefusal(error)) throw error;
                warnLog("backend refused schema-constrained output, retrying in prompt-engineered mode", getErrorChain(error));
                nativeRefused.add(refusalKey);
            }
        }

        return { payload: extractPayload(await send(false)), structured: "json" };
    } finally {
        cleanup();
        if (overridePreset && profile.preset !== originalPreset) profile.preset = originalPreset;
    }
}

/**
 * Sends via the active main API. generateRaw takes the same message array — on a
 * non-chat-completion backend it flattens the array itself — and accepts a
 * jsonSchema, so the fallback path is not automatically demoted to
 * prompt-engineered output.
 * @returns {Promise<{payload: string | object, structured: "native" | "json"}>}
 */
async function sendViaGenerateRaw({ messages, wantNative, timeoutMs, maxTokens, schema, schemaName, prefill }) {
    const { generateRaw } = ctx();
    if (typeof generateRaw !== "function") {
        throw new Error("generateRaw is not available in this SillyTavern build.");
    }

    const refusalKey = "generateRaw";
    const native = wantNative && !nativeRefused.has(refusalKey);

    const send = async (useNative) => {
        const options = { prompt: messages, responseLength: maxTokens };
        if (useNative) {
            options.jsonSchema = buildJsonSchemaPayload(schema, schemaName);
        } else {
            // Without a schema the reply goes through cleanUpMessage, whose name
            // trimming discards a whole response that happens to open with a
            // character name.
            options.trimNames = false;

            // Never alongside native enforcement: the backend is already
            // constrained, so a prefill is redundant at best and a contradiction
            // at worst. Prompt-engineered mode is where it earns its keep.
            if (prefill) options.prefill = prefill;
        }
        debugLog("generateRaw request", {
            structured: useNative ? "native" : "json",
            maxTokens,
            turns: messages.length,
            prefill: !useNative && prefill ? prefill.length : 0,
        });
        return await raceTimeout(generateRaw(options), timeoutMs);
    };

    if (native) {
        try {
            return { payload: extractPayload(await send(true)), structured: "native" };
        } catch (error) {
            if (isTimeoutError(error) || !isSchemaRefusal(error)) throw error;
            warnLog("main API refused schema-constrained output, retrying in prompt-engineered mode", getErrorChain(error));
            nativeRefused.add(refusalKey);
        }
    }

    return { payload: extractPayload(await send(false)), structured: "json" };
}

/**
 * Runs one prompter request.
 *
 * The schema is a parameter rather than a constant because the dedicated path
 * makes two different kinds of call over the same transport: the per-message
 * image directive, and the appearance registry seeding pass.
 *
 * @param {object} params
 * @param {string} params.systemPrompt - Output of buildPrompterContext()
 * @param {AbortSignal | null} [params.signal]
 * @param {object} [params.schema] - JSON schema to enforce natively
 * @param {string} [params.schemaName] - Name some providers surface in errors
 * @param {string | null} [params.userTurn] - Overrides the configured user message
 * @param {number | null} [params.maxTokens] - Overrides the configured budget
 * @returns {Promise<{payload: string | object, transport: string, structured: string, transportReason: string}>}
 */
export async function runPrompter({
    systemPrompt,
    signal = null,
    schema = DIRECTIVE_SCHEMA,
    schemaName = SCHEMA_NAME,
    userTurn = null,
    maxTokens = null,
}) {
    const settings = getSettings();
    const budget = Number(maxTokens) || Number(settings.prompter_max_tokens) || 1024;
    const resolvedMaxTokens = Math.max(64, budget);
    const timeoutMs = Math.max(1000, Number(settings.prompter_timeout_ms) || 60000);
    const wantNative = settings.prompter_structured_mode !== "json";

    // A caller-supplied turn wins — the seeding pass asks a different question —
    // then the user's setting, then the shipped default. An empty setting is a
    // mistake rather than a request for no user turn: chat-completion backends
    // need something to answer.
    const resolvedUserTurn = substituteTrimmed(userTurn)
        || substituteTrimmed(settings.prompter_user_turn)
        || substituteTrimmed(DEFAULT_PROMPTER_USER_TURN);

    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: resolvedUserTurn },
    ];

    const { transport, profileId, reason } = getTransportInfo();
    if (reason) debugLog("transport", transport, reason);

    const prefill = String(settings.prompter_prefill ?? "").trim();
    if (prefill && transport === "profile") {
        // ConnectionManagerRequestService.sendRequest has no prefill parameter,
        // and a trailing assistant turn is not reliably accepted across backends.
        // Say so rather than dropping it silently.
        warnLog("prefill is set but the connection-profile transport has no prefill parameter — ignoring it");
    }

    const request = {
        messages,
        wantNative,
        timeoutMs,
        maxTokens: resolvedMaxTokens,
        schema,
        schemaName,
        prefill: transport === "profile" ? "" : prefill,
    };
    const result = transport === "profile"
        ? await sendViaProfile({ ...request, profileId, signal })
        : await sendViaGenerateRaw(request);

    debugLog("raw response", result.payload);

    return {
        payload: result.payload,
        transport,
        structured: result.structured,
        transportReason: reason,
    };
}

/**
 * Clears the remembered schema refusals — call this when the profile or the
 * structured-output setting changes, so a fixed configuration is retried.
 */
export function resetTransportState() {
    nativeRefused.clear();
}
