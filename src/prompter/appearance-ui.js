// The appearance registry editor — the third settings-panel tool for the
// dedicated prompter.
//
// The registry is only as good as its worst entry, and both automatic sources
// guess: seeding reads a card that may not describe anyone's hair, and growth
// distils tags out of one image's prompt. So every entry is editable here, and
// editing one marks it "user", which is the one source neither seeding nor
// growth will ever overwrite.

import {
    appearanceEnabled,
    clearRegistry,
    deleteRegistryEntry,
    isRegistrySeeded,
    listRegistryEntries,
    resolveCharacterKey,
    saveRegistry,
    seedRegistry,
    setRegistryEntry,
} from "./appearance.js";
import { getErrorChain, isTimeoutError } from "./llm.js";
import { escapeHtml, openOverlay, overlayIsOpen } from "./overlay.js";

// How long after the last keystroke an edited row is written back.
const EDIT_DEBOUNCE_MS = 400;

const SOURCE_LABELS = {
    seed: "seeded from card + lore",
    grown: "guessed from a generated image",
    user: "edited by hand",
};

/** @type {Map<string, number>} */
const pendingWrites = new Map();

let seeding = false;

/**
 * @param {string} source
 * @returns {string}
 */
function renderSourceBadge(source) {
    const colour = source === "user"
        ? "var(--SmartThemeQuoteColor)"
        : (source === "grown" ? "#c8a35a" : "inherit");
    return `<span title="${escapeHtml(SOURCE_LABELS[source] || source)}"
        style="font-size: 11px; opacity: 0.85; color: ${colour}; white-space: nowrap;">${escapeHtml(source)}</span>`;
}

/**
 * One editable row. The tags field writes back on a debounce and flips the
 * entry's source to "user", which locks it against both automatic sources.
 * @param {{key: string, name: string, tags: string, source: string}} entry
 * @param {() => void} rerender
 * @returns {HTMLElement}
 */
function buildRow(entry, rerender) {
    const row = document.createElement("div");
    row.style.cssText = `
        display: flex; gap: 8px; align-items: flex-start; padding: 8px 0;
        border-bottom: 1px solid var(--SmartThemeBorderColor);
    `;

    const left = document.createElement("div");
    left.style.cssText = "width: 150px; flex-shrink: 0; word-break: break-word;";

    const nameLabel = document.createElement("div");
    nameLabel.style.cssText = "font-weight: bold; font-size: 13px;";
    nameLabel.textContent = entry.name;

    const badge = document.createElement("div");
    badge.style.marginTop = "2px";
    badge.innerHTML = renderSourceBadge(entry.source);

    left.append(nameLabel, badge);
    row.appendChild(left);

    const tags = document.createElement("textarea");
    tags.className = "text_pole";
    tags.rows = 2;
    tags.value = entry.tags;
    tags.placeholder = "1girl, long silver hair, red eyes, black coat";
    tags.style.cssText = "flex: 1; min-width: 0; font-size: 12px;";
    tags.addEventListener("input", () => {
        clearTimeout(pendingWrites.get(entry.key));
        pendingWrites.set(entry.key, setTimeout(() => {
            pendingWrites.delete(entry.key);
            const value = tags.value.trim();
            if (!value) return;
            setRegistryEntry(entry.key, { name: entry.name, tags: value, source: "user" });
            saveRegistry();
            badge.innerHTML = renderSourceBadge("user");
        }, EDIT_DEBOUNCE_MS));
    });
    row.appendChild(tags);

    const remove = document.createElement("div");
    remove.className = "menu_button";
    remove.title = `Remove ${entry.name} from the registry`;
    remove.innerHTML = `<i class="fa-solid fa-trash-can"></i>`;
    remove.style.flexShrink = "0";
    remove.addEventListener("click", () => {
        clearTimeout(pendingWrites.get(entry.key));
        pendingWrites.delete(entry.key);
        deleteRegistryEntry(entry.key);
        saveRegistry();
        rerender();
    });
    row.appendChild(remove);

    return row;
}

/**
 * The add-a-character row. A hand-added entry starts out as "user" — the point
 * of adding one by hand is that the automatic sources got it wrong or missed it.
 * @param {() => void} rerender
 * @returns {HTMLElement}
 */
