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

    const tokens = await countTokens(built.systemPrompt);
    const transport = getTransportInfo();

    const body = openOverlay("Prompter Context Preview", [
        { label: "Copy prompt", icon: "fa-copy", onClick: () => copyText(built.systemPrompt) },
    ]);

    const summary = [
        `Target: message #${built.target.index} (${built.target.name})`,
        `Sections: ${built.sections.length}`,
        `Total: ${built.chars.toLocaleString()} chars, ${tokens.count.toLocaleString()} tokens${tokens.estimated ? " (estimated)" : ""}`,
        `Transport: ${transport.transport}${transport.reason ? ` — ${transport.reason}` : ""}`,
        `Abort supported: ${canAbortPrompter() ? "yes" : "no"}`,
    ];

    body.innerHTML = `
        <div style="margin-bottom: 12px; font-size: 13px; line-height: 1.6; opacity: 0.9;">
            ${summary.map(line => escapeHtml(line)).join("<br />")}
        </div>
        ${built.sections.map(section => renderBlock(section.title, section.body, `${section.body.length.toLocaleString()} chars`)).join("")}
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
        result = await runPrompter({ systemPrompt: built.systemPrompt });
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
        ? validateDirective(parsed, { maxImages: settings.prompter_max_images_per_message })
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
