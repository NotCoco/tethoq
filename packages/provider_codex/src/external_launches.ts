import { open } from "node:fs/promises";
import type { ObservedExternalSessionLaunch } from "../../provider_contract/src/index.js";

const rolloutChunkBytes = 256 * 1_024;
const maximumRolloutScanBytes = 128 * 1_024 * 1_024;
const maximumLaunchCommandCharacters = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function externalCommandStrings(input: unknown): string[] {
  if (typeof input === "string") {
    const commands: string[] = [];
    const matches = input.matchAll(/(?:\bcmd\b|"cmd")\s*:\s*("(?:\\.|[^"\\])*")/gu);
    for (const match of matches) {
      try {
        const command: unknown = JSON.parse(match[1]!);
        if (typeof command === "string" && command.trim()) commands.push(command.trim().slice(0, maximumLaunchCommandCharacters));
      } catch {
        // A malformed orchestration envelope is not launch evidence.
      }
    }
    return commands.length > 0 ? commands : [input.slice(0, maximumLaunchCommandCharacters)];
  }
  if (Array.isArray(input)) return input.flatMap((entry) => externalCommandStrings(entry));
  if (!isRecord(input)) return [];
  return Object.values(input).flatMap((entry) => externalCommandStrings(entry));
}

function flagValue(command: string, flag: string): string | undefined {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = command.match(new RegExp(`${escaped}\\s+(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s;&|]+))`, "iu"));
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.trim() || undefined;
}

