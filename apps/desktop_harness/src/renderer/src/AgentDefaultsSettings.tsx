import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopPreferencesState, PreferencesAction } from "@shared/desktop_api";
import { ProviderLogo } from "./components";
import { reasoningLabel } from "./Composer";
import { isAmbiguousSelectionValue, modelCatalogRoute, modelMatchesCatalogQuery, resolveConcreteModelSelection } from "./composer_helpers";
import { CheckIcon, ChevronDownIcon, RefreshIcon, SearchIcon } from "./icons";
import type { DesktopSnapshot, ModelOption, Provider } from "./types";

function selectableModels(providerId: string, models: readonly ModelOption[]): ModelOption[] {
  if (providerId !== "direct") return [...models];
  return models.filter((model) => model.walletKind !== "user_api" || model.apiKeyConfigured === true);
}

function modelGroups(providerId: string, providerName: string, models: readonly ModelOption[]): Array<{ label: string | null; models: ModelOption[] }> {
  if (providerId !== "opencode" && !models.some((model) => model.endpointName)) {
    return [{ label: null, models: [...models] }];
  }
  const groups = new Map<string, ModelOption[]>();
  for (const model of models) {
    const label = providerId === "opencode"
      ? modelCatalogRoute(providerId, providerName, model).label
      : model.endpointName ?? "Other models";
    groups.set(label, [...(groups.get(label) ?? []), model]);
  }
  return [...groups].map(([label, options]) => ({ label, models: options }));
}

function routeLabel(providerId: string, model: ModelOption): string | undefined {
  if (providerId === "direct") {
    return `${model.endpointName ?? "Direct API"} · API key saved`;
  }
  if (providerId === "opencode") {
    const route = modelCatalogRoute(providerId, "OpenCode", model);
    return route.carriedBy ? `${route.label} via ${route.carriedBy}` : route.label;
  }
  if (model.endpointName) return `${model.endpointName} through ${model.source ?? "this agent"}`;
  return undefined;
}

function providerConnectionDetail(provider: Provider, models: readonly ModelOption[]): string | undefined {
  if (provider.id === "direct") {
    const endpoints = [...new Set(models
      .filter((model) => model.walletKind === "user_api" && model.apiKeyConfigured === true)
      .map((model) => model.endpointName)
      .filter((name): name is string => Boolean(name)))];
    if (endpoints.length === 0) return "API key required";
    if (endpoints.length === 1) return `${endpoints[0]} · API key saved`;
    return `${endpoints.length} API providers · keys saved`;
  }
  if (!provider.version) return undefined;
  return provider.version.replace(/^v(?=\d)/iu, "");
}

function compactModelWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
  return `${Math.round(tokens)}`;
}

function modelHasFacts(model: ModelOption): boolean {
  return model.efforts.some((effort) => !isAmbiguousSelectionValue(effort))
    || model.contextWindowTokens !== undefined
    || model.inputPricePerMillion !== undefined
    || model.outputPricePerMillion !== undefined;
}

function AgentModelTip({ providerId, tip }: { providerId: string; tip: { model: ModelOption; rect: DOMRect } | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  const model = tip?.model;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !tip) return;
    const { width, height } = element.getBoundingClientRect();
    const gap = 10;
    // The tip opens toward the page centre and flips right when there is no room left.
    let left = tip.rect.left - width - gap;
    if (left < 8) left = Math.min(tip.rect.right + gap, window.innerWidth - width - 8);
    const top = Math.max(8, Math.min(tip.rect.top + tip.rect.height / 2 - height / 2, window.innerHeight - height - 8));
    setPlacement({ left, top });
  }, [tip]);
  const efforts = model ? [...new Set(model.efforts.filter((effort) => !isAmbiguousSelectionValue(effort)))].map((effort) => reasoningLabel(effort, { providerId, modelId: model.id, displayName: model.name })) : [];
  const contextWindowTokens = model?.contextWindowTokens;
  const inputPrice = model?.inputPricePerMillion;
  const outputPrice = model?.outputPricePerMillion;
  const hasPricing = inputPrice !== undefined || outputPrice !== undefined;
  const hasFacts = model !== undefined && modelHasFacts(model);
  return <div ref={ref} className={`agent-model-tip${hasFacts ? " visible" : ""}`} role="tooltip" style={placement ? { left: placement.left, top: placement.top } : { visibility: "hidden" }}>
    {model && hasFacts ? <>
      <strong>{model.name}</strong>
      {efforts.length ? <span>Efforts · {efforts.join(", ")}</span> : null}
      {contextWindowTokens !== undefined ? <span>Context · {compactModelWindow(contextWindowTokens)} tokens</span> : null}
      {hasPricing ? <span>Per 1M tokens · {inputPrice !== undefined ? `$${inputPrice.toFixed(2)} in` : ""}{inputPrice !== undefined && outputPrice !== undefined ? " · " : ""}{outputPrice !== undefined ? `$${outputPrice.toFixed(2)} out` : ""}</span> : null}
    </> : null}
  </div>;
}

