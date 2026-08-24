// The full-screen overlay the dedicated prompter's settings tools are drawn in:
// the context preview, the prompter test, and the appearance registry editor.
//
// Same shape as the image gallery's overlay, kept in one place because three
// tools now use it.

import { warnLog } from "./log.js";

const OVERLAY_ID = "comfyinject-prompter-overlay";

// Below this the overlay is one column wide: side-by-side label and field stops
// paying for itself and the header's buttons no longer fit on the title's line.
export const NARROW_QUERY = "(max-width: 700px)";

/**
 * Adds a stylesheet to the document once, keyed by id. The overlay's own layout
 * needs real media queries — it has to survive a rotation without being rebuilt
 * — and those cannot live in an inline style attribute.
 * @param {string} id
 * @param {string} css
 */
export function injectStyle(id, css) {
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
}

const OVERLAY_CSS = `
#${OVERLAY_ID} .comfyinject-overlay-header {
    display: flex; align-items: center; flex-wrap: wrap;
    gap: 12px; padding: 12px 20px; color: white; flex-shrink: 0;
}
#${OVERLAY_ID} .comfyinject-overlay-title {
    font-size: 18px; font-weight: bold; flex: 1 1 auto; min-width: 0;
}
#${OVERLAY_ID} .comfyinject-overlay-actions {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
}
#${OVERLAY_ID} .comfyinject-overlay-close {
    cursor: pointer; font-size: 24px; color: white; padding: 4px 12px; flex-shrink: 0;
}
#${OVERLAY_ID} .comfyinject-overlay-body {
    flex: 1; overflow-y: auto; padding: 0 20px 20px 20px; color: white;
}

@media ${NARROW_QUERY} {
    /* Title and close keep the first line to themselves; the action buttons
       drop to a full-width row underneath and share it evenly. */
    #${OVERLAY_ID} .comfyinject-overlay-header { gap: 8px; padding: 10px 12px; }
    #${OVERLAY_ID} .comfyinject-overlay-title { font-size: 16px; order: 1; }
    #${OVERLAY_ID} .comfyinject-overlay-close { order: 2; }
    #${OVERLAY_ID} .comfyinject-overlay-actions { order: 3; flex-basis: 100%; }
    #${OVERLAY_ID} .comfyinject-overlay-actions .menu_button {
        flex: 1 1 auto; justify-content: center;
    }
    #${OVERLAY_ID} .comfyinject-overlay-body { padding: 0 12px 16px 12px; }
}
`;

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
    injectStyle(`${OVERLAY_ID}-styles`, OVERLAY_CSS);

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    // The height is in viewport units, not per cent, on purpose. SillyTavern's
    // own stylesheet puts a -webkit-transform and a perspective on <html>, which
    // makes <html> — not the viewport — the containing block for anything
    // fixed. On mobile widths its stylesheet also makes <body> fixed, so <html>
    // has nothing in flow left and measures 0px tall; a height of 100% then
    // resolves to zero and the overlay opens invisibly. Viewport units always
    // measure the viewport, whatever the containing block turns out to be.
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100vh; height: 100dvh;
        background: rgba(0, 0, 0, 0.85); z-index: 9999;
        display: flex; flex-direction: column; overflow: hidden;
    `;
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closePrompterOverlay();
    });

    const header = document.createElement("div");
    header.className = "comfyinject-overlay-header";

    const titleEl = document.createElement("span");
    titleEl.className = "comfyinject-overlay-title";
    titleEl.textContent = title;
    header.appendChild(titleEl);

    const actionBar = document.createElement("div");
    actionBar.className = "comfyinject-overlay-actions";
    for (const action of actions) {
        const button = document.createElement("div");
        button.className = "menu_button menu_button_icon";
        button.innerHTML = `<i class="fa-solid ${action.icon}"></i><span>${escapeHtml(action.label)}</span>`;
        button.addEventListener("click", action.onClick);
        actionBar.appendChild(button);
    }
    header.appendChild(actionBar);

    // A sibling of the action bar rather than its last child, so the narrow
    // layout can keep it on the title's line while the actions drop below.
    const closeBtn = document.createElement("div");
    closeBtn.className = "comfyinject-overlay-close";
    closeBtn.innerHTML = `<i class="fa-solid fa-xmark"></i>`;
    closeBtn.addEventListener("click", closePrompterOverlay);
    header.appendChild(closeBtn);
    overlay.appendChild(header);

    const body = document.createElement("div");
    body.className = "comfyinject-overlay-body";
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