function isOpenCodeRun(command: string): boolean {
  return /(?:^|[\\/\s'"&])opencode(?:\.(?:ps1|cmd|exe))?['"]?\s+run(?:\s|$)/iu.test(command);
}

function decodedJavascriptString(value: string): string | undefined {
  // Decode only the escapes needed by the accepted single-quoted literals.
  // Unknown escapes stay intact so a Windows path such as `C:\Users` is not
  // rejected by JSON's narrower escape grammar or silently changed by eval.
  return value.replace(/\\([\\'])/gu, "$1");
}

function literalAssignment(source: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const single = source.match(new RegExp(`\\b(?:const|let)\\s+${escaped}\\s*=\\s*'((?:\\\\.|[^'\\\\])*)'\\s*;`, "u"))?.[1];
  if (single !== undefined) return decodedJavascriptString(single);
  const double = source.match(new RegExp(`\\b(?:const|let)\\s+${escaped}\\s*=\\s*(\"(?:\\\\.|[^\"\\\\])*\")\\s*;`, "u"))?.[1];
  if (double === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(double);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function literalArray(source: string, name: string): string[] | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const body = source.match(new RegExp(`\\b(?:const|let)\\s+${escaped}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`, "u"))?.[1];
  if (body === undefined) return undefined;
  const values: string[] = [];
  let index = 0;
  while (index < body.length) {
    while (/\s/u.test(body[index] ?? "")) index += 1;
    if (index >= body.length) break;
    const quote = body[index];
    if (quote !== "'" && quote !== '"' && quote !== "`") return undefined;
    index += 1;
    let raw = "";
    let closed = false;
    while (index < body.length) {
      const character = body[index++]!;
      if (character === "\\") {
        if (index >= body.length) return undefined;
        raw += `${character}${body[index++]!}`;
        continue;
      }
      if (character === quote) {
        closed = true;
        break;
      }
      raw += character;
    }
    if (!closed || (quote === "`" && raw.includes("${"))) return undefined;
    if (quote === '"') {
      try {
        const value: unknown = JSON.parse(`"${raw}"`);
        if (typeof value !== "string") return undefined;
        values.push(value);
      } catch {
        return undefined;
      }
    } else {
      values.push(decodedJavascriptString(raw) ?? raw);
    }
    while (/\s/u.test(body[index] ?? "")) index += 1;
    if (index >= body.length) break;
    if (body[index] !== ",") return undefined;
    index += 1;
  }
  return values;
}

/** Recognises a literal parallel-array fan-out without executing its JavaScript. */
function externalSessionLaunchesFromParallelArrays(source: string, observedAt: string): ObservedExternalSessionLaunch[] {
  if (!/\btools\.exec_command\s*\(/u.test(source)
    || !/\bprompts\.map\s*\(\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/u.test(source)) return [];
  const indexName = source.match(/\bprompts\.map\s*\(\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/u)?.[1];
  if (indexName === undefined) return [];
  const escapedIndex = indexName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`\\bmodels\\s*\\[\\s*${escapedIndex}\\s*\\]`, "u").test(source)
    || !new RegExp(`\\btitles\\s*\\[\\s*${escapedIndex}\\s*\\]`, "u").test(source)) return [];
  const executable = literalAssignment(source, "exe");
  const workingDirectory = literalAssignment(source, "cwd");
  const prompts = literalArray(source, "prompts");
  const models = literalArray(source, "models");
  const titles = literalArray(source, "titles");
  if (!executable || !workingDirectory || !/(?:^|[\\/])opencode(?:\.ps1|\.cmd|\.exe)?$/iu.test(executable)
    || prompts === undefined || models === undefined || titles === undefined
    || prompts.length === 0 || prompts.length !== models.length || prompts.length !== titles.length
    || prompts.length > 8) return [];
  return titles.map((title, index) => ({
    targetProviderId: "opencode",
    title: title.trim(),
    observedAt,
    workingDirectory: workingDirectory.trim(),
    modelId: models[index]!.trim(),
  })).filter((launch) => launch.title.length > 0 && launch.modelId.length > 0);
}

function externalSessionLaunchesFromLiteralCommandVariables(source: string, observedAt: string): ObservedExternalSessionLaunch[] {
  if (!/\btools\.exec_command\s*\(\s*\{\s*cmd\s*:\s*cmd\w*/u.test(source)) return [];
  const executableLiteral = source.match(/\b(?:const|let)\s+exe\s*=\s*'((?:\\.|[^'\\])*)'\s*;/u)?.[1];
  const directoryLiteral = source.match(/\b(?:const|let)\s+dir\s*=\s*'((?:\\.|[^'\\])*)'\s*;/u)?.[1];
  if (executableLiteral === undefined || directoryLiteral === undefined) return [];
  const executable = decodedJavascriptString(executableLiteral);
  const workingDirectory = decodedJavascriptString(directoryLiteral);
  if (!executable || !workingDirectory || !/(?:^|[\\/])opencode(?:\.ps1|\.cmd|\.exe)?$/iu.test(executable)) return [];

  const launches: ObservedExternalSessionLaunch[] = [];
  const commandPattern = /\b(?:const|let)\s+cmd\w*\s*=\s*`([\s\S]*?)`\s*;/gu;
  for (const match of source.matchAll(commandPattern)) {
    const command = match[1]!;
    if (!/\$\{exe\}['"]?\s+run(?:\s|$)/iu.test(command) || !/--dir\s+['"]?\$\{dir\}['"]?/u.test(command)) continue;
    const titleLiteral = command.match(/--title\s+'((?:\\.|[^'\\])*)'/u)?.[1];
    const modelLiteral = command.match(/--model\s+'((?:\\.|[^'\\])*)'/u)?.[1];
    if (titleLiteral === undefined || modelLiteral === undefined) continue;
    const title = decodedJavascriptString(titleLiteral);
    const modelId = decodedJavascriptString(modelLiteral);
    if (!title?.trim() || !modelId?.trim()) continue;
    launches.push({
      targetProviderId: "opencode",
      title: title.trim(),
      observedAt,
      workingDirectory: workingDirectory.trim(),
      modelId: modelId.trim(),
    });
    if (launches.length >= 8) break;
  }
  return launches;
}

/**
 * Recognises the bounded batch-launch shape Codex commonly authors when it maps
 * an explicit `tasks` array into several OpenCode CLI calls. No rollout code is
 * executed: every accepted field must still be a literal in the source.
 */
function externalSessionLaunchesFromStaticBatch(source: string, observedAt: string): ObservedExternalSessionLaunch[] {
  const literalCommands = externalSessionLaunchesFromLiteralCommandVariables(source, observedAt);
  if (literalCommands.length > 0) return literalCommands;
  const parallelArrays = externalSessionLaunchesFromParallelArrays(source, observedAt);
  if (parallelArrays.length > 0) return parallelArrays;
  if (!/\btools\.exec_command\s*\(/u.test(source)
    || !/\bopencode(?:\.(?:ps1|cmd|exe))?['"]?\s*['"`;]?\s*;?/iu.test(source)
    || !/\brun\s+--model\b[\s\S]{0,2000}--dir\b[\s\S]{0,2000}--title\b/u.test(source)
    || !/--title\s+\$\{[^}]*\bt\.title\b[^}]*\}/u.test(source)) return [];

  const directoryLiteral = source.match(/\b(?:const|let)\s+dir\s*=\s*'((?:\\.|[^'\\])*)'\s*;/u)?.[1];
  const modelLiteral = source.match(/--model\s+\$\{[^}]*\(\s*'((?:\\.|[^'\\])*)'\s*\)[^}]*\}/u)?.[1];
  if (directoryLiteral === undefined || modelLiteral === undefined) return [];
  const workingDirectory = decodedJavascriptString(directoryLiteral);
  const modelId = decodedJavascriptString(modelLiteral);
  if (!workingDirectory?.trim() || !modelId?.trim()) return [];

  const launches: ObservedExternalSessionLaunch[] = [];
  const titlePattern = /\btitle\s*:\s*'((?:\\.|[^'\\])*)'/gu;
  for (const match of source.matchAll(titlePattern)) {
    const title = decodedJavascriptString(match[1]!);
    if (!title?.trim()) continue;
    launches.push({
      targetProviderId: "opencode",
      title: title.trim(),
      observedAt,
      workingDirectory: workingDirectory.trim(),
      modelId: modelId.trim(),
    });
  }
  return launches;
}

