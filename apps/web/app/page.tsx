import Link from "next/link";
import { ArrowRight, ArrowUpRight, Bolt, Check, Laptop, LinkIcon, Shield } from "@/components/icons";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

const providers = [
  { id: "codex", name: "Codex", glyph: "C" },
  { id: "opencode", name: "OpenCode", glyph: "O" },
  { id: "grok", name: "Grok Build", glyph: "G" },
  { id: "pi", name: "Pi", glyph: "P" },
  { id: "omp", name: "OMP", glyph: "M" },
  { id: "qwen", name: "Qwen Code", glyph: "Q" },
  { id: "goose", name: "goose", glyph: "g" },
  { id: "kimi", name: "Kimi Code", glyph: "K" },
  { id: "hermes", name: "Hermes Agent", glyph: "H" },
  { id: "cline", name: "Cline", glyph: "L" },
  { id: "copilot", name: "Copilot CLI", glyph: "CP" },
  { id: "direct", name: "Direct API", glyph: "API" },
];

const heroProviders = providers.slice(0, 3);

const faqs = [
  ["Do I need a Tethoq account or subscription?", "No. The Windows preview is free and open source. Download Desktop or Bridge and use the provider tools and accounts you already have. Your provider's own usage charges still apply."],
  ["Does Tethoq run my coding agents in the cloud?", "No. Your coding agents run on your computer. Tethoq Desktop brings them into one workspace, and Bridge connects approved devices to that local setup."],
  ["Can I connect from my phone?", "Phone access is optional and requires the Android client. Bridge provides short-lived QR pairing through a temporary direct tunnel, or you can configure your own relay. A Tethoq-hosted mobile relay service is not included in this preview."],
  ["Which tools can I use?", "Tethoq includes twelve built-in routes across installed coding harnesses and Direct API models. Exact features still depend on what each provider exposes."],
  ["Can I add another model or harness?", "Yes. Tethoq Desktop has a provider-neutral connector SDK. Community connectors are independent user-installed software: review the code and permissions, confirm your provider use is authorized, and approve the exact connector fingerprint locally."],
  ["Which Windows download should I use?", "Tethoq Desktop is the complete coding harness and already includes the bridge. Choose Bridge only when you want to connect the coding-agent tools already installed on your computer without the desktop workspace."],
];

