import { RelayServer } from "./relay.js";

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error(`Invalid port ${value}`);
  return parsed;
}

function environmentValue(name: `TETHOQ_${string}`): string | undefined {
  return process.env[name] ?? process.env[`UAR_${name.slice("TETHOQ_".length)}`];
}

function count(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid limit ${value}`);
  return parsed;
}

/**
 * Which immediate peers may speak for a client through `x-forwarded-for`. The
 * relay runs behind its own reverse proxy on loopback, so that is the default.
 * Widen this only for a proxy you operate: anything trusted here can choose the
 * address every per-address limit is applied to.
 */
const trustedProxyAddresses = (environmentValue("TETHOQ_RELAY_TRUSTED_PROXIES") ?? "loopback")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const server = new RelayServer({
  host: environmentValue("TETHOQ_RELAY_HOST") ?? "0.0.0.0",
  port: integer(environmentValue("TETHOQ_RELAY_PORT"), 8787),
  path: environmentValue("TETHOQ_RELAY_PATH") ?? "/relay",
  maxConnections: count(environmentValue("TETHOQ_RELAY_MAX_CONNECTIONS"), 4_000),
  maxConnectionsPerAddress: count(environmentValue("TETHOQ_RELAY_MAX_CONNECTIONS_PER_ADDRESS"), 32),
  maxRooms: count(environmentValue("TETHOQ_RELAY_MAX_ROOMS"), 2_000),
  maxDevicesPerRoom: count(environmentValue("TETHOQ_RELAY_MAX_DEVICES_PER_ROOM"), 16),
  // Only an explicit opt-out, so a misread environment cannot quietly allow any
  // token holder to claim the host role.
  requireSignedHostAttach: environmentValue("TETHOQ_RELAY_ALLOW_UNSIGNED_HOST") !== "1",
  requireSignedDeviceAttach: environmentValue("TETHOQ_RELAY_ALLOW_UNSIGNED_DEVICE") !== "1",
  maxAttachBytes: count(environmentValue("TETHOQ_RELAY_MAX_ATTACH_BYTES"), 16 * 1024),
  maxConnectionsPerAddressPerMinute: count(environmentValue("TETHOQ_RELAY_MAX_CONNECTIONS_PER_ADDRESS_PER_MINUTE"), 120),
  trustedProxyAddresses,
});

await server.listen();
const address = server.address();
const rendered = typeof address === "string" ? address : `${address?.address ?? "0.0.0.0"}:${address?.port ?? 8787}`;
console.log(`Tethoq relay listening on ${rendered}`);
if (environmentValue("TETHOQ_RELAY_ALLOW_UNSIGNED_HOST") === "1") {
  console.warn("Tethoq relay is accepting unsigned host attachments. Any holder of a room token can claim the host role. Use this only while migrating hosts.");
}
if (environmentValue("TETHOQ_RELAY_ALLOW_UNSIGNED_DEVICE") === "1") {
  console.warn("Tethoq relay is accepting unsigned device attachments. Any holder of a room token can claim another device's ID. Use this only while migrating devices.");
}

const stop = async (signal: string) => {
  console.log(`Relay received ${signal}; closing connections`);
  await server.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
