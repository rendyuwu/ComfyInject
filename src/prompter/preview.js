// Two settings-panel tools for the dedicated prompter:
//
//   openContextPreview() — shows exactly what the prompter would be sent, section
//                          by section, with character and token counts. Costs
//                          nothing and is where every later bug gets diagnosed first.
//   openPrompterTest()   — runs one real request against the current chat and
//                          shows the raw reply next to the validated result.
//                          No image is generated.
//
// The appearance registry editor is the third tool and lives in appearance-ui.js.

import { buildPrompterContext, countTokens } from "./context.js";
import { runPrompter, getTransportInfo, canAbortPrompter, getErrorChain, isTimeoutError } from "./llm.js";
import { parseDirective, validateDirective } from "./schema.js";
import { MODULE_NAME } from "../../settings.js";
import { copyText, escapeHtml, openOverlay, overlayIsOpen, renderBlock } from "./overlay.js";

export { closePrompterOverlay } from "./overlay.js";

/**
 * Shows the assembled prompter context without spending a single token.
 * @param {number | null} [messageIndex]
 */
export async function openContextPreview(messageIndex = null) {
    let built;
    try {
        built = await buildPrompterContext({ messageIndex });
    } catch (err) {
        toastr.error(err?.message || String(err), "ComfyInject");
        return;
    }

    const full = `${built.systemPrompt}\n\n${built.volatilePrompt}`;
    const tokens = await countTokens(full);
    const transport = getTransportInfo();

    const body = openOverlay("Prompter Context Preview", [
        { label: "Copy prompt", icon: "fa-copy", onClick: () => copyText(full) },
    ]);

    const summary = [
        `Target: message #${built.target.index} (${built.target.name})`,
        `Sections: ${built.sections.length} — ${built.stable.length} stable, ${built.volatile.length} volatile`,
        `Stable block (system): ${built.systemPrompt.length.toLocaleString()} chars — cacheable, byte-identical between turns`,
        `Volatile block (user): ${built.volatilePrompt.length.toLocaleString()} chars — changes every message`,
        `Total: ${built.chars.toLocaleString()} chars, ${tokens.count.toLocaleString()} tokens${tokens.estimated ? " (estimated)" : ""}`,
        `Transport: ${transport.transport}${transport.reason ? ` — ${transport.reason}` : ""}`,
        `Abort supported: ${canAbortPrompter() ? "yes" : "no"}`,
    ];

    const renderGroup = (/** @type {string} */ label, /** @type {any[]} */ sections) => `
        <div style="margin: 12px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.6;">
            ${escapeHtml(label)}
        </div>
        ${sections.map(section => renderBlock(section.title, section.body, `${section.body.length.toLocaleString()} chars`)).join("")}
    `;

    body.innerHTML = `
        <div style="margin-bottom: 12px; font-size: 13px; line-height: 1.6; opacity: 0.9;">
            ${summary.map(line => escapeHtml(line)).join("<br />")}
        </div>
        ${renderGroup("messages[0] — system, stable", built.stable)}
        ${renderGroup("messages[1] — user, volatile", built.volatile)}
    `;
}

/**
 * Runs one real prompter request against the current chat and shows what came
 * back. Nothing is generated and nothing is written to the chat.
 * @param {number | null} [messageIndex]
 */
export async function openPrompterTest(messageIndex = null) {
    const settings = SillyTavern.getContext().extensionSettings[MODULE_NAME];

    let built;
    try {
        built = await buildPrompterContext({ messageIndex });
    } catch (err) {
        toastr.error(err?.message || String(err), "ComfyInject");
        return;
    }

    const body = openOverlay("Prompter Test");
    body.innerHTML = `<div style="padding: 20px 0; font-size: 14px;"><i class="fa-solid fa-spinner fa-spin"></i> Waiting for the prompter…</div>`;

    let result;
    try {
        result = await runPrompter({
            messages: built.messages,
            rebuild: async (structuredMode) =>
                (await buildPrompterContext({ messageIndex, structuredMode })).messages,
        });
    } catch (err) {
        const chain = getErrorChain(err);
        const timedOut = isTimeoutError(err);
        if (!overlayIsOpen()) return;
        body.innerHTML = `
            <div style="margin-bottom: 12px; color: var(--SmartThemeQuoteColor); font-weight: bold;">
                ${timedOut ? "The prompter request timed out." : "The prompter request failed."}
            </div>
            ${renderBlock("Error chain", chain.join("\n"))}
        `;
        return;
    }

    // The overlay may have been closed while the request was in flight.
    if (!overlayIsOpen()) return;

    const rawText = typeof result.payload === "string"
        ? result.payload
        : JSON.stringify(result.payload, null, 2);

    let parsed = null;
    let parseError = "";
    try {
        parsed = parseDirective(result.payload);
    } catch (err) {
        parseError = err?.message || String(err);
    }

    const validated = parsed
        ? validateDirective(parsed, {
            maxImages: settings.prompter_max_images_per_message,
            maxTags: settings.prompter_max_tags,
            bannedTags: settings.prompter_banned_tags,
            policy: settings.prompter_generate_policy,
        })
        : null;

    const summary = [
        `Transport: ${result.transport}${result.transportReason ? ` — ${result.transportReason}` : ""}`,
        `Structured mode: ${result.structured}${result.structured === "json" && settings.prompter_structured_mode === "native" ? " — native was asked for, this backend does not enforce schemas" : ""}`,
        `Target: message #${built.target.index} (${built.target.name})`,
    ];
    if (validated) {
        summary.push(`Decision: ${validated.generate ? `generate ${validated.images.length} image(s)` : "skip"}`);
        if (validated.reason) summary.push(`Reason: ${validated.reason}`);
    }

    body.innerHTML = `
        <div style="margin-bottom: 12px; font-size: 13px; line-height: 1.6; opacity: 0.9;">
            ${summary.map(line => escapeHtml(line)).join("<br />")}
        </div>
        ${parseError ? `<div style="margin-bottom: 12px; color: var(--SmartThemeQuoteColor); font-weight: bold;">${escapeHtml(parseError)}</div>` : ""}
        ${validated?.notes?.length ? renderBlock("Validation notes", validated.notes.join("\n"), `${validated.notes.length}`) : ""}
        ${validated ? renderBlock("Validated result", JSON.stringify(validated, null, 2)) : ""}
        ${renderBlock("Raw response", rawText, `${rawText.length.toLocaleString()} chars`)}
    `;
}
