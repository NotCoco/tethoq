import { forwardRef, useEffect, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent } from "react";

export interface MeshBadge {
  token: string;
  providerId: string;
  name: string;
  model: string;
  reasoning: string;
}

interface TextSelection {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
}
export type ComposerTextInput = HTMLTextAreaElement | (HTMLDivElement & TextSelection);

interface Props {
  value: string;
  badges: readonly MeshBadge[];
  placeholder: string;
  expanded: boolean;
  controls?: string | undefined;
  activeDescendant?: string | undefined;
  onChange: (value: string) => void;
  onSelectionChange?: (start: number, end: number) => void;
  onKeyDown: (event: KeyboardEvent<ComposerTextInput>) => void;
  onPaste: (event: ClipboardEvent<ComposerTextInput>) => void;
  onCopy: (event: ClipboardEvent<ComposerTextInput>) => unknown;
  onCut: (event: ClipboardEvent<ComposerTextInput>) => void;
  onEdit: (token: string) => void;
  onRemove: (token: string) => void;
}

/** Chips are atomic characters in the draft, but real, full-width DOM elements. */
function readValue(root: Node, complete = true): string {
  let value = "";
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) { value += node.textContent ?? ""; continue; }
    if (!(node instanceof HTMLElement)) continue;
    if (node.dataset.meshToken) { value += node.dataset.meshToken; continue; }
    if (node.tagName === "BR") { value += "\n"; continue; }
    if ((node.tagName === "DIV" || node.tagName === "P") && value && !value.endsWith("\n")) value += "\n";
    value += readValue(node, false);
  }
  // Chromium keeps a final BR solely to paint the caret on an empty line.
  if (complete && root.lastChild instanceof HTMLBRElement) value = value.slice(0, -1);
  return value.replace(/\u00a0/gu, " ");
}

function selectedOffsets(root: HTMLElement): [number, number] {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return [0, 0];
  const range = selection.getRangeAt(0);
  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = readValue(prefix.cloneContents(), false).length;
  prefix.setEnd(range.endContainer, range.endOffset);
  return [start, readValue(prefix.cloneContents(), false).length];
}

function selectOffsets(root: HTMLElement, start: number, end: number): void {
  const points: { node: Node; offset: number; index: number }[] = [{ node: root, offset: 0, index: 0 }];
  const indexAt = (node: Node, offset: number) => {
    const prefix = document.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(node, offset);
    return readValue(prefix.cloneContents(), false).length;
  };
  const visit = (parent: Node) => {
    [...parent.childNodes].forEach((node, childIndex) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const cursor = indexAt(node, 0);
        const length = node.textContent?.length ?? 0;
        for (const wanted of [start, end]) if (wanted >= cursor && wanted <= cursor + length) points.push({ node, offset: wanted - cursor, index: wanted });
      } else if (node instanceof HTMLElement && (node.dataset.meshToken || node.tagName === "BR")) {
        points.push({ node: parent, offset: childIndex, index: indexAt(parent, childIndex) });
        points.push({ node: parent, offset: childIndex + 1, index: indexAt(parent, childIndex + 1) });
      } else visit(node);
    });
  };
  visit(root);
  const last = { node: root, offset: root.childNodes.length, index: readValue(root).length };
  const from = points.find((point) => point.index === start) ?? last;
  const to = points.find((point) => point.index === end) ?? last;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

