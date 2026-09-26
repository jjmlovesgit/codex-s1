const assert = require("node:assert/strict");
const { RateLimiter } = require("../src/rate-limiter");

async function main() {
  const realDateNow = Date.now;
  let fakeNow = 1_000_000;
  Date.now = () => fakeNow;

  try {
    assert.throws(() => new RateLimiter(0, 10), /capacity/);
    assert.throws(() => new RateLimiter(-5, 10), /capacity/);
    assert.throws(() => new RateLimiter(Infinity, 10), /capacity/);
    assert.throws(() => new RateLimiter(10, -1), /refillRatePerSec/);
    assert.throws(() => new RateLimiter(10, NaN), /refillRatePerSec/);

    fakeNow = 1_000_000;
    let rl = new RateLimiter(3, 10);
    assert.equal(rl.allow(), true);
    assert.equal(rl.allow(), true);
    assert.equal(rl.allow(), true);
    assert.equal(rl.allow(), false);

    fakeNow = 1_000_000;
    rl = new RateLimiter(5, 10);
    for (let i = 0; i < 5; i++) rl.allow();
    assert.equal(rl.allow(), false);
    fakeNow += 1000;
    for (let i = 0; i < 5; i++) assert.equal(rl.allow(), true);
    assert.equal(rl.allow(), false);

    fakeNow = 1_000_000;
    rl = new RateLimiter(2, 100);
    rl.allow();
    rl.allow();
    assert.equal(rl.allow(), false);
    fakeNow += 10_000;
    assert.equal(rl.allow(), true);
    assert.equal(rl.allow(), true);
    assert.equal(rl.allow(), false);

    fakeNow = 1_000_000;
    rl = new RateLimiter(4, 0);
    for (let i = 0; i < 4; i++) assert.equal(rl.allow(), true);
    assert.equal(rl.allow(), false);
    fakeNow += 999_999;
    assert.equal(rl.allow(), false);

    fakeNow = 1_000_000;
    rl = new RateLimiter(10, 10);
    for (let i = 0; i < 10; i++) rl.allow();
    assert.equal(rl.allow(), false);
    fakeNow += 500;
    for (let i = 0; i < 5; i++) assert.equal(rl.allow(), true);
    assert.equal(rl.allow(), false);
  } finally {
    Date.now = realDateNow;
  }
}

main().then(
  () => {
    console.log("PASS");
    process.exit(0);
  },
  (err) => {
    console.error("FAIL", err);
    process.exit(1);
  }
);
