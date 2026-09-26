export class RateLimiter {
  private tokens: number;
  private capacity: number;
  private refillRatePerSec: number;
  private lastRefill: number;

  constructor(capacity: number, refillRatePerSec: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error("capacity must be a positive finite number");
    }
    if (!Number.isFinite(refillRatePerSec) || refillRatePerSec < 0) {
      throw new Error("refillRatePerSec must be a non-negative finite number");
    }
    this.capacity = capacity;
    this.refillRatePerSec = refillRatePerSec;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(now: number): void {
    if (this.refillRatePerSec === 0) return;
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;
    const added = (elapsedMs / 1000) * this.refillRatePerSec;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefill = now;
  }

  allow(): boolean {
    const now = Date.now();
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

