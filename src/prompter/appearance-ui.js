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
    describeSeedingState,
    listRegistryEntries,
    readRegistry,
    registryMaxChars,
    resolveCharacterKey,
    saveRegistry,
    seedRegistry,
    setRegistryEntry,
} from "./appearance.js";
import { getErrorChain, isTimeoutError } from "./llm.js";
import { escapeHtml, injectStyle, NARROW_QUERY, openOverlay, overlayIsOpen } from "./overlay.js";

// How long after the last keystroke an edited row is written back.
const EDIT_DEBOUNCE_MS = 400;

// A row is a name column, a tags field and a remove button. Wide enough, they
// sit on one line. Narrow — a phone held upright — a 150px name column leaves
// the tags field too thin to read a line of tags in, so the name and the remove
// button take the first line and the field gets the whole of the second.
const ROW_CSS = `
.comfyinject-appearance-row {
    display: flex; gap: 8px; align-items: flex-start; padding: 8px 0;
    border-bottom: 1px solid var(--SmartThemeBorderColor);
}
.comfyinject-appearance-add {
    display: flex; gap: 8px; align-items: flex-start; padding: 12px 0 0 0;
}
.comfyinject-appearance-name {
    width: 150px; flex-shrink: 0; word-break: break-word;
}
.comfyinject-appearance-tags {
    flex: 1; min-width: 0; font-size: 12px;
}
.comfyinject-appearance-button {
    flex-shrink: 0;
}

@media ${NARROW_QUERY} {
    .comfyinject-appearance-row,
    .comfyinject-appearance-add { flex-wrap: wrap; }
    .comfyinject-appearance-name { width: auto; flex: 1 1 auto; min-width: 0; order: 1; }
    .comfyinject-appearance-button { order: 2; }
    .comfyinject-appearance-tags { order: 3; flex-basis: 100%; }
}
`;

