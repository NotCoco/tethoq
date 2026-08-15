import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const TRUST_STORE_VERSION = 1;
const MAX_TREE_ENTRIES = 20_000;
const MAX_TREE_BYTES = 1024 * 1024 * 1024;
const MAX_TRUST_STORE_BYTES = 1024 * 1024;

interface ConnectorTrustStore {
  readonly version: typeof TRUST_STORE_VERSION;
  readonly approvedFingerprints: readonly string[];
}

export interface DesktopConnectorExecutionPlan {
  readonly launcher: "node" | "executable";
  readonly entrypoint: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly platform: string;
  readonly architecture: string;
  readonly environmentNames: readonly string[];
}

const trustStoreMutations = new Map<string, Promise<void>>();

export async function fingerprintDesktopConnectorTree(
  directory: string,
  executionPlan?: DesktopConnectorExecutionPlan,
): Promise<string> {
  return await fingerprintDesktopConnectorTreeWithOptions(directory, executionPlan);
}

export async function fingerprintDesktopConnectorTreeWithOptions(
  directory: string,
  executionPlan?: DesktopConnectorExecutionPlan,
  options: { readonly onTreeEnumerated?: () => void | Promise<void> } = {},
): Promise<string> {
  const root = await realpath(resolve(directory));
  const files: Array<{ readonly path: string; readonly absolutePath: string; readonly size: number }> = [];
  let entryCount = 0;
  let totalBytes = 0;

  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_TREE_ENTRIES) throw new Error(`Connector tree exceeds ${MAX_TREE_ENTRIES} entries`);
      const absolutePath = resolve(current, entry.name);
      const firstStats = await lstat(absolutePath);
      if (firstStats.isSymbolicLink()) throw new Error("Connector tree contains a symbolic link");
      if (firstStats.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!firstStats.isFile()) throw new Error("Connector tree contains a non-file entry");
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) throw new Error("Connector tree changed to a symbolic link while fingerprinting");
      if (!stats.isFile() || stats.size !== firstStats.size || stats.mtimeMs !== firstStats.mtimeMs) {
        throw new Error("Connector tree changed while fingerprinting");
      }
      totalBytes += stats.size;
      if (totalBytes > MAX_TREE_BYTES) throw new Error("Connector tree exceeds the fingerprint size limit");
      const path = normalizedRelativePath(root, absolutePath);
      files.push({ path, absolutePath, size: stats.size });
    }
  };

  await visit(root);
  await options.onTreeEnumerated?.();
  if (files.length === 0) throw new Error("Connector tree is empty");
  files.sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");
  hash.update("tethoq-connector-tree-v2\0", "utf8");
  hash.update(canonicalExecutionPlan(executionPlan));
  for (const file of files) {
    const pathBytes = Buffer.from(file.path, "utf8");
    const handle = await open(file.absolutePath, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== file.size) throw new Error("Connector tree changed while fingerprinting");
      const openedPath = await lstat(file.absolutePath);
      if (openedPath.isSymbolicLink() || !openedPath.isFile()
        || openedPath.size !== before.size || openedPath.mtimeMs !== before.mtimeMs) {
        throw new Error("Connector tree changed while fingerprinting");
      }
      hash.update(uint64(pathBytes.length));
      hash.update(pathBytes);
      hash.update(uint64(file.size));
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await handle.stat();
      if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Connector tree changed while fingerprinting");
    } finally {
      await handle.close();
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function readApprovedDesktopConnectorFingerprints(path: string): Promise<ReadonlySet<string>> {
  let source: string;
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_TRUST_STORE_BYTES) throw new Error("Connector trust store is invalid");
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return new Set();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Connector trust store is invalid");
  }
  if (!isRecord(parsed) || parsed.version !== TRUST_STORE_VERSION || !Array.isArray(parsed.approvedFingerprints)
    || parsed.approvedFingerprints.some((value) => typeof value !== "string" || !isFingerprint(value))) {
    throw new Error("Connector trust store is invalid");
  }
  return new Set(parsed.approvedFingerprints);
}

export async function approveDesktopConnector(path: string, fingerprint: string): Promise<void> {
  assertFingerprint(fingerprint);
  await mutateTrustStore(path, (approved) => { approved.add(fingerprint); });
}

export async function revokeDesktopConnector(path: string, fingerprint: string): Promise<void> {
  assertFingerprint(fingerprint);
  await mutateTrustStore(path, (approved) => { approved.delete(fingerprint); });
}

async function mutateTrustStore(path: string, mutation: (approved: Set<string>) => void): Promise<void> {
  const absolutePath = resolve(path);
  const previous = trustStoreMutations.get(absolutePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    let approved: Set<string>;
    try {
      approved = new Set(await readApprovedDesktopConnectorFingerprints(absolutePath));
    } catch {
      approved = new Set();
    }
    mutation(approved);
    await writeTrustStore(absolutePath, approved);
  });
  trustStoreMutations.set(absolutePath, current);
  try {
    await current;
  } finally {
    if (trustStoreMutations.get(absolutePath) === current) trustStoreMutations.delete(absolutePath);
  }
}

async function writeTrustStore(path: string, approved: ReadonlySet<string>): Promise<void> {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporary = `${absolutePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const value: ConnectorTrustStore = { version: TRUST_STORE_VERSION, approvedFingerprints: [...approved].sort() };
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, absolutePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function canonicalExecutionPlan(plan: DesktopConnectorExecutionPlan | undefined): Buffer {
  const value = plan === undefined
    ? null
    : {
        launcher: plan.launcher,
        entrypoint: normalizePlanPath(plan.entrypoint),
        cwd: normalizePlanPath(plan.cwd),
        args: [...plan.args],
        platform: plan.platform,
        architecture: plan.architecture,
        environmentNames: [...plan.environmentNames].sort((left, right) => left.localeCompare(right)),
      };
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return Buffer.concat([uint64(bytes.length), bytes]);
}

function normalizePlanPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  return normalized === "" ? "." : normalized;
}

function normalizedRelativePath(root: string, value: string): string {
  const path = relative(root, value);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`)) throw new Error("Connector tree path escapes its installation directory");
  return path.split(sep).join("/").normalize("NFC");
}

function uint64(value: number): Buffer {
  const output = Buffer.allocUnsafe(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

function assertFingerprint(value: string): void {
  if (!isFingerprint(value)) throw new Error("Connector fingerprint is invalid");
}

function isFingerprint(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