function AgentModelPicker({ providerId, providerName, models, selectedModel, onChange }: {
  providerId: string;
  providerName: string;
  models: readonly ModelOption[];
  selectedModel: ModelOption;
  onChange: (providerId: string, modelId: string, reasoningEffort?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tip, setTip] = useState<{ model: ModelOption; rect: DOMRect } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => {
    if (open) search.current?.focus();
    else setQuery("");
  }, [open]);
  // A short catalogue is faster to read than to filter, so the field only earns
  // its space once scanning the list becomes work.
  const searchable = models.length > 8;
  const needle = query.trim().toLowerCase();
  const matches = needle === "" ? models : models.filter((model) => modelMatchesCatalogQuery(needle, providerId, providerName, model));
  const groups = modelGroups(providerId, providerName, matches);
  const choose = (model: ModelOption) => {
    const next = resolveConcreteModelSelection(models, { modelId: model.id });
    setOpen(false);
    setTip(null);
    if (next) void onChange(providerId, next.modelId, next.reasoningEffort);
  };
  const showTip = (option: HTMLElement, model: ModelOption) => {
    setTip(modelHasFacts(model) ? { model, rect: option.getBoundingClientRect() } : null);
  };
  return <div className="agent-model-picker" ref={root}>
    <button type="button" className="agent-model-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={`Default model for ${providerName}`} onClick={() => { setOpen((current) => !current); setTip(null); }}>
      <span>{selectedModel.name}</span><ChevronDownIcon />
    </button>
    {open ? <div className="agent-model-dropdown">
      {searchable ? <div className="agent-model-search">
        <SearchIcon />
        <input
          ref={search}
          type="text"
          value={query}
          placeholder="Search models"
          aria-label={`Search models for ${providerName}`}
          onChange={(event) => { setQuery(event.target.value); setTip(null); }}
          onKeyDown={(event) => {
            // Escape clears a query first and only closes the picker once the
            // field is already empty, so one keypress never discards both.
            if (event.key === "Escape" && query !== "") { event.stopPropagation(); setQuery(""); }
          }}
        />
      </div> : null}
      <div className="agent-model-scroll" role="listbox" aria-label={`Models for ${providerName}`} onScroll={() => setTip(null)}>
        {matches.length ? groups.map((group, index) => <div className="agent-model-group" key={group.label ?? index} role="group" {...(group.label ? { "aria-label": group.label } : {})}>
          {group.label ? <span className="agent-model-group-label">{group.label}</span> : null}
          {group.models.map((model) => <button key={model.id} type="button" role="option" aria-selected={model.id === selectedModel.id} className="agent-model-option" onPointerEnter={(event) => showTip(event.currentTarget, model)} onPointerLeave={() => setTip(null)} onFocus={(event) => showTip(event.currentTarget, model)} onBlur={() => setTip(null)} onClick={() => choose(model)}>
            <span>{model.name}</span>{model.isDefault ? <small>Default</small> : null}{model.id === selectedModel.id ? <CheckIcon /> : null}
          </button>)}
        </div>) : <p className="agent-model-empty">No model matches that search</p>}
      </div>
    </div> : null}
    {open ? <AgentModelTip providerId={providerId} tip={tip} /> : null}
  </div>;
}

