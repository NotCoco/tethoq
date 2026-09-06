import Link from "next/link";
import { Brand } from "./brand";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="nav-shell">
        <Brand />
        <nav className="desktop-nav" aria-label="Primary navigation">
          <Link href="/#how-it-works">How it works</Link>
          <Link href="/#security">Security</Link>
          <Link href="/#faq">FAQ</Link>
          <Link href="/download">Desktop &amp; Bridge</Link>
        </nav>
        <div className="nav-actions">
          <a className="text-link" href="https://github.com/NotCoco/tethoq">GitHub</a>
          <Link className="button button-small button-primary" href="/download">Download</Link>
        </div>
      </div>
    </header>
  );
}
