import Link from "next/link";
import { Brand } from "./brand";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-shell">
        <div>
          <Brand />
          <p>Your coding agents, within reach.</p>
        </div>
        <nav aria-label="Footer navigation">
          <Link href="/#how-it-works">How it works</Link>
          <Link href="/#security">Security</Link>
          <Link href="/download">Desktop &amp; Bridge</Link>
          <a href="https://github.com/NotCoco/tethoq">GitHub</a>
        </nav>
        <p className="footer-note">Tethoq is provisional software. Provider names and marks belong to their respective owners. Community connectors are independent and unsupported.</p>
      </div>
    </footer>
  );
}
