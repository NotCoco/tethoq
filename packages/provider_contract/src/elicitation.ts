import type { JsonObject, JsonValue } from "../../protocol/src/index.js";

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
export interface ElicitationField {
  id: string; label: string; description?: string; type: "string" | "number" | "integer" | "boolean" | "array";
  required: boolean; options: Array<{ value: string; label: string }>; schema: Record<string, unknown>;
}

export function elicitationFields(schema: unknown): ElicitationField[] {
  const source = record(schema);
  if (source.type !== undefined && source.type !== "object") throw new Error("This question uses a form that must be answered in the harness.");
  const required = Array.isArray(source.required) ? source.required : [];
  return Object.entries(record(source.properties)).map(([id, value]) => {
    const field = record(value);
    const type = field.type ?? "string";
    if (!["string", "number", "integer", "boolean", "array"].includes(String(type))) throw new Error("This question uses a form that must be answered in the harness.");
    const choiceSchema = type === "array" ? record(field.items) : field;
    const enums = Array.isArray(choiceSchema.enum) ? choiceSchema.enum : undefined;
    const titled = choiceSchema.oneOf ?? choiceSchema.anyOf;
    const options = enums ? enums.map((value, index) => ({ value: String(value), label: String(Array.isArray(choiceSchema.enumNames) ? choiceSchema.enumNames[index] ?? value : value) }))
      : Array.isArray(titled) ? titled.map((value) => { const option = record(value); return { value: String(option.const), label: String(option.title ?? option.const) }; }) : [];
    if (type === "array" && options.length === 0) throw new Error("This question uses a list that must be answered in the harness.");
    return { id, label: typeof field.title === "string" ? field.title : id,
      ...(typeof field.description === "string" ? { description: field.description } : {}),
      type: type as ElicitationField["type"], required: required.includes(id), options, schema: field };
  });
}

export function elicitationResponse(request: Record<string, unknown>, answers: JsonObject): { action: "accept" | "decline" | "cancel"; content: JsonObject | null } {
  if (answers.action === "decline" || answers.action === "cancel") return { action: answers.action, content: null };
  if (answers.action !== "accept") throw new Error("Choose whether to accept or decline this question");
  if (request.mode === "url") return { action: "accept", content: null };
  const source = record(answers.content);
  const content: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const field of elicitationFields(request.requestedSchema)) {
    const value = source[field.id];
    if (value === undefined || value === "") {
      if (field.required) throw new Error(`${field.label} is required`);
      continue;
    }
    const numeric = field.type === "number" || field.type === "integer";
    const valid = numeric ? typeof value === "number" && Number.isFinite(value) && (field.type !== "integer" || Number.isInteger(value))
      : field.type === "array" ? Array.isArray(value) && value.every((entry) => typeof entry === "string")
        : typeof value === field.type;
    if (!valid) throw new Error(`${field.label} has an invalid value`);
    if (field.options.length && (Array.isArray(value) ? value : [String(value)]).some((entry) => !field.options.some((option) => option.value === entry))) throw new Error(`Choose an available option for ${field.label}`);
    const size = typeof value === "string" || Array.isArray(value) ? value.length : undefined;
    const min = field.schema[numeric ? "minimum" : field.type === "array" ? "minItems" : "minLength"];
    const max = field.schema[numeric ? "maximum" : field.type === "array" ? "maxItems" : "maxLength"];
    const measure = numeric ? value as number : size;
    if (measure !== undefined && ((typeof min === "number" && measure < min) || (typeof max === "number" && measure > max))) throw new Error(`${field.label} is outside the allowed range`);
    content[field.id] = value as JsonValue;
  }
  return { action: "accept", content };
}
