# Elapsed Time Estimator

A small, dependency-free TypeScript library that estimates the remaining time for a long-running task by computing the rate of progress over a rolling window of completed-unit checkpoints.

## Usage

```js
import { ElapsedTimeEstimator } from "elapsed-time-estimator";

// 1000 items to process; keep the last 20 progress points.
const est = new ElapsedTimeEstimator(1000, { windowSize: 20 });

// Call record(completed) whenever progress changes (or on a timer).
est.record(100);  // 100 items done
// ...later...
est.record(250);  // 250 items done

const { rate, remaining, remainingSeconds, elapsedSeconds } = est.estimate();
// rate: items per second across the window
// remainingSeconds: projected time to finish, or null if not yet computable
```

The constructor also accepts a `clock` function returning milliseconds, so you can inject a fake clock in tests instead of reading wall time.

## Why

The problem: a long-running job reports how many units it has finished. You want to tell the user when it will be done, without the estimate jumping around every time a batch lands slowly. A rolling window over recent progress gives a stable, honest slope without the lag of a global average and without the tunable complexity of an exponential smoother.

The trade-off: the estimate only reflects recent behavior. If the task speeds up or stalls outside the window, the projection will not reflect that until enough new points arrive. That is the point — the window is the memory, and the window size is the only knob.

## Edge case you will hit

If the two timestamps at the window's edges are identical (for example two `record()` calls in the same millisecond, or a non-monotonic clock), the rate is reported as `null` and `remainingSeconds` is `null` rather than `Infinity`. The library refuses to fabricate a rate it cannot compute honestly. Before the first two distinct-time points exist, `rate` and `remainingSeconds` are also `null`.
