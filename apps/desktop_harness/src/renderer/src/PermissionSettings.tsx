import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderSessionPermissions } from "../../../../../packages/provider_contract/src/types";
import type { JsonObject } from "../../../../../packages/protocol/src/models";
import { XIcon } from "./icons";

export function PermissionSettings({ sessionId, request, onClose }: {
  sessionId: string;
  request: (type: string, payload?: JsonObject) => Promise<Record<string, unknown>>;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const [settings, setSettings] = useState<ProviderSessionPermissions | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    setFailure(null);
    try {
      const result = await request("session.permissions.get", { sessionId });
      if (!Array.isArray(result.controls)) throw new Error("The harness did not return permission choices.");
      if (alive.current) setSettings(result as unknown as ProviderSessionPermissions);
    } catch (error) { if (alive.current) setFailure(error instanceof Error ? error.message : String(error)); }
  }, [request, sessionId]);
  useEffect(() => {
    alive.current = true;
    void load();
    panel.current?.focus();
    return () => { alive.current = false; };
  }, [load]);
  useEffect(() => {
    const pointer = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) onClose(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key, true); };
  }, [onClose]);
  return <div className="ears-settings permission-settings" role="region" aria-label="Task permissions" tabIndex={-1} ref={panel}>
    <header><span><strong>Permissions</strong><small>{settings?.note ?? (settings ? "Applies to this task." : failure ? "Could not load permission settings." : "Loading this task’s permission settings…")}</small></span><button type="button" aria-label="Close permissions" onClick={() => onClose()}><XIcon /></button></header>
    {failure ? <div className="permission-error" role="alert"><span>{failure}</span><button type="button" onClick={() => { void load(); }}>Refresh</button></div> : null}
    {settings?.controls.map((control) => <label key={control.id}><span>{control.label}</span><select aria-label={control.label} value={control.value} disabled={saving} onChange={async (event) => {
      const value = event.target.value;
      setSaving(true);
      setFailure(null);
      try {
        const result = await request("session.permissions.set", { sessionId, controlId: control.id, value });
        if (!Array.isArray(result.controls)) throw new Error("The harness did not confirm its permission settings.");
        if (alive.current) setSettings(result as unknown as ProviderSessionPermissions);
      } catch (error) { if (alive.current) setFailure(error instanceof Error ? error.message : String(error)); }
      finally { if (alive.current) setSaving(false); }
    }}>{control.options.map((option) => <option value={option.value} key={option.value} disabled={option.disabled}>{option.label}</option>)}</select>
      {control.options.find((option) => option.value === control.value)?.description ? <small>{control.options.find((option) => option.value === control.value)!.description}</small> : null}
    </label>)}
    {saving ? <small role="status">Saving permission setting…</small> : null}
  </div>;
}
