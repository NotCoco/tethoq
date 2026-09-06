import { dirname, join } from "node:path";
import {
  parseGlobalSessionId,
  sessionKinds,
  sessionRelationshipKinds,
  sessionRelationshipStrategies,
  type RemoteSession,
  type SessionKind,
  type SessionRelationship,
} from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export const maximumSessionCatalogueEntries = 500;

interface SessionCatalogueEntry {
  readonly userStopped?: boolean;
  readonly interruptedAt?: string;
  readonly id: string;
  readonly hostId: string;
  readonly providerId: string;
  readonly providerSessionId: string;
  readonly title: string;
  readonly project?: string;
  readonly workingDirectory?: string;
  readonly createdAt?: string;
  readonly lastActivityAt: string;
  readonly preview?: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  readonly variantId?: string;
  readonly parentSessionId?: string;
  readonly sessionKind?: SessionKind;
  readonly relationship?: SessionRelationship;
  readonly agentNickname?: string;
  readonly agentRole?: string;
}

interface SessionCatalogueState {
  readonly version: 1;
  readonly sessions: readonly SessionCatalogueEntry[];
}

interface PendingWrite {
  readonly state: SessionCatalogueState;
  readonly serialized: string;
}

const stateKeys = new Set(["version", "sessions"]);
const entryKeys = new Set([
  "userStopped",
  "interruptedAt",
  "id",
  "hostId",
  "providerId",
  "providerSessionId",
  "title",
  "project",
  "workingDirectory",
  "createdAt",
  "lastActivityAt",
  "preview",
  "modelId",
  "reasoningEffort",
  "variantId",
  "parentSessionId",
  "sessionKind",
  "relationship",
  "agentNickname",
  "agentRole",
]);
const relationshipKeys = new Set(["kind", "sourceSessionId", "strategy"]);
const validSessionKinds = new Set<string>(sessionKinds);
const validRelationshipKinds = new Set<string>(sessionRelationshipKinds);
const validRelationshipStrategies = new Set<string>(sessionRelationshipStrategies);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function requiredString(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const parsed = value.trim();
  if (parsed.length === 0 || parsed.length > maximumLength) throw new Error(`${field} is invalid`);
  return parsed;
}

function optionalString(value: unknown, field: string, maximumLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maximumLength);
}

