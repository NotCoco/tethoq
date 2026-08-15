import { isValidElement, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CopyIcon } from "./icons";

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
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Keep Markdown links useful without allowing executable or local-file URLs. */
export const safeMarkdownUrl: UrlTransform = (value, key) => {
  if (key === "src") return markdownImageUrl(value) ?? "";
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
    a: ({ children: label, href, title }) => href ? <a href={href} title={title} onClick={(event) => {
      event.preventDefault();
      onLinkOpen?.(href);
    }}>{label}</a> : <span className="rich-link-unavailable">{label}</span>,
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
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} skipHtml urlTransform={safeMarkdownUrl} components={components}>{children}</ReactMarkdown>
  </div>;
}
