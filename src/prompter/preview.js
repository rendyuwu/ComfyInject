// Two settings-panel tools for the dedicated prompter:
//
//   openContextPreview() — shows exactly what the prompter would be sent, section
//                          by section, with character and token counts. Costs
//                          nothing and is where every later bug gets diagnosed first.
//   openPrompterTest()   — runs one real request against the current chat and
//                          shows the raw reply next to the validated result.
//                          No image is generated.
//
// Both reuse the same overlay shape as the image gallery.

import { buildPrompterContext, countTokens } from "./context.js";
import { runPrompter, getTransportInfo, canAbortPrompter, getErrorChain, isTimeoutError } from "./llm.js";
import { parseDirective, validateDirective } from "./schema.js";
import { MODULE_NAME } from "../../settings.js";
import { warnLog } from "./log.js";

const OVERLAY_ID = "comfyinject-prompter-overlay";

/**
 * @param {any} value
 * @returns {string}
 */
function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * navigator.clipboard is absent, not merely blocked, on plain-HTTP LAN installs,
 * which is how a lot of SillyTavern is actually reached.
 * @param {string} text
 */
async function copyText(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            toastr.success("Copied to clipboard.", "ComfyInject");
            return;
        }
    } catch (err) {
        warnLog("clipboard write failed, falling back to a hidden textarea", err);
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText = "position: fixed; top: -1000px; left: -1000px;";
    document.body.appendChild(textarea);
    textarea.select();
    try {
        const ok = document.execCommand("copy");
        if (ok) toastr.success("Copied to clipboard.", "ComfyInject");
        else toastr.warning("Could not copy — select the text manually.", "ComfyInject");
    } catch (err) {
        toastr.warning("Could not copy — select the text manually.", "ComfyInject");
    } finally {
        textarea.remove();
    }
}

/** Closes the prompter overlay if it is open. */
export function closePrompterOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
    document.removeEventListener("keydown", onKeyDown);
}

/** @param {KeyboardEvent} event */
function onKeyDown(event) {
    if (event.key === "Escape") closePrompterOverlay();
}

/**
 * Builds the overlay and returns the scrollable body element to fill.
 * @param {string} title
 * @param {Array<{label: string, icon: string, onClick: () => void}>} [actions]
 * @returns {HTMLElement}
 */
function openOverlay(title, actions = []) {
    closePrompterOverlay();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.85); z-index: 9999;
        display: flex; flex-direction: column; overflow: hidden;
    `;
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closePrompterOverlay();
    });

    const header = document.createElement("div");
    header.style.cssText = `
        display: flex; justify-content: space-between; align-items: center;
        gap: 12px; padding: 12px 20px; color: white; flex-shrink: 0;
    `;

    const titleEl = document.createElement("span");
    titleEl.style.cssText = "font-size: 18px; font-weight: bold;";
    titleEl.textContent = title;
    header.appendChild(titleEl);

    const actionBar = document.createElement("div");
    actionBar.style.cssText = "display: flex; gap: 8px; align-items: center;";
    for (const action of actions) {
        const button = document.createElement("div");
        button.className = "menu_button menu_button_icon";
        button.innerHTML = `<i class="fa-solid ${action.icon}"></i><span>${escapeHtml(action.label)}</span>`;
        button.addEventListener("click", action.onClick);
        actionBar.appendChild(button);
    }

    const closeBtn = document.createElement("div");
    closeBtn.style.cssText = "cursor: pointer; font-size: 24px; color: white; padding: 4px 12px;";
    closeBtn.innerHTML = `<i class="fa-solid fa-xmark"></i>`;
    closeBtn.addEventListener("click", closePrompterOverlay);
    actionBar.appendChild(closeBtn);
    header.appendChild(actionBar);
    overlay.appendChild(header);

    const body = document.createElement("div");
    body.style.cssText = `
        flex: 1; overflow-y: auto; padding: 0 20px 20px 20px; color: white;
    `;
    overlay.appendChild(body);

    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKeyDown);
    return body;
}

/**
 * @param {string} title
 * @param {string} content
 * @param {string} [meta]
 * @returns {string}
 */
function renderBlock(title, content, meta = "") {
    return `
        <details open style="margin-bottom: 10px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px;">
            <summary style="cursor: pointer; padding: 8px 10px; font-weight: bold;">
                ${escapeHtml(title)}${meta ? ` <span style="opacity: 0.7; font-weight: normal;">— ${escapeHtml(meta)}</span>` : ""}
            </summary>
            <pre style="margin: 0; padding: 10px; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.4; max-height: 40vh; overflow-y: auto;">${escapeHtml(content)}</pre>
        </details>
    `;
}

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
        if (!document.getElementById(OVERLAY_ID)) return;
        body.innerHTML = `
            <div style="margin-bottom: 12px; color: var(--SmartThemeQuoteColor); font-weight: bold;">
                ${timedOut ? "The prompter request timed out." : "The prompter request failed."}
            </div>
            ${renderBlock("Error chain", chain.join("\n"))}
        `;
        return;
    }

    // The overlay may have been closed while the request was in flight.
    if (!document.getElementById(OVERLAY_ID)) return;

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
