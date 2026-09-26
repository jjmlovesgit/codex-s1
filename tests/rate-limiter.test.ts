import assert from "node:assert/strict";
import { RateLimiter } from "../src/rate-limiter";

export default async function run(): Promise<void> {
  const realDateNow = Date.now;
  let fakeNow = 1_000_000;
  (Date as any).now = () => fakeNow;

  try {
    // Constructor validation
    assert.throws(() => new RateLimiter(0, 10), /capacity/);
    assert.throws(() => new RateLimiter(-5, 10), /capacity/);
    assert.throws(() => new RateLimiter(Infinity, 10), /capacity/);
    assert.throws(() => new RateLimiter(10, -1), /refillRatePerSec/);
    assert.throws(() => new RateLimiter(10, NaN), /refillRatePerSec/);

    // Exhaustion
    {
      fakeNow = 1_000_000;
      const rl = new RateLimiter(3, 10);
      assert.equal(rl.allow(), true);
      assert.equal(rl.allow(), true);
      assert.equal(rl.allow(), true);
      assert.equal(rl.allow(), false);
    }

    // Refill
    {
      fakeNow = 1_000_000;
      const rl = new RateLimiter(5, 10);
      for (let i = 0; i < 5; i++) rl.allow();
      assert.equal(rl.allow(), false);
      fakeNow += 1000; // 1s -> +10 tokens, capped at 5
      assert.equal(rl.allow(), true);
      assert.equal(rl.allow(), true);
      assert.equal(rl.allow(), true);
      assert.equal(rl.allow(), true);
      assert.equal(rl.allow(), true);
      assert.equal(rl.allow(), false);
    }

    // Capacity capping
    {
      fakeNow = 1_000_000;
      const rl = new RateLimiter(2, 100);
      rl.allow();
      rl.allow();
      assert.equal(rl.allow(), false);
      fakeNow += 10_000; // 10s -> +1000 tokens, capped at 2
      assert.equal(rl.allow(), true);
      assert.equal(rl.allow(), true);
      assert.equal(rl.allow(), false);
    }

    // Zero refill
    {
      fakeNow = 1_000_000;
      const rl = new RateLimiter(4, 0);
      for (let i = 0; i < 4; i++) assert.equal(rl.allow(), true);
      assert.equal(rl.allow(), false);
      fakeNow += 999_999;
      assert.equal(rl.allow(), false);
    }

    // Partial refill
    {
      fakeNow = 1_000_000;
      const rl = new RateLimiter(10, 10);
      for (let i = 0; i < 10; i++) rl.allow();
      assert.equal(rl.allow(), false);
      fakeNow += 500; // 0.5s -> +5 tokens
      for (let i = 0; i < 5; i++) assert.equal(rl.allow(), true);
      assert.equal(rl.allow(), false);
    }
  } finally {
    (Date as any).now = realDateNow;
  }
}