const SOURCE_LABELS = {
    seed: "seeded from card, lore + chat",
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
 *
 * Clearing the field is a write, not a no-op: it stores the entry blank, which is
 * the tombstone that keeps a name out of every later request permanently. Deleting
 * the row instead only lasts until the next seeding pass rewrites it.
 *
 * @param {{key: string, name: string, tags: string, source: string, truncated: boolean, truncatedAt: number}} entry
 * @param {() => void} rerender
 * @returns {HTMLElement}
 */
function buildRow(entry, rerender) {
    const row = document.createElement("div");
    row.className = "comfyinject-appearance-row";

    const left = document.createElement("div");
    left.className = "comfyinject-appearance-name";

    const nameLabel = document.createElement("div");
    nameLabel.style.cssText = "font-weight: bold; font-size: 13px;";
    nameLabel.textContent = entry.name;

    const badge = document.createElement("div");
    badge.style.marginTop = "2px";
    badge.innerHTML = renderSourceBadge(entry.source);

    // Whatever the row is doing that its tags do not show: suppressed, or cut by
    // the cap. A truncated entry is the one that reads as a lazy model reply and
    // is actually a character budget, so it gets said out loud here as well as in
    // the console.
    const status = document.createElement("div");
    status.style.cssText = "margin-top: 3px; font-size: 11px; line-height: 1.4;";

    const state = { tags: entry.tags, source: entry.source, truncated: entry.truncated, truncatedAt: entry.truncatedAt };

    const paintStatus = () => {
        if (!state.tags) {
            status.innerHTML = `<span style="color: var(--SmartThemeQuoteColor);">suppressed — nothing is sent for this name, and neither seeding nor a generated image will refill it</span>`;
            return;
        }
        if (state.truncated) {
            // The cap that did the cutting, which is not today's cap once the
            // setting has been raised — and the raise is exactly when someone
            // reads this line.
            const cap = state.truncatedAt || registryMaxChars();
            const room = registryMaxChars() > cap
                ? ` There is room for ${registryMaxChars()} now — re-seed to get the rest back.`
                : ` Raise <b>Registry entry size</b> and re-seed to get the rest back.`;
            status.innerHTML = `<span style="color: #c8a35a;">cut at the ${cap}-character cap — the end of this entry was dropped.${room}</span>`;
            return;
        }
        status.innerHTML = "";
    };
    paintStatus();

    left.append(nameLabel, badge, status);
    row.appendChild(left);

    const tags = document.createElement("textarea");
    tags.className = "text_pole comfyinject-appearance-tags";
    tags.rows = 2;
    tags.value = entry.tags;
    tags.placeholder = "1girl, long silver hair, red eyes, black coat — or empty to suppress this name";

    const writeTags = (/** @type {string} */ value) => {
        setRegistryEntry(entry.key, { name: entry.name, tags: value, source: "user" });
        saveRegistry();
        // Re-read rather than trusting `value`: the cap may have shortened it, and
        // the row has to report what was stored, not what was typed.
        const stored = readRegistry()[entry.key];
        state.tags = String(stored?.tags ?? "").trim();
        state.source = "user";
        state.truncated = !!stored?.truncated;
        state.truncatedAt = Number(stored?.truncatedAt) || 0;
        badge.innerHTML = renderSourceBadge("user");
        paintStatus();
    };

    tags.addEventListener("input", () => {
        clearTimeout(pendingWrites.get(entry.key));
        pendingWrites.set(entry.key, setTimeout(() => {
            pendingWrites.delete(entry.key);
            writeTags(tags.value.trim());
        }, EDIT_DEBOUNCE_MS));
    });
    row.appendChild(tags);

    const suppress = document.createElement("div");
    suppress.className = "menu_button comfyinject-appearance-button";
    suppress.title = `Suppress ${entry.name}: keep the row but send nothing, and stop seeding from ever writing it again`;
    suppress.innerHTML = `<i class="fa-solid fa-eye-slash"></i>`;
    suppress.addEventListener("click", () => {
        clearTimeout(pendingWrites.get(entry.key));
        pendingWrites.delete(entry.key);
        if (!tags.value.trim()) {
            toastr.info(`${entry.name} is already suppressed.`, "ComfyInject");
            return;
        }
        tags.value = "";
        writeTags("");
    });
    row.appendChild(suppress);

    const remove = document.createElement("div");
    remove.className = "menu_button comfyinject-appearance-button";
    // Said plainly, because the two buttons look interchangeable and are not: a
    // deleted row is rewritten by the next seeding pass, a suppressed one is not.
    remove.title = `Remove ${entry.name} from the registry. Seeding may write it again — use suppress to refuse it for good`;
    remove.innerHTML = `<i class="fa-solid fa-trash-can"></i>`;
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
 *
 * A name with no tags adds a suppressed row, which is how a card that is a world,
 * a narrator or a game master gets refused *before* the first seeding pass invents
 * a body for it rather than after.
 *
 * @param {() => void} rerender
 * @returns {HTMLElement}
 */
function buildAddRow(rerender) {
    const row = document.createElement("div");
    row.className = "comfyinject-appearance-add";

    const name = document.createElement("input");
    name.className = "text_pole comfyinject-appearance-name";
    name.type = "text";
    name.placeholder = "Character name";

    const tags = document.createElement("textarea");
    tags.className = "text_pole comfyinject-appearance-tags";
    tags.rows = 2;
    tags.placeholder = "Appearance tags, or empty to suppress the name";

    const add = document.createElement("div");
    add.className = "menu_button menu_button_icon comfyinject-appearance-button";
    add.innerHTML = `<i class="fa-solid fa-plus"></i><span>Add</span>`;
    add.addEventListener("click", () => {
        const characterName = name.value.trim();
        const characterTags = tags.value.trim();
        if (!characterName) {
            toastr.warning("A name is needed.", "ComfyInject");
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
        if (!characterTags) {
            toastr.info(`${characterName} is suppressed — nothing will be sent for that name.`, "ComfyInject");
        }
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
    toastr.info("Reading the character cards, lorebooks and this chat…", "ComfyInject");
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
    injectStyle("comfyinject-appearance-styles", ROW_CSS);

    const render = () => {
        const body = openOverlay("Appearance Registry", [
            { label: "Seed from card, lore + chat", icon: "fa-wand-magic-sparkles", onClick: () => runSeeding(render) },
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
            `Stored with this chat only — a new chat on the same character starts empty. ${entries.length} entry(ies), up to ${registryMaxChars()} characters each. Automatic seeding for this chat: ${describeSeedingState()}.`,
            "Editing a row marks it <b>user</b>, and a user row is never overwritten by seeding or by a generated image.",
            "Emptying a row's tags — or the <b>eye</b> button — <b>suppresses</b> that name: the row stays, nothing is sent for it, and seeding will not write it again. That is what a card that is a world, a narrator or a game master rather than a person wants. The <b>bin</b> only deletes, and the next seeding pass may put the row straight back.",
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
