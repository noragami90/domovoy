// The last lines of the engine log, for the panel (no terminal needed on the Pi).
export class LogBuffer {
  private readonly lines: string[] = [];
  private readonly max: number;

  constructor(max = 500) { this.max = max; }

  add(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  tail(n = 200): string[] { return this.lines.slice(-n); }
}
