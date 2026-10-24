// Time source for the engine; tests swap in FakeClock to move time without waiting.
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, Math.min(ms, 2_147_483_647))),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = Date.UTC(2026, 9, 22, 18, 0, 0)) { this.t = start; }
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }

  // When the earliest pending timer is due (a replay steps from timer to timer).
  nextAt(): number | null {
    let at: number | null = null;
    for (const t of this.timers.values()) if (at === null || t.at < at) at = t.at;
    return at;
  }

  // Moves time forward, firing due timers in order (including ones they schedule).
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
}