function writeValue(root: HTMLElement, value: string, badges: readonly MeshBadge[]): void {
  const fragment = document.createDocumentFragment();
  let text = "";
  const flushText = () => { if (text) fragment.append(document.createTextNode(text)); text = ""; };
  for (const character of value) {
    const badge = badges.find((candidate) => candidate.token === character);
    if (!badge) { text += character; continue; }
    flushText();
    const widget = document.createElement("span");
    widget.className = "composer-mesh-widget";
    widget.contentEditable = "false";
    widget.dataset.meshToken = badge.token;
    widget.dataset.providerId = badge.providerId;
    const body = document.createElement("button");
    body.type = "button";
    body.className = "composer-mesh-widget-body";
    body.dataset.meshAction = "edit";
    body.setAttribute("aria-label", `Edit ${badge.name} target`);
    body.title = `${badge.model}${badge.reasoning ? ` · ${badge.reasoning}` : ""}`;
    const model = document.createElement("span");
    model.className = "composer-mesh-widget-model";
    model.textContent = badge.model;
    body.append(model);
    if (badge.reasoning) {
      const reasoning = document.createElement("span");
      reasoning.className = "composer-mesh-widget-effort";
      reasoning.textContent = ` · ${badge.reasoning}`;
      body.append(reasoning);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "composer-mesh-widget-remove";
    remove.dataset.meshAction = "remove";
    remove.setAttribute("aria-label", `Remove ${badge.name} from mesh`);
    remove.textContent = "×";
    widget.append(body, remove);
    fragment.append(widget);
  }
  flushText();
  if (value.endsWith("\n")) fragment.append(document.createElement("br"));
  root.replaceChildren(fragment);
}

export const ComposerMessageInput = forwardRef<ComposerTextInput, Props>(function ComposerMessageInput(props, forwardedRef) {
  // Keep the rich editor after deleting the last badge so native Undo can
  // restore it. Tasks which never use Mesh keep their existing textarea.
  const rich = useRef(false);
  if (props.badges.length) rich.current = true;
  const richEditor = rich.current;
  const element = useRef<ComposerTextInput | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    if (!richEditor) return;
    const selectionChanged = () => {
      const node = element.current;
      if (node && document.activeElement === node) latest.current.onSelectionChange?.(node.selectionStart, node.selectionEnd);
    };
    document.addEventListener("selectionchange", selectionChanged);
    return () => document.removeEventListener("selectionchange", selectionChanged);
  }, [richEditor]);
  const bind = (node: HTMLTextAreaElement | HTMLDivElement | null) => {
    if (node instanceof HTMLDivElement && !Object.hasOwn(node, "value")) {
      Object.defineProperties(node, {
        value: { get: () => readValue(node), set: (value: string) => writeValue(node, value, latest.current.badges) },
        selectionStart: { get: () => selectedOffsets(node)[0] },
        selectionEnd: { get: () => selectedOffsets(node)[1] },
        setSelectionRange: { value: (start: number, end: number) => selectOffsets(node, start, end) },
      });
    }
    element.current = node as ComposerTextInput | null;
    if (typeof forwardedRef === "function") forwardedRef(element.current);
    else if (forwardedRef) forwardedRef.current = element.current;
  };
  useLayoutEffect(() => {
    const node = element.current;
    if (!(node instanceof HTMLDivElement)) return;
    const widgets = [...node.querySelectorAll<HTMLElement>("[data-mesh-token]")];
    const labelsMatch = widgets.length === props.badges.length && widgets.every((widget) => {
      const badge = props.badges.find((candidate) => candidate.token === widget.dataset.meshToken);
      return badge && widget.querySelector<HTMLButtonElement>(".composer-mesh-widget-body")?.title === `${badge.model}${badge.reasoning ? ` · ${badge.reasoning}` : ""}`;
    });
    if (readValue(node) === props.value && labelsMatch) return;
    const focused = document.activeElement === node;
    const selection = focused ? selectedOffsets(node) : null;
    writeValue(node, props.value, props.badges);
    if (selection) selectOffsets(node, ...selection);
  });
  const accessibility = { id: "composer-message", "aria-label": "Message", "aria-expanded": props.expanded, "aria-controls": props.controls, "aria-activedescendant": props.activeDescendant };
  const selectionChanged = () => { const node = element.current; if (node) props.onSelectionChange?.(node.selectionStart, node.selectionEnd); };
  const inputChanged = () => { const node = element.current; if (node) { selectionChanged(); props.onChange(node.value); } };
  if (!rich.current) return <textarea {...accessibility} ref={bind} value={props.value} rows={1} placeholder={props.placeholder} onChange={inputChanged} onSelect={selectionChanged} onKeyDown={props.onKeyDown} onPaste={props.onPaste} onCopy={props.onCopy} onCut={props.onCut} />;
  return <div {...accessibility} ref={bind} className={`composer-rich-input${props.badges.length ? " composer-inline-mesh" : ""}`} role="textbox" aria-multiline="true" contentEditable suppressContentEditableWarning data-placeholder={props.placeholder}
    onInput={inputChanged} onSelect={selectionChanged}
    onKeyDown={(event) => { if (!event.nativeEvent.isComposing) props.onKeyDown(event as KeyboardEvent<ComposerTextInput>); }}
    onPaste={(event) => {
      props.onPaste(event as ClipboardEvent<ComposerTextInput>);
      if (event.defaultPrevented) return;
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    }}
    onCopy={(event) => props.onCopy(event as ClipboardEvent<ComposerTextInput>)}
    onCut={(event) => props.onCut(event as ClipboardEvent<ComposerTextInput>)}
    onMouseDown={(event) => { if ((event.target as Element).closest("button")) event.preventDefault(); }}
    onClick={(event) => {
      const button = (event.target as Element).closest<HTMLElement>("[data-mesh-action]");
      const token = button?.closest<HTMLElement>("[data-mesh-token]")?.dataset.meshToken;
      if (!token) return;
      if (button!.dataset.meshAction === "remove") props.onRemove(token);
      else props.onEdit(token);
    }} />;
});