function timestamp(value: unknown, field: string): string {
  const parsed = requiredString(value, field, 64);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} is invalid`);
  return new Date(milliseconds).toISOString();
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : timestamp(value, field);
}

function assertSessionId(
  id: string,
  expectedHostId: string,
  expectedProviderId?: string,
  expectedProviderSessionId?: string,
): void {
  const parsed = parseGlobalSessionId(id);
  if (parsed.hostId !== expectedHostId
    || (expectedProviderId !== undefined && parsed.providerId !== expectedProviderId)
    || (expectedProviderSessionId !== undefined && parsed.providerSessionId !== expectedProviderSessionId)) {
    throw new Error("Session catalogue identity does not match its global session ID");
  }
}

function parseRelationship(value: unknown, expectedHostId: string): SessionRelationship | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, relationshipKeys)) throw new Error("Session catalogue relationship is invalid");
  const kind = requiredString(value.kind, "relationship.kind", 32);
  const sourceSessionId = requiredString(value.sourceSessionId, "relationship.sourceSessionId", 8_192);
  const strategy = requiredString(value.strategy, "relationship.strategy", 32);
  if (!validRelationshipKinds.has(kind) || !validRelationshipStrategies.has(strategy)) {
    throw new Error("Session catalogue relationship is invalid");
  }
  assertSessionId(sourceSessionId, expectedHostId);
  return {
    kind: kind as SessionRelationship["kind"],
    sourceSessionId,
    strategy: strategy as SessionRelationship["strategy"],
  };
}

function parseEntry(value: unknown, expectedHostId: string): SessionCatalogueEntry {
  if (!isRecord(value) || !hasOnlyKeys(value, entryKeys)) throw new Error("Session catalogue entry is invalid");
  const id = requiredString(value.id, "id", 8_192);
  const hostId = requiredString(value.hostId, "hostId", 1_024);
  const providerId = requiredString(value.providerId, "providerId", 1_024);
  const providerSessionId = requiredString(value.providerSessionId, "providerSessionId", 4_096);
  if (hostId !== expectedHostId) throw new Error("Session catalogue belongs to a different host");
  assertSessionId(id, expectedHostId, providerId, providerSessionId);

  const parentSessionId = optionalString(value.parentSessionId, "parentSessionId", 8_192);
  if (parentSessionId !== undefined) assertSessionId(parentSessionId, expectedHostId);
  const sessionKind = optionalString(value.sessionKind, "sessionKind", 32);
  if (sessionKind !== undefined && !validSessionKinds.has(sessionKind)) throw new Error("Session catalogue kind is invalid");

  const project = optionalString(value.project, "project", 8_192);
  const workingDirectory = optionalString(value.workingDirectory, "workingDirectory", 32_768);
  const createdAt = optionalTimestamp(value.createdAt, "createdAt");
  const preview = optionalString(value.preview, "preview", 4_096);
  const modelId = optionalString(value.modelId, "modelId", 1_024);
  const reasoningEffort = optionalString(value.reasoningEffort, "reasoningEffort", 256);
  const variantId = optionalString(value.variantId, "variantId", 1_024);
  const relationship = parseRelationship(value.relationship, expectedHostId);
  const agentNickname = optionalString(value.agentNickname, "agentNickname", 256);
  const agentRole = optionalString(value.agentRole, "agentRole", 256);
  if (value.userStopped !== undefined && typeof value.userStopped !== "boolean") throw new Error("Session catalogue stop state is invalid");
  const interruptedAt = optionalTimestamp(value.interruptedAt, "interruptedAt");

  return {
    id,
    hostId,
    providerId,
    providerSessionId,
    title: requiredString(value.title, "title", 4_096),
    ...(project !== undefined ? { project } : {}),
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    lastActivityAt: timestamp(value.lastActivityAt, "lastActivityAt"),
    ...(preview !== undefined ? { preview } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(variantId !== undefined ? { variantId } : {}),
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(sessionKind !== undefined ? { sessionKind: sessionKind as SessionKind } : {}),
    ...(relationship !== undefined ? { relationship } : {}),
    ...(agentNickname !== undefined ? { agentNickname } : {}),
    ...(agentRole !== undefined ? { agentRole } : {}),
    ...(value.userStopped === true ? { userStopped: true } : {}),
    ...(interruptedAt !== undefined ? { interruptedAt } : {}),
  };
}

function validateState(value: unknown, expectedHostId: string): SessionCatalogueState {
  if (!isRecord(value) || !hasOnlyKeys(value, stateKeys) || value.version !== 1 || !Array.isArray(value.sessions)) {
    throw new Error("Session catalogue file is invalid");
  }
  if (value.sessions.length > maximumSessionCatalogueEntries) throw new Error("Session catalogue file is too large");
  const sessions = value.sessions.map((entry) => parseEntry(entry, expectedHostId));
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) {
    throw new Error("Session catalogue contains duplicate sessions");
  }
  return { version: 1, sessions };
}

function entryFromSession(session: RemoteSession, expectedHostId: string): SessionCatalogueEntry | undefined {
  try {
    return parseEntry({
      id: session.id,
      hostId: session.hostId,
      providerId: session.providerId,
      providerSessionId: session.providerSessionId,
      title: session.title,
      ...(session.project !== undefined ? { project: session.project } : {}),
      ...(session.workingDirectory !== undefined ? { workingDirectory: session.workingDirectory } : {}),
      ...(session.createdAt !== undefined ? { createdAt: session.createdAt } : {}),
      lastActivityAt: session.lastActivityAt,
      ...(session.preview !== undefined ? { preview: session.preview } : {}),
      ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
      ...(session.reasoningEffort !== undefined ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.variantId !== undefined ? { variantId: session.variantId } : {}),
      ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
      ...(session.sessionKind !== undefined ? { sessionKind: session.sessionKind } : {}),
      ...(session.relationship !== undefined ? { relationship: session.relationship } : {}),
      ...(session.agentNickname !== undefined ? { agentNickname: session.agentNickname } : {}),
      ...(session.agentRole !== undefined ? { agentRole: session.agentRole } : {}),
      ...(session.nativeMetadata.tethoqUserStopped === true ? { userStopped: true } : {}),
      ...(typeof session.nativeMetadata.tethoqInterruptedAt === "string" ? { interruptedAt: session.nativeMetadata.tethoqInterruptedAt } : {}),
    }, expectedHostId);
  } catch {
    // One malformed provider row must not prevent valid catalogue rows from
    // being cached for the next start.
    return undefined;
  }
}

function persistedState(sessions: readonly RemoteSession[], expectedHostId: string): SessionCatalogueState {
  const newestById = new Map<string, SessionCatalogueEntry>();
  for (const session of sessions) {
    const entry = entryFromSession(session, expectedHostId);
    if (entry !== undefined) newestById.set(entry.id, entry);
  }
  const entries = [...newestById.values()]
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt) || left.id.localeCompare(right.id))
    .slice(0, maximumSessionCatalogueEntries);
  return { version: 1, sessions: entries };
}

function hydratedSession(entry: SessionCatalogueEntry): RemoteSession {
  const { userStopped, interruptedAt, ...session } = entry;
  return {
    ...session,
    // A catalogue is evidence that the task exists, not evidence that it is
    // still running or waiting for the user after this process restarted.
    state: "unknown",
    needsApproval: false,
    stale: true,
    nativeMetadata: {
      ...(userStopped === true ? { tethoqUserStopped: true } : {}),
      ...(interruptedAt !== undefined ? { tethoqInterruptedAt: interruptedAt } : {}),
    },
  };
}

export function defaultSessionCatalogueStatePath(configPath: string): string {
  return join(dirname(configPath), "session-catalogue.json");
}

/**
 * Private last-known sidebar data. The on-disk schema deliberately has no
 * transient status fields and no provider-native metadata field.
 */
export class SessionCatalogueStore {
  readonly #store: JsonFileStore<SessionCatalogueState>;
  #pending: PendingWrite | undefined;
  #drain: Promise<void> | undefined;
  #lastWritten: string | undefined;

  public constructor(path: string, private readonly hostId: string) {
    this.#store = new JsonFileStore(path, (value) => validateState(value, hostId));
  }

  public async read(): Promise<readonly RemoteSession[]> {
    try {
      const state = await this.#store.read({ version: 1, sessions: [] });
      this.#lastWritten = JSON.stringify(state);
      return state.sessions.map(hydratedSession);
    } catch {
      // This is only a startup accelerator. Corrupt or incompatible data must
      // never stop the real providers from loading an authoritative catalogue.
      return [];
    }
  }

  public scheduleWrite(sessions: readonly RemoteSession[]): void {
    const state = persistedState(sessions, this.hostId);
    const serialized = JSON.stringify(state);
    if (serialized === this.#lastWritten || serialized === this.#pending?.serialized) return;
    this.#pending = { state, serialized };
    this.ensureDrain();
  }

  public async flush(): Promise<void> {
    while (this.#pending !== undefined || this.#drain !== undefined) {
      this.ensureDrain();
      await this.#drain;
    }
  }

  private ensureDrain(): void {
    if (this.#drain !== undefined || this.#pending === undefined) return;
    this.#drain = Promise.resolve()
      .then(async () => await this.drainWrites())
      .catch(() => undefined)
      .finally(() => {
        this.#drain = undefined;
        if (this.#pending !== undefined) this.ensureDrain();
      });
  }

  private async drainWrites(): Promise<void> {
    while (this.#pending !== undefined) {
      const pending = this.#pending;
      this.#pending = undefined;
      if (pending.serialized === this.#lastWritten) continue;
      await this.#store.write(pending.state);
      this.#lastWritten = pending.serialized;
    }
  }
}
