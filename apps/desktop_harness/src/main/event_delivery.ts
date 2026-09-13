import type { DesktopEventBatch } from "../shared/desktop_api.js";

const maximumEventBatch = 200;

/** Delivers a backlog in bounded chunks without waiting for another provider event. */
export class DesktopEventDelivery {
  #sequence = 0;
  #scheduled: NodeJS.Immediate | undefined;
  #disposed = false;

  public constructor(
    private readonly readReplay: (sequence: number) => DesktopEventBatch,
    private readonly deliver: (batch: DesktopEventBatch) => void,
  ) {}

  public schedule(): void {
    if (this.#scheduled !== undefined || this.#disposed) return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      this.flush();
    });
  }

  public flush(): void {
    if (this.#disposed) return;
    const replay = this.readReplay(this.#sequence);
    if (replay.events.length === 0 && !replay.replayGap) return;
    const events = replay.events.slice(0, maximumEventBatch);
    const through = events.at(-1)?.sequence ?? replay.latestSequence;
    this.#sequence = through;
    this.deliver({ events, latestSequence: through, replayGap: replay.replayGap });
    // Yield to input/IPC between chunks, but do not put completion or a user's
    // echo behind a one-second recovery heartbeat for each remaining chunk.
    if (through < replay.latestSequence) this.schedule();
  }

  public dispose(): void {
    this.#disposed = true;
    clearImmediate(this.#scheduled);
    this.#scheduled = undefined;
  }
}
