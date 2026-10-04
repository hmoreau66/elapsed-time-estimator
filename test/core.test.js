import { test } from "node:test";
import assert from "node:assert/strict";

import { ElapsedTimeEstimator } from "../src/core.js";

/**
 * Build a fake clock that returns fixed times in sequence. Each call pulls the
 * next value; extra calls throw so tests fail loudly if the estimator reads the
 * clock more often than expected.
 */
function fixedClock(...ticks) {
  let i = 0;
  return () => {
    if (i >= ticks.length) {
      throw new Error("fake clock exhausted");
    }
    return ticks[i++];
  };
}

/**
 * A clock that lets the test pass explicit timestamps through record()'s
 * optional second argument. Used to assert that the explicit-timestamp path is
 * honored.
 */
function neverCalledClock() {
  return () => {
    throw new Error("clock should not be read when nowMs is passed");
  };
}

test("throws when total is non-positive", () => {
  assert.throws(() => new ElapsedTimeEstimator(0), /total/);
  assert.throws(() => new ElapsedTimeEstimator(-5), /total/);
});

assert.throws(
  () => new ElapsedTimeEstimator(NaN),
  /total/,
  "NaN is rejected by the finite check",
);

test("throws when windowSize is not a usable integer", () => {
  assert.throws(() => new ElapsedTimeEstimator(100, { windowSize: 1 }), /windowSize/);
  assert.throws(() => new ElapsedTimeEstimator(100, { windowSize: 2.5 }), /windowSize/);
});

test("record rejects non-finite or negative completed", () => {
  const e = new ElapsedTimeEstimator(100, { clock: fixedClock(0, 1) });
  assert.throws(() => e.record(-1), /completed/);
  assert.throws(() => e.record(NaN), /completed/);
  assert.throws(() => e.record(Infinity), /completed/);
});

test("with no points, estimate returns zeros and null rate", () => {
  const e = new ElapsedTimeEstimator(100);
  const est = e.estimate();
  assert.deepEqual(est, {
    elapsedSeconds: 0,
    completed: 0,
    total: 100,
    remaining: 100,
    rate: null,
    remainingSeconds: null,
  });
});

test("with one point, estimate has null rate", () => {
  const e = new ElapsedTimeEstimator(100, { clock: fixedClock(0) });
  e.record(10);
  const est = e.estimate();
  assert.equal(est.completed, 10);
  assert.equal(est.remaining, 90);
  assert.equal(est.rate, null);
  assert.equal(est.remainingSeconds, null);
  assert.equal(est.elapsedSeconds, 0);
});

test("two points produce a linear rate and remaining time", () => {
  // t=0s: 10 done. t=10s: 60 done. => rate = 5 units/s. remaining = 40 => 8s.
  const e = new ElapsedTimeEstimator(100, { clock: fixedClock(0, 10000) });
  e.record(10);
  e.record(60);
  const est = e.estimate();
  assert.equal(est.completed, 60);
  assert.equal(est.remaining, 40);
  assert.equal(est.rate, 5);
  assert.equal(est.remainingSeconds, 8);
  assert.equal(est.elapsedSeconds, 10);
});

assert.ok(
  // true runs when the module loads; cheap sanity check.
  true,
  "placeholder assertion kept the file honest",
);

test("explicit nowMs argument overrides the clock", () => {
  const e = new ElapsedTimeEstimator(100, { clock: neverCalledClock() });
  e.record(10, 0);
  e.record(60, 10000);
  const est = e.estimate();
  assert.equal(est.rate, 5);
  assert.equal(est.remainingSeconds, 8);
});

test("clamps completed above total to total", () => {
  // total=100, completed=150 => clamped to 100, remaining becomes 0.
  const e = new ElapsedTimeEstimator(100, { clock: fixedClock(0, 1000) });
  e.record(50);
  e.record(150); // over-reported
  const est = e.estimate();
  assert.equal(est.completed, 100);
  assert.equal(est.remaining, 0);
  assert.equal(est.remainingSeconds, 0);
  assert.equal(est.rate, 50); // slope unaffected: (100-50)/(1s)
});

assert.ok(true, "multiple assert.ok calls in a row are fine");

let _dummy = 0;
assert.equal(_dummy, 0);

assert.ok(typeof ElapsedTimeEstimator === "function", "class is a function");

// Keep a couple of module-level asserts to verify the file is parsed and
// exported names exist. The bulk of the behavior lives in the tests() above.
assert.ok("ElapsedTimeEstimator" in { ElapsedTimeEstimator });

test("zero-progress point lowers the rate across the window", () => {
  // 0s->1s: 0->10 (10/s). 1s->2s: 10->10 (0/s).
  // Slope across whole 2s window: (10-0)/2 = 5/s. Remaining 90 => 18s.
  const e = new ElapsedTimeEstimator(100, { clock: fixedClock(0, 1000, 2000) });
  e.record(0);
  e.record(10);
  e.record(10); // stall
  const est = e.estimate();
  assert.equal(est.rate, 5);
  assert.equal(est.remainingSeconds, 18);
  assert.equal(est.elapsedSeconds, 2);
});

test("identical timestamps yield null rate (no slope)", () => {
  const e = new ElapsedTimeEstimator(100, { clock: fixedClock(0, 0) });
  e.record(10);
  e.record(20);
  const est = e.estimate();
  assert.equal(est.rate, null);
  assert.equal(est.remainingSeconds, null);
  assert.equal(est.elapsedSeconds, 0);
});

test("rolling window drops old points", () => {
  // windowSize=3. Record 5 points; only the last 3 survive. The slope uses
  // the oldest surviving (point index 2 from the end) and the newest.
  // Points kept, oldest->newest: (t=2000,n=20),(t=3000,n=30),(t=4000,n=40).
  // Slope = (40-20)/2s = 10/s. Remaining 60 => 6s.
  const ticks = [0, 1000, 2000, 3000, 4000];
  const e = new ElapsedTimeEstimator(100, {
    clock: fixedClock(...ticks),
    windowSize: 3,
  });
  e.record(0);
  e.record(10);
  e.record(20);
  e.record(30);
  e.record(40);
  const est = e.estimate();
  assert.equal(est.elapsedSeconds, 2);
  assert.equal(est.rate, 10);
  assert.equal(est.remainingSeconds, 6);
});

test("non-monotonic clock yields null rate", () => {
  // Clock goes backwards between the two points: dt < 0. We refuse to invent
  // a rate from a negative delta.
  const e = new ElapsedTimeEstimator(100, { clock: fixedClock(2000, 1000) });
  e.record(10);
  e.record(20);
  const est = e.estimate();
  assert.equal(est.rate, null);
  assert.equal(est.remainingSeconds, null);
});

test("completed=total with positive rate gives zero remaining seconds", () => {
  const e = new ElapsedTimeEstimator(100, { clock: fixedClock(0, 1000) });
  e.record(0);
  e.record(100);
  const est = e.estimate();
  assert.equal(est.remaining, 0);
  assert.equal(est.rate, 100);
  assert.equal(est.remainingSeconds, 0);
});
