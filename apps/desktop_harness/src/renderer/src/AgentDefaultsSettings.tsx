import type { DesktopPreferencesState, PreferencesAction } from "@shared/desktop_api";
import { ProviderLogo } from "./components";
import { reasoningLabel } from "./Composer";
import { isAmbiguousSelectionValue, resolveConcreteModelSelection } from "./composer_helpers";
import type { DesktopSnapshot, ModelOption } from "./types";

function selectableModels(providerId: string, models: readonly ModelOption[]): ModelOption[] {
  if (providerId !== "direct") return [...models];
  return models.filter((model) => model.walletKind !== "user_api" || model.apiKeyConfigured === true);
}

function modelOptions(models: readonly ModelOption[]) {
  if (!models.some((model) => model.endpointName)) {
    return models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>);
  }
  const groups = new Map<string, ModelOption[]>();
  for (const model of models) {
    const label = model.endpointName ?? "Other models";
    groups.set(label, [...(groups.get(label) ?? []), model]);
  }
  return [...groups].map(([label, options]) => <optgroup key={label} label={label}>
    {options.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
  </optgroup>);
}

function routeLabel(providerId: string, model: ModelOption): string | undefined {
  if (providerId === "direct") {
    return `${model.endpointName ?? "Direct API"} · API key saved`;
  }
  if (model.endpointName) return `${model.endpointName} through ${model.source ?? "this agent"}`;
  return undefined;
}

export function AgentDefaultsSettings({ snapshot, preferences, onChange, onGlobalAgentsAction }: {
  snapshot: DesktopSnapshot;
  preferences: DesktopPreferencesState;
  onChange: (providerId: string, modelId: string, reasoningEffort?: string) => Promise<void>;
  onGlobalAgentsAction: (action: PreferencesAction) => Promise<void>;
}) {
  return <><section className="settings-block agent-defaults" id="agent-defaults">
    <header><div><h2>Model defaults</h2><p>New tasks start here. Existing tasks keep their latest choices.</p></div></header>
    <div className="agent-default-list">
      {snapshot.providers.map((provider) => {
        const allModels = snapshot.models[provider.id] ?? [];
        const models = selectableModels(provider.id, allModels);
        const configured = preferences.agentDefaults[provider.id];
        const selection = resolveConcreteModelSelection(models, {}, configured);
        const selectedModel = models.find((model) => model.id === selection?.modelId);
        const efforts = [...new Set((selectedModel?.efforts ?? []).filter((effort) => !isAmbiguousSelectionValue(effort)))];
        const reasoningEffort = selection?.reasoningEffort && !isAmbiguousSelectionValue(selection.reasoningEffort)
          ? selection.reasoningEffort
          : efforts[0];
        return <article key={provider.id}>
          <div className="agent-default-identity">
            <ProviderLogo providerId={provider.id} provider={provider} size={30}/>
            <strong>{provider.name}</strong>
          </div>
          {selection && selectedModel ? <div className={`agent-default-controls${reasoningEffort && efforts.length ? "" : " model-only"}`}>
            <label>
              <span>Model</span>
              <span className="agent-default-field">
                <select aria-label={`Default model for ${provider.name}`} value={selectedModel.id} onChange={(event) => {
                  const next = resolveConcreteModelSelection(models, { modelId: event.target.value });
                  if (next) void onChange(provider.id, next.modelId, next.reasoningEffort);
                }}>
                  {modelOptions(models)}
                </select>
                {routeLabel(provider.id, selectedModel) ? <small>{routeLabel(provider.id, selectedModel)}</small> : null}
              </span>
            </label>
            {reasoningEffort && efforts.length ? <label>
              <span>Reasoning</span>
              <select aria-label={`Default reasoning for ${provider.name}`} value={reasoningEffort} onChange={(event) => void onChange(provider.id, selectedModel.id, event.target.value)}>
                {efforts.map((effort) => <option key={effort} value={effort}>{reasoningLabel(effort)}</option>)}
              </select>
            </label> : null}
          </div> : <p className="agent-default-unavailable">{provider.id === "direct" && allModels.length ? "Add an API key to choose a direct model" : "Model catalogue unavailable"}</p>}
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
