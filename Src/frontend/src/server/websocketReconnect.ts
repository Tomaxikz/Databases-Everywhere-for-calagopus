export const DBEV_RESTART_CLOSE_CODE = 1012;

export function isExpectedDaemonRestart(code: number, reason: string): boolean {
  return code === DBEV_RESTART_CLOSE_CODE && reason.trim().toLowerCase() === 'server restarting';
}

export function reconnectDelay(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(Math.max(0, attempt - 1), 5));
  // ±20% jitter prevents a fleet of browser tabs from minting tokens at once.
  return Math.min(30_000, Math.max(250, Math.round(base * (0.8 + Math.min(1, Math.max(0, random())) * 0.4))));
}

type Schedule = (callback: () => void, delay: number) => number;
type Cancel = (timer: number) => void;

export class ReconnectController {
  private timer: number | null = null;

  constructor(
    private readonly scheduleTimer: Schedule,
    private readonly cancelTimer: Cancel,
  ) {}

  schedule(attempt: number, connect: () => void, random = Math.random): boolean {
    if (this.timer !== null) return false;
    this.timer = this.scheduleTimer(
      () => {
        this.timer = null;
        connect();
      },
      reconnectDelay(attempt, random),
    );
    return true;
  }

  cancel(): void {
    if (this.timer !== null) this.cancelTimer(this.timer);
    this.timer = null;
  }
}
