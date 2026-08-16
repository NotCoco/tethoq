import { isValidElement, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CopyIcon } from "./icons";
import { LocalPathAction, type LocalOpenLocation } from "./LocalOpen";

export interface RichTextImage {
  dataUrl: string;
  name: string;
}

function markdownImageUrl(value: string): string | undefined {
  if (/^data:image\/[a-z0-9.+-]+;base64,/iu.test(value) || /^https:\/\//iu.test(value)) return value;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return url.protocol === "http:" && loopback ? value : undefined;
  } catch {
    return undefined;
  }
}

function markdownLinkUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || (url.protocol === "file:" && (url.hostname === "" || url.hostname === "localhost")) ? value : undefined;
  } catch {
    return undefined;
  }
}

const LOCAL_PATH_SCHEME = "tethoq-local:";
const LOCAL_PATH_PATTERN = /(["'])(file:\/\/\/[^"]+?|[a-z]:[\\/][^"'\r\n]+?|\/(?:Users|home|tmp|var|opt|mnt|Volumes|workspace|workspaces)\/[^"'\r\n]+?)\1|file:\/\/\/[^\s<>"'`]+|[a-z]:[\\/](?:[^\\/\r\n<>"'`]+[\\/])*[^\\/\r\n<>"'`]*?\.[a-z0-9]{1,16}(?::\d+(?::\d+)?)?(?=$|[\s,;!?)\]])|[a-z]:[\\/][^\s<>"'`]+|\/(?:Users|home|tmp|var|opt|mnt|Volumes|workspace|workspaces)\/[^\s<>"'`]+/giu;

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

function trimBarePath(value: string): string {
  let next = value;
  while (/[.,;!?]/u.test(next.at(-1) ?? "")) next = next.slice(0, -1);
  while ((next.endsWith(")") && (next.match(/\(/gu)?.length ?? 0) < (next.match(/\)/gu)?.length ?? 0))
    || (next.endsWith("]") && (next.match(/\[/gu)?.length ?? 0) < (next.match(/\]/gu)?.length ?? 0))
    || (next.endsWith("}") && (next.match(/\{/gu)?.length ?? 0) < (next.match(/\}/gu)?.length ?? 0))) next = next.slice(0, -1);
  return next;
}

function pathWithPosition(path: string): LocalOpenLocation | null {
  let localPath = path;
  if (/^file:\/\//iu.test(localPath)) {
    try {
      const url = new URL(localPath);
      if (url.protocol !== "file:" || (url.hostname !== "" && url.hostname !== "localhost")) return null;
      localPath = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//iu.test(localPath)) localPath = localPath.slice(1);
    } catch { return null; }
  }
  const positioned = localPath.match(/^(.*?):(\d+)(?::(\d+))?$/u);
  const candidate = positioned?.[1] ?? localPath;
  const windows = /^[a-z]:[\\/]/iu.test(candidate);
  const posix = /^\/(?:Users|home|tmp|var|opt|mnt|Volumes|workspace|workspaces)\//u.test(candidate);
  if (!windows && !posix) return null;
  const line = positioned ? Number(positioned[2]) : undefined;
  const column = positioned?.[3] === undefined ? undefined : Number(positioned[3]);
  return {
    path: candidate,
    ...(line !== undefined && Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    ...(column !== undefined && Number.isSafeInteger(column) && column > 0 ? { column } : {}),
  };
}

export function localPathHref(location: LocalOpenLocation): string {
  return `${LOCAL_PATH_SCHEME}${encodeURIComponent(JSON.stringify(location))}`;
}

export function localLocationFromHref(value: string): LocalOpenLocation | null {
  if (value.startsWith(LOCAL_PATH_SCHEME)) {
    try {
      const parsed = JSON.parse(decodeURIComponent(value.slice(LOCAL_PATH_SCHEME.length))) as Record<string, unknown>;
      if (typeof parsed.path !== "string") return null;
      return pathWithPosition(`${parsed.path}${typeof parsed.line === "number" ? `:${parsed.line}${typeof parsed.column === "number" ? `:${parsed.column}` : ""}` : ""}`);
    } catch { return null; }
  }
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* Invalid escapes remain untrusted and fail below. */ }
  if (/^\/[a-z]:\//iu.test(decoded)) decoded = decoded.slice(1);
  return /^file:\/\//iu.test(decoded) || /^[a-z]:[\\/]/iu.test(decoded) || /^\/(?:Users|home|tmp|var|opt|mnt|Volumes|workspace|workspaces)\//u.test(decoded)
    ? pathWithPosition(decoded)
    : null;
}

export function localPathSegments(value: string): readonly { readonly text: string; readonly location?: LocalOpenLocation }[] {
  const segments: { text: string; location?: LocalOpenLocation }[] = [];
  let cursor = 0;
  LOCAL_PATH_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(LOCAL_PATH_PATTERN)) {
    const whole = match[0];
    const quote = match[1] ?? "";
    const raw = quote ? whole.slice(1, -1) : trimBarePath(whole);
    const location = pathWithPosition(raw);
    if (!location || match.index === undefined) continue;
    const linkStart = match.index + (quote ? 1 : 0);
    if (linkStart > cursor) segments.push({ text: value.slice(cursor, linkStart) });
    segments.push({ text: raw, location });
    cursor = linkStart + raw.length;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor) });
  return segments.length ? segments : [{ text: value }];
}

function remarkLocalPaths() {
  return (tree: MarkdownNode): void => {
    const visit = (node: MarkdownNode): void => {
      if (!node.children || node.type === "link" || node.type === "code") return;
      const next: MarkdownNode[] = [];
      for (const child of node.children) {
        if (child.type === "text" && typeof child.value === "string") {
          next.push(...localPathSegments(child.value).map((segment) => segment.location
            ? { type: "link", url: localPathHref(segment.location), children: [{ type: "text", value: segment.text }] }
            : { type: "text", value: segment.text }));
          continue;
        }
        if (child.type === "inlineCode" && typeof child.value === "string") {
          const location = pathWithPosition(child.value.trim());
          if (location) {
            next.push({ type: "link", url: localPathHref(location), children: [child] });
            continue;
          }
        }
        visit(child);
        next.push(child);
      }
      node.children = next;
    };
    visit(tree);
  };
}

/** Keep Markdown links useful without allowing executable or local-file URLs. */
export const safeMarkdownUrl: UrlTransform = (value, key) => {
  if (key === "src") return markdownImageUrl(value) ?? "";
  if (key === "href" && localLocationFromHref(value)) return value;
  if (key === "href") return markdownLinkUrl(defaultUrlTransform(value)) ?? "";
  return "";
};

function nestedText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(nestedText).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return nestedText(value.props.children);
  return "";
}

/** Markdown appends one structural newline to fenced code; do not copy its language label or surrounding UI. */
export function codeBlockText(value: ReactNode): string {
  return nestedText(value).replace(/\n$/u, "");
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const text = codeBlockText(children);
  const copy = async (button: HTMLButtonElement) => {
    const label = button.querySelector("span");
    const status = button.nextElementSibling;
    const previousTimer = codeCopyResetTimers.get(button);
    if (previousTimer !== undefined) clearTimeout(previousTimer);
    try {
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard) throw new Error("Clipboard access is unavailable");
      await clipboard.writeText(text);
      button.setAttribute("aria-label", "Code copied");
      if (label) label.textContent = "Copied";
      if (status) status.textContent = "Code copied to clipboard";
    } catch {
      button.setAttribute("aria-label", "Code copy failed");
      if (label) label.textContent = "Copy failed";
      if (status) status.textContent = "Code could not be copied";
    }
    codeCopyResetTimers.set(button, setTimeout(() => {
      if (!button.isConnected) return;
      button.setAttribute("aria-label", "Copy code");
      if (label) label.textContent = "Copy";
      if (status) status.textContent = "";
      codeCopyResetTimers.delete(button);
    }, 1_800));
  };
  return <div className="rich-code-block">
    <pre>{children}</pre>
    <button type="button" className="rich-code-copy" aria-label="Copy code" onClick={(event) => void copy(event.currentTarget)}><CopyIcon /><span>Copy</span></button>
    <span className="rich-code-copy-status" role="status" aria-live="polite" />
  </div>;
}

const codeCopyResetTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

export function RichText({ children, onImageOpen, onLinkOpen }: {
  children: string;
  onImageOpen?: ((image: RichTextImage) => void) | undefined;
  onLinkOpen?: ((url: string) => void) | undefined;
}) {
  const components: Components = {
    pre: ({ children: code }) => <CodeBlock>{code}</CodeBlock>,
    a: ({ children: label, href, title }) => {
      const local = href ? localLocationFromHref(href) : null;
      if (local) return <LocalPathAction location={local} className="rich-local-path">{label}</LocalPathAction>;
      return href ? <a href={href} title={title} onClick={(event) => {
      event.preventDefault();
      onLinkOpen?.(href);
      }}>{label}</a> : <span className="rich-link-unavailable">{label}</span>;
    },
    table: ({ children: tableChildren }) => <div className="rich-table-scroll"><table>{tableChildren}</table></div>,
    img: ({ src, alt, title }) => {
      const safeSource = markdownImageUrl(typeof src === "string" ? src : "");
      const name = alt?.trim() || title?.trim() || "Image";
      if (!safeSource) return alt ? <span className="rich-image-unavailable">{alt}</span> : null;
      return <button type="button" className="rich-text-image" aria-label={`Expand ${name}`} onClick={() => onImageOpen?.({ dataUrl: safeSource, name })}>
        <img src={safeSource} alt={alt ?? ""} title={title} referrerPolicy="no-referrer" />
      </button>;
    },
  };
  return <div className="rich-text">
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkLocalPaths]} skipHtml urlTransform={safeMarkdownUrl} components={components}>{children}</ReactMarkdown>
  </div>;
}