function buildAddRow(rerender) {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; gap: 8px; align-items: flex-start; padding: 12px 0 0 0;";

    const name = document.createElement("input");
    name.className = "text_pole";
    name.type = "text";
    name.placeholder = "Character name";
    name.style.cssText = "width: 150px; flex-shrink: 0;";

    const tags = document.createElement("textarea");
    tags.className = "text_pole";
    tags.rows = 2;
    tags.placeholder = "Appearance tags";
    tags.style.cssText = "flex: 1; min-width: 0; font-size: 12px;";

    const add = document.createElement("div");
    add.className = "menu_button menu_button_icon";
    add.innerHTML = `<i class="fa-solid fa-plus"></i><span>Add</span>`;
    add.style.flexShrink = "0";
    add.addEventListener("click", () => {
        const characterName = name.value.trim();
        const characterTags = tags.value.trim();
        if (!characterName || !characterTags) {
            toastr.warning("A name and at least one tag are needed.", "ComfyInject");
            return;
        }

        const key = resolveCharacterKey(characterName);
        if (!key) {
            toastr.warning("That name cannot be used as a registry key.", "ComfyInject");
            return;
        }

        if (!setRegistryEntry(key, { name: characterName, tags: characterTags, source: "user" })) {
            toastr.warning("The registry is full — remove an entry first.", "ComfyInject");
            return;
        }
        saveRegistry();
        rerender();
    });

    row.append(name, tags, add);
    return row;
}

/**
 * Runs the seeding pass from the editor. Unlike the automatic pass this ignores
 * the once-per-chat flag and the auto-seed setting — an explicit click is an
 * explicit request.
 * @param {() => void} rerender
 */
async function runSeeding(rerender) {
    if (seeding) {
        toastr.info("A seeding pass is already running.", "ComfyInject");
        return;
    }

    seeding = true;
    toastr.info("Reading the character cards and lorebooks…", "ComfyInject");
    try {
        const result = await seedRegistry();
        if (!overlayIsOpen()) return;

        if (result.written.length) {
            toastr.success(`Seeded ${result.written.length} character(s): ${result.written.join(", ")}`, "ComfyInject");
        } else if (result.skipped.length) {
            toastr.info(`Nothing written — ${result.skipped.length} entry(ies) are hand-edited and were kept.`, "ComfyInject");
        } else {
            toastr.warning("The prompter found no appearance details to seed from.", "ComfyInject");
        }
        rerender();
    } catch (err) {
        toastr.error(
            isTimeoutError(err) ? "The seeding request timed out." : (err?.message || "The seeding request failed."),
            "ComfyInject"
        );
        console.warn("[ComfyInject/prompter] seeding failed", getErrorChain(err));
    } finally {
        seeding = false;
    }
}

/**
 * Opens the registry editor.
 */
export function openAppearanceEditor() {
    const render = () => {
        const body = openOverlay("Appearance Registry", [
            { label: "Seed from card + lore", icon: "fa-wand-magic-sparkles", onClick: () => runSeeding(render) },
            {
                label: "Clear all",
                icon: "fa-trash",
                onClick: () => {
                    if (!listRegistryEntries().length) return;
                    clearRegistry();
                    render();
                },
            },
        ]);

        const entries = listRegistryEntries();

        const intro = document.createElement("div");
        intro.style.cssText = "margin-bottom: 12px; font-size: 13px; line-height: 1.6; opacity: 0.9;";
        intro.innerHTML = [
            "These tags are sent to the prompter with every request, so a character keeps the same hair, eyes and outfit across images.",
            `Stored with this chat only. ${entries.length} entry(ies). Automatic seeding for this chat: ${isRegistrySeeded() ? "done" : "not run yet"}.`,
            "Editing a row marks it <b>user</b>, and a user row is never overwritten by seeding or by a generated image.",
        ].join("<br />");
        body.appendChild(intro);

        if (!appearanceEnabled()) {
            const off = document.createElement("div");
            off.style.cssText = "margin-bottom: 12px; padding: 8px 10px; font-size: 13px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px;";
            off.textContent = "\"Use the appearance registry\" is off, so nothing here is sent to the prompter. Editing still works.";
            body.appendChild(off);
        }

        if (!entries.length) {
            const empty = document.createElement("div");
            empty.style.cssText = "padding: 12px 0; opacity: 0.75; font-size: 13px;";
            empty.textContent = "Nothing here yet. Seed from the card and lorebooks, add a character by hand, or let the registry fill itself as images are generated.";
            body.appendChild(empty);
        }

        for (const entry of entries) body.appendChild(buildRow(entry, render));
        body.appendChild(buildAddRow(render));
    };

    render();
}
