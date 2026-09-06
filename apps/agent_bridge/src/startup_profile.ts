import { appendFileSync } from "node:fs";

const startupProfilePath = process.env.TETHOQ_STARTUP_PROFILE_PATH?.trim();

function memorySnapshot(): Record<string, number> {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    userCpuMicros: cpu.user,
    systemCpuMicros: cpu.system,
  };
}

/** Opt-in diagnostic trace; it is inert unless a path is supplied at launch. */
export function recordStartupProfile(event: Readonly<Record<string, unknown>>): void {
  if (!startupProfilePath) return;
  try {
    appendFileSync(startupProfilePath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      uptimeMs: Math.round(process.uptime() * 1_000),
      ...memorySnapshot(),
      ...event,
    })}\n`, "utf8");
  } catch {
    // Diagnostics must never affect startup.
  }
}

export function startStartupProfileHeartbeat(phase: string, intervalMs = 500): () => void {
  if (!startupProfilePath) return () => undefined;
  recordStartupProfile({ type: "heartbeat-start", phase });
  const timer = setInterval(() => recordStartupProfile({ type: "heartbeat", phase }), intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    recordStartupProfile({ type: "heartbeat-stop", phase });
  };
}
