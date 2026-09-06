import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderSessionPermissions } from "../../provider_contract/src/index.js";
import { isRecord } from "./normalize.js";

type Selection = { approvalPolicy?: string; sandbox?: string };
const approvals = [
  { value: "untrusted", label: "Ask for untrusted actions" },
  { value: "on-request", label: "Ask when needed" },
  { value: "never", label: "Never ask", description: "Actions requiring approval will be refused." },
];
const sandboxes = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace access" },
  { value: "danger-full-access", label: "Full access", description: "Allows access beyond the workspace." },
];

/** User-selected task overrides. App-server applies these at the next turn/start. */
export class CodexSessionPermissions {
  readonly #selections = new Map<string, Selection>();
  readonly #requirements = new Map<string, Record<string, unknown>>();
  #loaded: Promise<void> | undefined;
  #writes = Promise.resolve();
  public constructor(private readonly statePath?: string) {}

  private async load(): Promise<void> {
    this.#loaded ??= (async () => {
      if (this.statePath === undefined) return;
      let data: unknown;
      try { data = JSON.parse(await readFile(this.statePath, "utf8")); }
      catch (error) { if (isRecord(error) && error.code === "ENOENT") return; throw error; }
      if (!isRecord(data)) throw new Error("Invalid saved Codex permission settings");
      for (const [id, source] of Object.entries(data)) {
        if (!isRecord(source)) continue;
        this.#selections.set(id, {
          ...(approvals.some((option) => option.value === source.approvalPolicy) ? { approvalPolicy: source.approvalPolicy as string } : {}),
          ...(sandboxes.some((option) => option.value === source.sandbox) ? { sandbox: source.sandbox as string } : {}),
        });
      }
    })();
    await this.#loaded;
  }

  public async describe(id: string, native: unknown, requirementsSource: unknown): Promise<ProviderSessionPermissions> {
    await this.load();
    const source = isRecord(native) ? native : {};
    if (!isRecord(requirementsSource) || !("requirements" in requirementsSource)) {
      return { controls: [], note: "This Codex version does not expose its permission requirements." };
    }
    const requirements = isRecord(requirementsSource.requirements) ? requirementsSource.requirements : {};
    this.#requirements.set(id, requirements);
    const selected = this.#selections.get(id);
    const sandbox = isRecord(source.sandbox) ? source.sandbox.type : undefined;
    const currentSandbox = sandbox === "readOnly" ? "read-only" : sandbox === "workspaceWrite" ? "workspace-write" : sandbox === "dangerFullAccess" ? "danger-full-access" : "custom";
    const filtered = (options: typeof approvals, allowed: unknown) => Array.isArray(allowed)
      ? options.filter((option) => allowed.includes(option.value)) : options;
    const allowedApprovals = filtered(approvals, requirements.allowedApprovalPolicies);
    const allowedSandboxes = filtered(sandboxes, requirements.allowedSandboxModes);
    const approvalValue = selected?.approvalPolicy ?? (typeof source.approvalPolicy === "string" ? source.approvalPolicy : "custom");
    const sandboxValue = selected?.sandbox ?? currentSandbox;
    const withCurrent = (options: typeof approvals, value: string) => options.some((option) => option.value === value)
      ? options : [{ value, label: value === "custom" ? "Current custom policy" : `Current: ${value} (unavailable)`, disabled: true }, ...options];
    return {
      controls: [
        { id: "approvalPolicy", label: "Approvals", value: approvalValue, options: withCurrent(allowedApprovals, approvalValue) },
        { id: "sandbox", label: "File access", value: sandboxValue, options: withCurrent(allowedSandboxes, sandboxValue) },
      ],
      note: "Applies to the next turn sent from Tethoq in this task. Other tasks keep their own settings.",
    };
  }

  public async set(id: string, controlId: string, value: string, available: ProviderSessionPermissions): Promise<void> {
    const nativeOptions = controlId === "approvalPolicy" ? approvals : controlId === "sandbox" ? sandboxes : [];
    if (!nativeOptions.some((option) => option.value === value)
      || !available.controls.find((control) => control.id === controlId)?.options.some((option) => option.value === value && !option.disabled)) {
      throw new Error("Codex does not allow this permission selection");
    }
    const write = this.#writes.then(async () => {
      const next = new Map(this.#selections);
      next.set(id, { ...next.get(id), [controlId]: value });
      if (this.statePath !== undefined) {
        await mkdir(dirname(this.statePath), { recursive: true });
        const temporary = `${this.statePath}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(Object.fromEntries(next)), { mode: 0o600 });
        await rename(temporary, this.statePath);
      }
      this.#selections.set(id, next.get(id)!);
    });
    this.#writes = write.catch(() => undefined);
    await write;
  }

  public async turnOverrides(id: string, readRequirements?: () => Promise<unknown>): Promise<Record<string, unknown>> {
    await this.load();
    const selected = this.#selections.get(id);
    if (selected === undefined) return {};
    if (readRequirements !== undefined) {
      const source = await readRequirements();
      if (!isRecord(source) || !("requirements" in source)) throw new Error("Codex could not verify the saved permission settings");
      this.#requirements.set(id, isRecord(source.requirements) ? source.requirements : {});
    }
    const requirements = this.#requirements.get(id);
    if (requirements === undefined) throw new Error("Read Codex permission requirements before applying saved settings");
    if ((selected.approvalPolicy !== undefined && Array.isArray(requirements.allowedApprovalPolicies) && !requirements.allowedApprovalPolicies.includes(selected.approvalPolicy))
      || (selected.sandbox !== undefined && Array.isArray(requirements.allowedSandboxModes) && !requirements.allowedSandboxModes.includes(selected.sandbox))) {
      throw new Error("Saved task permissions are no longer allowed by Codex. Choose an available option in /permission.");
    }
    return {
      ...(selected?.approvalPolicy !== undefined ? { approvalPolicy: selected.approvalPolicy } : {}),
      ...(selected?.sandbox === "read-only" ? { sandboxPolicy: { type: "readOnly", networkAccess: false } }
        : selected?.sandbox === "workspace-write" ? { sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }
          : selected?.sandbox === "danger-full-access" ? { sandboxPolicy: { type: "dangerFullAccess" } } : {}),
    };
  }
}