export function AgentDefaultsSettings({ snapshot, preferences, onChange, onGlobalAgentsAction, onReconnect }: {
  snapshot: DesktopSnapshot;
  preferences: DesktopPreferencesState;
  onChange: (providerId: string, modelId: string, reasoningEffort?: string) => Promise<void>;
  onGlobalAgentsAction: (action: PreferencesAction) => Promise<void>;
  onReconnect: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  return <><section className="settings-block agent-defaults" id="agent-defaults">
    <header><div><h2>Agents</h2><p>Your coding tools and their default models.</p></div></header>
    <div className="agent-default-list provider-settings">
      {snapshot.providers.map((provider) => {
        const allModels = snapshot.models[provider.id] ?? [];
        const models = selectableModels(provider.id, allModels);
        const detail = providerConnectionDetail(provider, allModels);
        const configured = preferences.agentDefaults[provider.id];
        const selection = resolveConcreteModelSelection(models, {}, configured);
        const selectedModel = models.find((model) => model.id === selection?.modelId);
        const efforts = selectedModel
          ? [...new Set(selectedModel.efforts.filter((effort) => !isAmbiguousSelectionValue(effort)))]
          : [];
        const selectedEffort = selection?.reasoningEffort && efforts.includes(selection.reasoningEffort)
          ? selection.reasoningEffort
          : efforts[0];
        return <article key={provider.id}>
          <div className="agent-default-identity">
            <ProviderLogo providerId={provider.id} provider={provider} size={30}/>
            <span><strong>{provider.name}</strong>{detail ? <small>{detail}</small> : null}</span>
          </div>
          {selection && selectedModel ? <div className="agent-default-controls">
            <div className="agent-default-model-row">
              <span className="agent-default-label">Model</span>
              <span className="agent-default-field">
                <AgentModelPicker providerId={provider.id} providerName={provider.name} models={models} selectedModel={selectedModel} onChange={onChange} />
                {routeLabel(provider.id, selectedModel) ? <small>{routeLabel(provider.id, selectedModel)}</small> : null}
              </span>
            </div>
            {efforts.length && selectedEffort ? <div className="agent-default-model-row">
              <span className="agent-default-label">Reasoning</span>
              <span className="agent-default-field">
                {/* The native select arrow sits wherever the platform draws it, which
                    never lines up with the model trigger's chevron. Suppress it and
                    reuse the same glyph in the same place instead. */}
                <span className="agent-default-select">
                  <select
                    className="agent-default-reasoning"
                    aria-label={`Default reasoning for ${provider.name}`}
                    value={selectedEffort}
                    onChange={(event) => void onChange(provider.id, selectedModel.id, event.target.value)}
                  >
                    {efforts.map((effort) => <option key={effort} value={effort}>{reasoningLabel(effort, { providerId: provider.id, modelId: selectedModel.id, displayName: selectedModel.name })}</option>)}
                  </select>
                  <ChevronDownIcon aria-hidden="true" />
                </span>
              </span>
            </div> : null}
          </div> : <p className="agent-default-unavailable">{provider.id === "direct" && allModels.length ? "Add an API key to choose a direct model" : "Model catalogue unavailable"}</p>}
          <i className={`connection-dot ${provider.state}`} data-tooltip={`${provider.state === "online" ? "Connected" : provider.state === "error" ? "Connection error" : "Offline"} · ${provider.authenticated ? "Signed in" : "Sign-in unavailable"}`} />
          {provider.state !== "online" ? <button className="settings-icon-action" data-tooltip={`Retry ${provider.name}`} aria-label={`Retry ${provider.name}`} disabled={busy === provider.id} onClick={async () => { setBusy(provider.id); await onReconnect(provider.id); setBusy(null); }}><RefreshIcon className="refresh-icon" /></button> : null}
        </article>;
      })}
    </div>
  </section><section className="settings-block global-agents-settings" id="global-agent-instructions">
    <header><div><h2>Global agent instructions</h2><p>Applied privately to every Tethoq task. They never appear as chat text.</p></div></header>
    <div className="global-agents-card">
      <div><strong>{preferences.globalAgentsPath ? "AGENTS.md selected" : "No global instructions"}</strong>
        <small>{preferences.globalAgentsPath ?? "Each task uses its own project instructions."}</small></div>
      <div className="global-agents-actions">
        {preferences.globalAgentsPath ? <button type="button" onClick={() => void onGlobalAgentsAction({ type: "clear-global-agents" })}>Clear</button> : null}
        <button type="button" onClick={() => void onGlobalAgentsAction({ type: "choose-global-agents" })}>{preferences.globalAgentsPath ? "Change" : "Choose AGENTS.md"}</button>
      </div>
    </div>
  </section></>;
}
