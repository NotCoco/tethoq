import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

/** More corrections than this stops being a list the eye can scan at a right-click. */
const maximumSpellingSuggestions = 5;

/**
 * What the menu needs the surrounding window to do. Keeping these as callbacks
 * leaves this module free of Electron singletons, so the menu's shape can be
 * asserted in an ordinary test instead of only through a real right-click.
 */
export interface ContextMenuActions {
  readonly replaceMisspelling: (word: string) => void;
  readonly learnSpelling: (word: string) => void;
  readonly copyText: (text: string) => void;
  readonly copyImage: (x: number, y: number) => void;
  readonly allowWebUrl: (url: string) => boolean;
}

/**
 * The editing items a right-click offers wherever text can be selected or typed.
 *
 * Outside an editable field Chromium fills `editFlags` optimistically: a plain
 * link answers true to canCut and canPaste with nothing selected. So which items
 * exist is decided from `isEditable`, `selectionText`, and the media kind, and
 * the flags only enable what is already there. A password field is safe by the
 * same route: it reports `isEditable` with canCopy and canCut false, so its
 * masked value cannot be lifted out of the menu.
 *
 * An empty result means this spot has nothing to offer. The caller shows no menu
 * at all rather than a single inert row.
 */
export function contextMenuTemplate(
  params: ContextMenuParams,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (params.misspelledWord !== "") {
    const suggestions = params.dictionarySuggestions.slice(0, maximumSpellingSuggestions);
    for (const suggestion of suggestions) {
      template.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) });
    }
    // Saying the checker found nothing is more honest than a menu that silently
    // omits the corrections the red underline just promised.
    if (suggestions.length === 0) template.push({ label: "No spelling suggestions", enabled: false });
    template.push({ type: "separator" });
    template.push({ label: "Add to dictionary", click: () => actions.learnSpelling(params.misspelledWord) });
  }
  const editing: MenuItemConstructorOptions[] = [];
  if (params.isEditable) {
    editing.push(
      { role: "undo", enabled: params.editFlags.canUndo },
      { role: "redo", enabled: params.editFlags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );
  } else if (params.selectionText !== "") {
    editing.push({ role: "copy", enabled: params.editFlags.canCopy });
  }
  const targets: MenuItemConstructorOptions[] = [];
  if (params.linkURL !== "" && actions.allowWebUrl(params.linkURL)) {
    targets.push({ label: "Copy link", click: () => actions.copyText(params.linkURL) });
  }
  if (params.mediaType === "image" && params.hasImageContents) {
    targets.push({ label: "Copy image", click: () => actions.copyImage(params.x, params.y) });
  }
  for (const group of [editing, targets]) {
    if (group.length === 0) continue;
    if (template.length > 0) template.push({ type: "separator" });
    template.push(...group);
  }
  return template;
}