/** Only explicit titles are accepted: an inferred prompt title is too weak to hide a user's task. */
export function externalSessionLaunchesFromCommand(command: string, observedAt: string): ObservedExternalSessionLaunch[] {
  if (!isOpenCodeRun(command)) return externalSessionLaunchesFromStaticBatch(command, observedAt);
  const title = flagValue(command, "--title");
  if (title === undefined) return [];
  const workingDirectory = flagValue(command, "--dir");
  const modelId = flagValue(command, "--model");
  return [{
    targetProviderId: "opencode",
    title,
    observedAt,
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
  }];
}

function launchesFromRolloutValue(value: unknown): ObservedExternalSessionLaunch[] {
  if (!isRecord(value) || typeof value.timestamp !== "string" || !isRecord(value.payload)) return [];
  const payload = value.payload;
  if (value.type === "response_item" && payload.type === "custom_tool_call" && payload.name === "exec") {
    return externalCommandStrings(payload.input).flatMap((command) => externalSessionLaunchesFromCommand(command, value.timestamp as string));
  }
  if (value.type !== "event_msg" || (payload.type !== "item_started" && payload.type !== "item_completed") || !isRecord(payload.item)) return [];
  const item = payload.item;
  if (item.type !== "CommandExecution" && item.type !== "commandExecution") return [];
  return externalCommandStrings(item.command).flatMap((command) => externalSessionLaunchesFromCommand(command, value.timestamp as string));
}

function launchSignature(launch: ObservedExternalSessionLaunch): string {
  const directory = (launch.workingDirectory ?? "").replace(/[\\/]+/gu, "/").replace(/\/$/u, "");
  const title = launch.title.replace(/\s+/gu, " ").trim();
  return [launch.targetProviderId, title, directory, launch.modelId?.trim() ?? ""].join("\u0000").toLowerCase();
}

/**
 * Reads backwards until `since`, so a large long-running Codex rollout does not
 * need to be loaded just to recover a handful of explicit CLI launches.
 */
export async function readExternalSessionLaunchesFromRollout(
  path: string,
  since: string,
): Promise<readonly ObservedExternalSessionLaunch[]> {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) return [];
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size === 0) return [];
    let end = metadata.size;
    let scanned = 0;
    let carry = "";
    let reachedSince = false;
    const launches: ObservedExternalSessionLaunch[] = [];
    while (end > 0 && scanned < maximumRolloutScanBytes && !reachedSince) {
      const length = Math.min(rolloutChunkBytes, end, maximumRolloutScanBytes - scanned);
      const start = end - length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      if (bytesRead === 0) break;
      scanned += bytesRead;
      const lines = `${buffer.subarray(0, bytesRead).toString("utf8")}${carry}`.split("\n");
      carry = start > 0 ? lines.shift() ?? "" : "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line || Buffer.byteLength(line, "utf8") > 1_024 * 1_024) continue;
        let value: unknown;
        try { value = JSON.parse(line); } catch { continue; }
        if (isRecord(value) && typeof value.timestamp === "string" && Date.parse(value.timestamp) < sinceMs) {
          reachedSince = true;
          break;
        }
        launches.push(...launchesFromRolloutValue(value));
      }
      end = start;
    }
    launches.sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    const deduped: ObservedExternalSessionLaunch[] = [];
    const lastObservedBySignature = new Map<string, number>();
    for (const launch of launches) {
      const signature = launchSignature(launch);
      const observedAtMs = Date.parse(launch.observedAt);
      const priorObservedAtMs = lastObservedBySignature.get(signature);
      if (priorObservedAtMs !== undefined && Number.isFinite(observedAtMs)
        && observedAtMs - priorObservedAtMs < 10 * 60_000) continue;
      deduped.push(launch);
      if (Number.isFinite(observedAtMs)) lastObservedBySignature.set(signature, observedAtMs);
    }
    return deduped;
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
