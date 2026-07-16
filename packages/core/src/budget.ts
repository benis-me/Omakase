// Budget accounting: bounds a run's agent-call count, spend, and wall-clock.
// This is the safety lever that keeps an autonomous Goal-loop from running away.

export interface BudgetLimits {
  maxUsd?: number;
  maxWallClockMs?: number;
  /** Injectable start time (tests); defaults to now. */
  startedAt?: number;
}

export interface BudgetSnapshot {
  totalAgents: number | null;
  spentAgents: number;
  remainingAgents: number; // Infinity when unbounded
  tokens: number;
  costUsd: number;
  maxUsd: number | null;
  elapsedMs: number;
  maxWallClockMs: number | null;
}

export class Budget {
  private spentAgents = 0;
  private tokens = 0;
  private costUsd = 0;
  private denied: string | null = null;
  private readonly maxUsd: number | null;
  private readonly maxWallClockMs: number | null;
  private readonly startedAt: number;

  constructor(
    private readonly totalAgents: number | null,
    limits: BudgetLimits = {},
  ) {
    this.maxUsd = limits.maxUsd ?? null;
    this.maxWallClockMs = limits.maxWallClockMs ?? null;
    this.startedAt = limits.startedAt ?? Date.now();
  }

  /** The reason the budget is exhausted, or null if there's headroom. */
  stopReason(): string | null {
    if (this.totalAgents !== null && this.spentAgents >= this.totalAgents) return 'max agents reached';
    if (this.maxUsd !== null && this.costUsd >= this.maxUsd) return `cost limit $${this.maxUsd} reached`;
    if (this.maxWallClockMs !== null && Date.now() - this.startedAt >= this.maxWallClockMs) return 'time limit reached';
    return null;
  }

  /** Reserve one agent call. Returns false (without charging) if exhausted. */
  chargeAgent(): boolean {
    const stop = this.stopReason();
    if (stop) {
      this.denied = stop;
      return false;
    }
    this.spentAgents += 1;
    return true;
  }

  /**
   * Why a call was actually turned away, or null if none ever was. Distinct from
   * stopReason(), which only reports headroom: a run that lands exactly on its
   * cap is exhausted but denied nothing, so every slot it spent did real work.
   */
  deniedReason(): string | null {
    return this.denied;
  }

  addUsage(tokens: number, costUsd: number): void {
    this.tokens += Math.max(0, tokens || 0);
    this.costUsd += Math.max(0, costUsd || 0);
  }

  /** Restore prior spend (used on resume so cached calls don't re-charge). */
  seed(spentAgents: number, tokens: number, costUsd: number): void {
    this.spentAgents = spentAgents;
    this.tokens = tokens;
    this.costUsd = costUsd;
  }

  remainingAgents(): number {
    return this.totalAgents === null ? Infinity : Math.max(0, this.totalAgents - this.spentAgents);
  }

  canSpend(): boolean {
    return this.stopReason() === null;
  }

  snapshot(): BudgetSnapshot {
    return {
      totalAgents: this.totalAgents,
      spentAgents: this.spentAgents,
      remainingAgents: this.remainingAgents(),
      tokens: this.tokens,
      costUsd: this.costUsd,
      maxUsd: this.maxUsd,
      elapsedMs: Date.now() - this.startedAt,
      maxWallClockMs: this.maxWallClockMs,
    };
  }
}
