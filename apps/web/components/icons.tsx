import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement>;

export function ArrowUpRight(props: Props) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="M7 17 17 7M8 7h9v9" /></svg>;
}

export function ArrowRight(props: Props) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="M5 12h14m-5-5 5 5-5 5" /></svg>;
}

export function Check(props: Props) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="m5 12 4 4L19 6" /></svg>;
}

export function Download(props: Props) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="M12 3v12m-5-5 5 5 5-5M5 21h14" /></svg>;
}

export function Laptop(props: Props) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><rect x="4" y="4" width="16" height="12" rx="1.5" /><path d="M2 20h20M9 20v-1h6v1" /></svg>;
}

export function Phone(props: Props) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M10 5h4m-3 14h2" /></svg>;
}

export function Shield(props: Props) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="M12 3 4.5 6v5c0 4.8 2.9 8.5 7.5 10 4.6-1.5 7.5-5.2 7.5-10V6L12 3Z" /><path d="m9 12 2 2 4-5" /></svg>;
}

export function LinkIcon(props: Props) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="m10 13 4-4m-6.5 8.5-1 1a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M16.5 6.5l1-1a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" /></svg>;
}

export function BridgeMark(props: Props) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="M5 5h7a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h8" /><circle cx="4" cy="5" r="1.35" fill="currentColor" stroke="none" /><circle cx="20" cy="19" r="1.35" fill="currentColor" stroke="none" /></svg>;
}

export function Bolt(props: Props) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z" /></svg>;
}

export function Menu(props: Props) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
}

export function GoogleMark(props: Props) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path fill="#4285F4" stroke="none" d="M21.35 12.18c0-.71-.06-1.4-.18-2.07H12v3.91h5.24a4.48 4.48 0 0 1-1.94 2.94v2.54h3.14c1.84-1.69 2.91-4.18 2.91-7.32Z" /><path fill="#34A853" stroke="none" d="M12 21.7c2.63 0 4.83-.87 6.44-2.2l-3.14-2.54c-.87.58-1.98.92-3.3.92-2.53 0-4.68-1.71-5.45-4.01H3.31v2.62A9.73 9.73 0 0 0 12 21.7Z" /><path fill="#FBBC05" stroke="none" d="M6.55 13.87A5.85 5.85 0 0 1 6.25 12c0-.65.11-1.28.3-1.87V7.51H3.31A9.72 9.72 0 0 0 2.3 12c0 1.62.39 3.15 1.01 4.49l3.24-2.62Z" /><path fill="#EA4335" stroke="none" d="M12 6.12c1.43 0 2.71.49 3.72 1.45l2.79-2.79C16.82 3.21 14.63 2.3 12 2.3a9.73 9.73 0 0 0-8.69 5.21l3.24 2.62c.77-2.3 2.92-4.01 5.45-4.01Z" /></svg>;
}
