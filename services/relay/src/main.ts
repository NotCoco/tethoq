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

const server = new RelayServer({
  host: environmentValue("TETHOQ_RELAY_HOST") ?? "0.0.0.0",
  port: integer(environmentValue("TETHOQ_RELAY_PORT"), 8787),
  path: environmentValue("TETHOQ_RELAY_PATH") ?? "/relay",
});

await server.listen();
const address = server.address();
const rendered = typeof address === "string" ? address : `${address?.address ?? "0.0.0.0"}:${address?.port ?? 8787}`;
console.log(`Tethoq relay listening on ${rendered}`);

const stop = async (signal: string) => {
  console.log(`Relay received ${signal}; closing connections`);
  await server.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
