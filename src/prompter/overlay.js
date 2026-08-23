// The full-screen overlay the dedicated prompter's settings tools are drawn in:
// the context preview, the prompter test, and the appearance registry editor.
//
// Same shape as the image gallery's overlay, kept in one place because three
// tools now use it.

import { warnLog } from "./log.js";

const OVERLAY_ID = "comfyinject-prompter-overlay";

/**
 * @param {any} value
 * @returns {string}
 */
export function escapeHtml(value) {
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
export async function copyText(text) {
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

/** True while the overlay opened by the current tool is still on screen. */
export function overlayIsOpen() {
    return !!document.getElementById(OVERLAY_ID);
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
export function openOverlay(title, actions = []) {
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
    actionBar.style.cssText = "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;";
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
 * A collapsible labelled block of preformatted text.
 * @param {string} title
 * @param {string} content
 * @param {string} [meta]
 * @returns {string}
 */
export function renderBlock(title, content, meta = "") {
    return `
        <details open style="margin-bottom: 10px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px;">
            <summary style="cursor: pointer; padding: 8px 10px; font-weight: bold;">
                ${escapeHtml(title)}${meta ? ` <span style="opacity: 0.7; font-weight: normal;">— ${escapeHtml(meta)}</span>` : ""}
            </summary>
            <pre style="margin: 0; padding: 10px; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.4; max-height: 40vh; overflow-y: auto;">${escapeHtml(content)}</pre>
        </details>
    `;
}
