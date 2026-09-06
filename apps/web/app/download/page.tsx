import type { Metadata } from "next";
import { BridgeMark, Check, Download, Laptop, Shield } from "@/components/icons";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import {
  bridgeChecksumUrl,
  bridgeWindowsDownloadUrl,
  desktopChecksumUrl,
  desktopWindowsDownloadUrl,
} from "@/lib/config";

export const metadata: Metadata = {
  title: "Download Tethoq for Windows",
  description: "Download Tethoq Desktop with the bridge included, or install the standalone Tethoq Bridge.",
};

interface DownloadActionProps {
  readonly href: string | null;
  readonly label: string;
}

function DownloadAction({ href, label }: DownloadActionProps) {
  if (!href) {
    return <span className="button button-disabled"><Download /> Download unavailable</span>;
  }
  return <a className="button button-primary" href={href}><Download /> {label}</a>;
}

export default function DownloadPage() {
  const desktopDownload = desktopWindowsDownloadUrl();
  const bridgeDownload = bridgeWindowsDownloadUrl();
  const desktopChecksum = desktopChecksumUrl();
  const bridgeChecksum = bridgeChecksumUrl();

  return (
    <>
      <SiteHeader />
      <main className="download-page">
        <section className="download-hero section-shell">
          <div>
            <p className="eyebrow">Free Windows preview</p>
            <h1>Choose the way<br /><em>you want to work.</em></h1>
            <p>Install the complete desktop coding harness, or add the standalone bridge beside the agent tools you already use. The desktop app already includes the bridge. No Tethoq account or subscription is required.</p>
            <div className="download-jump-links" aria-label="Download choices">
              <a href="#desktop">Desktop app</a>
              <a href="#bridge">Bridge only</a>
            </div>
          </div>
          <aside className="download-privacy-note">
            <Shield />
            <div><strong>Local and explicit by default</strong><p>Browser profile data stays in Tethoq&apos;s own app profile. Workflow capture stays off until you press Record, stops when you press Stop, and is never uploaded implicitly. Preview installers are checksum-verifiable but not yet Authenticode-signed.</p></div>
          </aside>
        </section>

        <section className="download-options section-shell" aria-label="Tethoq downloads">
          <article className="download-option download-option-featured" id="desktop">
            <div className="download-option-topline"><span className="platform-icon"><Laptop /></span><span className="recommendation">Recommended</span></div>
            <p className="eyebrow">Complete Windows app</p>
            <h2>Tethoq Desktop</h2>
            <p className="download-option-lede">The full coding workspace with your harnesses, model picker, persistent in-app Chromium browser and opt-in workflow recording in one clean desktop experience.</p>
            <ul className="download-feature-list">
              <li><Check />Tethoq Bridge included and ready to run</li>
              <li><Check />Twelve built-in harness and Direct API routes</li>
              <li><Check />Provider-neutral SDK for user-installed community connectors</li>
              <li><Check />App-owned browser profile; no Chrome profile import</li>
              <li><Check />Local workflow library with explicit Record and Stop</li>
            </ul>
            <p className="installer-notice"><strong>Community connectors require local review and explicit approval.</strong> They are independent executable code, not reviewed or supported by Tethoq. Authors and users are responsible for provider authorization and terms; credentials stay directly with the provider tool or connector.</p>
            <div className="download-option-actions">
              <DownloadAction href={desktopDownload} label="Download Desktop" />
              {desktopChecksum && <a className="checksum-link" href={desktopChecksum}>Verify checksum</a>}
            </div>
            {!desktopDownload && <p className="installer-notice">Check <a href="https://github.com/NotCoco/tethoq/releases">GitHub releases</a> for Desktop availability.</p>}
            <dl><div><dt>Platform</dt><dd>Windows 10/11 · x64</dd></div><div><dt>Package</dt><dd>Desktop installer</dd></div><div><dt>Bridge</dt><dd>Included</dd></div></dl>
          </article>

          <article className="download-option" id="bridge">
            <div className="download-option-topline"><span className="platform-icon platform-icon-bridge"><BridgeMark /></span><span className="recommendation recommendation-muted">Lightweight</span></div>
            <p className="eyebrow">Existing harness setup</p>
            <h2>Tethoq Bridge</h2>
            <p className="download-option-lede">Choose this when you only want Tethoq&apos;s local phone and device connection beside the coding-agent tools already installed on your computer.</p>
            <ul className="download-feature-list">
              <li><Check />Small tray-first app with the Bridge engine included</li>
              <li><Check />No system-wide runtime installation required</li>
              <li><Check />Twelve built-in harness and Direct API routes</li>
              <li><Check />Local identity and revocable device pairing</li>
            </ul>
            <div className="download-option-actions">
              <DownloadAction href={bridgeDownload} label="Download Bridge" />
              {bridgeChecksum && <a className="checksum-link" href={bridgeChecksum}>Verify checksum</a>}
            </div>
            {!bridgeDownload && <p className="installer-notice">Check <a href="https://github.com/NotCoco/tethoq/releases">GitHub releases</a> for Bridge availability.</p>}
            <dl><div><dt>Platform</dt><dd>Windows 10/11 · x64</dd></div><div><dt>Package</dt><dd>Bridge installer</dd></div><div><dt>Desktop UI</dt><dd>Not included</dd></div></dl>
          </article>
        </section>

        <section className="install-steps section-shell">
          <article><span>1</span><h3>Download the right package</h3><p>Use Desktop for the complete harness. Use Bridge only if you already have the coding environment you want.</p></article>
          <article><span>2</span><h3>Verify and install</h3><p>Check the published SHA-256, then install Desktop or the lightweight Bridge companion.</p></article>
          <article><span>3</span><h3>Open your workspace</h3><p>Use your existing coding tools and provider accounts. Phone access is optional and requires the Android client and Bridge pairing; the hosted relay service is not part of this preview.</p></article>
        </section>

        <section className="requirements section-shell">
          <div><Shield /><h2>Privacy controls you can see.</h2></div>
          <ul><li><Check />Chromium uses a dedicated Tethoq profile</li><li><Check />Manual sign-in only; no automatic browser-profile import</li><li><Check />Workflow recording is dormant outside Record and Stop</li><li><Check />Community connectors require local review and explicit approval</li><li><Check />Local captures remain inspectable and deletable</li></ul>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
