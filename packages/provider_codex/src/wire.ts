/**
 * Curated Codex App Server v2 wire shapes used by this adapter.
 *
 * Source of truth: generated TypeScript produced on 2026-08-08 from the
 * installed CLI (codex-cli 0.147.0) with
 * `codex app-server generate-ts --out <dir>`, cross-checked against the
 * official repository at openai/codex/codex-rs/app-server-protocol. The live
 * `initialize`, `account/read`, `getAuthStatus`, `thread/list`, `thread/read`,
 * and `model/list` responses were also probed against a real `codex app-server
 * --listen stdio://` process and matched these shapes.
 *
 * Runtime responses may include additional fields (for example `extra`,
 * `historyMode`, and `canAcceptDirectInput` on Thread) that the installed
 * generator does not yet emit; the adapter treats unknown fields as opaque
 * native metadata and never drops them from normalization.
 */

export interface CodexThread {
  readonly id: string;
  readonly sessionId: string;
  readonly forkedFromId?: string | null;
  readonly parentThreadId?: string | null;
  readonly preview: string;
  readonly ephemeral?: boolean;
  readonly modelProvider: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recencyAt: number | null;
  readonly status: { readonly type?: string } | string;
  readonly path?: string | null;
  readonly cwd: string;
  readonly cliVersion: string;
  readonly source?: unknown;
  readonly threadSource?: unknown;
  readonly agentNickname?: string | null;
  readonly agentRole?: string | null;
  readonly gitInfo?: unknown;
  readonly name?: string | null;
  readonly turns?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface ThreadListResponse {
  readonly data: readonly CodexThread[];
  readonly nextCursor: string | null;
}

export interface ThreadResponse {
  readonly thread: CodexThread;
}

export interface ThreadForkResponse extends ThreadResponse {
  readonly model?: string;
  readonly cwd?: string;
  readonly reasoningEffort?: string | null;
}

export interface TurnResponse {
  readonly turn?: { readonly id?: string; readonly [key: string]: unknown };
}

export interface ModelListResponse {
  readonly data: readonly unknown[];
  readonly nextCursor: string | null;
}

export interface AccountReadResponse {
  readonly account: unknown | null;
  readonly requiresOpenaiAuth: boolean;
}

export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface ThreadGoal {
  readonly threadId: string;
  readonly objective: string;
  readonly status: ThreadGoalStatus;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision?: number;
}

export interface ThreadGoalResponse {
  readonly threadId?: string;
  readonly goal: ThreadGoal | null;
  readonly revision?: number;
  readonly updatedAt?: number | string;
}

export interface ThreadGoalClearResponse {
  readonly threadId?: string;
  readonly cleared: boolean;
  readonly revision?: number;
  readonly updatedAt?: number | string;
}
