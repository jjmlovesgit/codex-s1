export class TokenBucket {
  private capacity: number;
  private refillRatePerSecond: number;
  private tokens: number;
  private lastRefillTimestamp: number;

  constructor(options: { capacity: number; refillRatePerSecond: number }) {
    if (typeof options.capacity !== 'number' || typeof options.refillRatePerSecond !== 'number') {
      throw new TypeError('capacity and refillRatePerSecond must be numbers');
    }
    if (!Number.isFinite(options.capacity) || options.capacity <= 0) {
      throw new RangeError('capacity must be a positive finite number');
    }
    if (!Number.isFinite(options.refillRatePerSecond) || options.refillRatePerSecond < 0) {
      throw new RangeError('refillRatePerSecond must be a non-negative finite number');
    }

    this.capacity = options.capacity;
    this.refillRatePerSecond = options.refillRatePerSecond;
    this.tokens = options.capacity;
    this.lastRefillTimestamp = performance.now();
  }

  public consume(tokens: number = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = performance.now();
    const elapsedSeconds = (now - this.lastRefillTimestamp) / 1000;
    const tokensToAdd = elapsedSeconds * this.refillRatePerSecond;
    this.tokens = Math.min(this.tokens + tokensToAdd, this.capacity);
    this.lastRefillTimestamp = now;
  }

  public getTokens(): number {
    this.refill();
    return this.tokens;
  }

  public reset(): void {
    this.tokens = this.capacity;
    this.lastRefillTimestamp = performance.now();
  }
}

