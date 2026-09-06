import { useState } from "react";
import { elicitationFields, elicitationResponse, type ElicitationField } from "../../../../../packages/provider_contract/src/elicitation";
import type { JsonObject, JsonValue } from "../../../../../packages/protocol/src/models";
import { Button } from "./components";
import { ClockIcon } from "./icons";
import type { InputRequest } from "./types";

export function ElicitationCard({ request, onSubmit, onLinkOpen }: {
  request: InputRequest; onSubmit: (answers: JsonObject) => Promise<void>; onLinkOpen?: ((url: string) => void) | undefined;
}) {
  const native = request.elicitation!;
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  let fields: ElicitationField[] = [];
  let unsupported: string | undefined;
  try { if (native.mode !== "url") fields = elicitationFields(native.requestedSchema); }
  catch (error) { unsupported = error instanceof Error ? error.message : String(error); }
  const url = typeof native.url === "string" && /^https?:\/\//iu.test(native.url) ? native.url : undefined;
  const send = async (action: "accept" | "decline") => {
    setFailure(null);
    try {
      const result = elicitationResponse(native, { action, content: values });
      setBusy(true);
      await onSubmit(result);
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <details className="question-card" open><summary><ClockIcon /><strong>Activity</strong><span>Question</span></summary>
    <form className="question-form" onSubmit={(event) => { event.preventDefault(); void send("accept"); }}>
      <h3>{request.title}</h3><p>{request.prompt}</p>
      {unsupported ? <p role="status">{unsupported}</p> : null}
      {native.mode === "url" ? <>{url && onLinkOpen ? <Button type="button" onClick={() => onLinkOpen(url)}>Open requested page</Button> : <p>This request has no available web link.</p>}</> : fields.map((field) =>
        <label className="question-custom" key={field.id}><span>{field.label}{field.required ? " *" : ""}</span>
          {field.description ? <p>{field.description}</p> : null}
          {field.type === "boolean" ? <select required={field.required} disabled={busy} value={values[field.id] === undefined ? "" : String(values[field.id])} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value === "" ? "" : event.target.value === "true" }))}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select>
            : field.options.length ? <select required={field.required} disabled={busy} multiple={field.type === "array"} value={(values[field.id] ?? (field.type === "array" ? [] : "")) as string | string[]} onChange={(event) => setValues((current) => ({ ...current, [field.id]: field.type === "array" ? [...event.target.selectedOptions].map((option) => option.value) : field.type === "number" || field.type === "integer" ? Number(event.target.value) : event.target.value }))}>
              {field.type !== "array" ? <option value="">Choose…</option> : null}{field.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
              : <input required={field.required} disabled={busy} type={field.type === "number" || field.type === "integer" ? "number" : "text"} step={field.type === "integer" ? 1 : "any"}
                min={typeof field.schema.minimum === "number" ? field.schema.minimum : undefined} max={typeof field.schema.maximum === "number" ? field.schema.maximum : undefined}
                minLength={typeof field.schema.minLength === "number" ? field.schema.minLength : undefined} maxLength={typeof field.schema.maxLength === "number" ? field.schema.maxLength : undefined}
                pattern={typeof field.schema.pattern === "string" ? field.schema.pattern : undefined} value={String(values[field.id] ?? "")}
                onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value && (field.type === "number" || field.type === "integer") ? Number(event.target.value) : event.target.value }))} />}
        </label>)}
      {failure ? <p className="permission-error" role="alert">{failure}</p> : null}
      <div className="request-actions"><Button type="submit" variant="primary" disabled={busy || !!unsupported || (native.mode === "url" && !url)}>{native.mode === "url" ? "Accept" : "Submit answer"}</Button><Button type="button" disabled={busy} onClick={() => { void send("decline"); }}>Decline</Button></div>
    </form>
  </details>;
}