function AgentCanvas() {
  return (
    <div className="agent-canvas" aria-label="Illustration of a phone connected to coding agents on a computer">
      <div className="canvas-grid" />
      <div className="orbit orbit-one" /><div className="orbit orbit-two" />
      <div className="laptop-card">
        <div className="laptop-top"><span /><span /><span /><b>bridge.local</b></div>
        <div className="agent-list">
          {heroProviders.map((provider, index) => <div className="agent-row" key={provider.name}><span className={`provider-mark provider-mark-${provider.id}`} aria-hidden="true">{provider.glyph}</span><div><strong>{provider.name}</strong><small>{index === 0 ? "Working" : index === 1 ? "Ready" : "Connected"}</small></div><i className={index === 0 ? "working" : ""} /></div>)}
        </div>
        <div className="laptop-base" />
      </div>
      <div className="phone-card">
        <div className="phone-notch" />
        <div className="phone-ui"><small>TETHOQ</small><h3>Agent update</h3><div className="phone-message">Validation passed. The dashboard changes are ready to review.</div><div className="phone-actions"><span>Approve</span><b>Reply</b></div></div>
      </div>
      <div className="signal-line line-one"><i /><i /><i /></div>
      <div className="secure-pill"><Shield /><span>Encrypted link</span></div>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="hero section-shell">
          <div className="hero-copy">
            <p className="eyebrow"><span /> Open-source preview</p>
            <h1>Your coding agents,<br /><em>within reach.</em></h1>
            <p className="hero-lede">Bring your coding agents, conversations, and tools into one Windows workspace. Install the full Desktop app with Bridge included, or add Bridge to the setup you already use.</p>
            <div className="hero-actions"><Link className="button button-primary" href="/download">Download for Windows <ArrowRight /></Link><Link className="button button-ghost" href="/#how-it-works">See how it works <ArrowUpRight /></Link></div>
            <p className="hero-footnote"><Check /> Free Windows preview. No Tethoq account required.</p>
          </div>
          <AgentCanvas />
        </section>

        <section className="provider-strip" aria-label="Supported agent harnesses"><div className="section-shell"><p>Built to meet your existing tools</p><div>{providers.map((provider) => <span key={provider.name}><i className={`provider-mark provider-mark-small provider-mark-${provider.id}`} aria-hidden="true">{provider.glyph}</i>{provider.name}</span>)}</div></div></section>

        <section className="story section-shell" id="how-it-works">
          <div className="section-heading"><p className="eyebrow">Your tools. One workspace.</p><h2>Start with the setup<br />you already use.</h2><p>Keep your coding agents and projects on your computer, with optional phone access through Bridge.</p></div>
          <div className="steps">
            <article><span>01</span><div className="step-icon"><Laptop /></div><h3>Install Tethoq</h3><p>Choose the full Desktop app with the bridge included, or add Bridge only beside your existing tools.</p></article>
            <article><span>02</span><div className="step-icon"><LinkIcon /></div><h3>Connect your tools</h3><p>Use the coding harnesses, provider accounts, and models already configured on your computer.</p></article>
            <article><span>03</span><div className="step-icon"><Bolt /></div><h3>Start a task</h3><p>Work in Desktop, follow agent progress, and handle questions and approvals in one place.</p></article>
          </div>
        </section>

        <section className="feature-band">
          <div className="section-shell feature-layout">
            <div className="terminal-scene" aria-hidden="true"><div className="terminal"><div className="terminal-bar"><span /><span /><span /><b>Tethoq Bridge</b></div><pre><i>›</i> tethoq bridge start{"\n"}<em>✓</em> Local bridge ready{"\n"}<em>✓</em> Codex connected{"\n"}<em>✓</em> Grok Build connected{"\n"}<em>✓</em> OpenCode connected{"\n"}<b>●</b> Waiting securely for your devices</pre></div><div className="phone-sliver"><span>Computer online</span><strong>Studio PC</strong><small>12 built-in routes</small></div></div>
            <div className="feature-copy"><p className="eyebrow">Local by design</p><h2>Your computer stays the workspace.</h2><p>Tethoq coordinates access. Your repositories, command-line tools, and agent processes remain where you installed them.</p><ul><li><Check />No repository upload required</li><li><Check />Provider-native capabilities stay explicit</li><li><Check />Paired devices use revocable credentials</li></ul><Link className="inline-link" href="/#security">Read the security model <ArrowRight /></Link></div>
          </div>
        </section>

        <section className="security section-shell" id="security">
          <div className="security-copy"><p className="eyebrow">Control stays with you</p><h2>Access you can see<br />and take back.</h2><p>Your computer owns its Bridge identity. Approve each paired device explicitly and revoke its access when you no longer need it.</p></div>
          <div className="security-grid"><article><Shield /><h3>Local workspace</h3><p>Your repositories, provider tools, and agent processes stay on your computer.</p></article><article><Bolt /><h3>Short-lived pairing</h3><p>QR pairing codes expire and can only be used once. Pairing starts when you request it.</p></article><article><LinkIcon /><h3>Signed actions</h3><p>Bridge verifies paired-device signatures before accepting actions such as replies and approvals.</p></article></div>
        </section>

        <section className="faq section-shell" id="faq"><div className="faq-heading"><p className="eyebrow">Questions, answered</p><h2>The practical details.</h2></div><div className="faq-list">{faqs.map(([question, answer]) => <details key={question}><summary>{question}<span>+</span></summary><p>{answer}</p></details>)}</div></section>

        <section className="final-cta"><div className="section-shell"><div><p className="eyebrow">Ready when you are</p><h2>Your next task,<br />in one workspace.</h2></div><div><p>Start with the complete desktop harness, or download only the bridge for your existing setup.</p><Link className="button button-primary" href="/download">Choose a download <ArrowRight /></Link></div></div></section>
      </main>
      <SiteFooter />
    </>
  );
}
