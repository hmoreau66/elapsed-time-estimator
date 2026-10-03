/**
 * Core estimator for remaining time on a long-running task.
 *
 * The estimator is given a total number of units (for example, items to process)
 * and the number of those units already finished. Each time progress changes,
 * the caller calls record() with the completed count. The estimator keeps the
 * most recent reports (a rolling window) and uses them to compute a rate of
 * progress (units per second). That rate is then used to project the remaining
 * time as (remaining units) / (rate).
 *
 * IMPORTANT CHOICE: we do NOT smooth the rate with an exponential moving
 * average or a regression over the whole history. We use a simple rolling
 * average over the window's time span. The rationale: the simplest formula that
 * behaves predictably is (last_n - first_n) / (last_t - first_t). It only needs
 * to look at two points and degrades gracefully when the window is tiny. An
 * exponential smoother would be one more knob to misconfigure and one more way
 * for the rate to lag reality in the tests. If you need EMA, this is not the
 * library for it.
 *
 * Another deliberate choice: rate is computed from the first and last points
 * in the window, NOT by averaging per-interval speeds. Averaging per-interval
 * speeds is mathematically incorrect when intervals have different lengths
 * (it overweights short intervals). The two-point formula is the honest slope.
 */

/**
 * @typedef {(nowMs?: number) => number} Clock
 */

/**
 * Default clock. Reads Date.now so tests never touch the real clock by
 * accident; the test suite always injects a fake.
 * @type {Clock}
 */
const defaultClock = () => Date.now();

/**
 * @typedef {Object} Estimate
 * @property {number} elapsedSeconds Time in seconds between the first
 *     recorded point in the window and the most recent one. Always 0 if fewer
 *     than two points have been recorded.
 * @property {number} completed Units reported in the most recent record().
 * @property {number} total Total units the task is expected to cover.
 * @property {number} remaining total - completed. Never negative.
 * @property {number|null} rate Units per second, computed as the slope of the
 *     earliest and latest points in the rolling window. null when fewer than
 *     two distinct timestamps exist, or when the two timestamps are identical
 *     (slope undefined).
 * @property {number|null} remainingSeconds remaining / rate, or null when
 *     rate is null or not positive.
 */

export class ElapsedTimeEstimator {
  /**
   * @param {number} total Total units the task covers. Must be finite and
   *     greater than 0. Fractional totals are allowed.
   * @param {Object} [opts]
   * @param {Clock} [opts.clock] Function returning current time in
   *     milliseconds. Defaults to Date.now via a wrapper.
   * @param {number} [opts.windowSize] Maximum number of progress points to
   *     retain. Must be at least 2. Default 20.
   */
  constructor(total, opts = {}) {
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error(`total must be a finite, positive number; got ${total}`);
    }
    const windowSize = opts.windowSize ?? 20;
    if (!Number.isInteger(windowSize) || windowSize < 2) {
      throw new Error(
        `windowSize must be an integer >= 2; got ${windowSize}`,
      );
    }
    this._total = total;
    this._windowSize = windowSize;
    /** @type {Clock} */
    this._clock = opts.clock ?? defaultClock;
    /**
     * Points kept newest-first. We push to the front and trim the tail in
     * record() so index 0 is always the most recent sample. The estimator only
     * ever reads points[0] and points[length-1] for the slope, so the internal
     * ordering direction does not change the math.
     * @type {{t: number, n: number}[]}
     */
    this._points = [];
  }

  /**
   * Record progress. If completed has not changed since the last call, the new
   * point is still stored. We intentionally allow zero-progress points because
   * a stall is useful signal: it lowers the rolling rate, which raises the
   * remaining-time estimate. Discarding zero-progress points would silently
   * hide stalls.
   *
   * @param {number} completed Number of units finished so far. Must be a
   *     finite number >= 0 and <= total. Values greater than total are clamped
   *     to total so a caller cannot make remaining negative.
   * @param {number} [nowMs] Optional explicit timestamp in milliseconds.
   *     Usually omitted in production (the injected clock is read). Provided
   *     for tests that prefer to thread time through explicitly.
   */
  record(completed, nowMs) {
    if (!Number.isFinite(completed) || completed < 0) {
      throw new Error(
        `completed must be a finite, non-negative number; got ${completed}`,
      );
    }
    const n = completed > this._total ? this._total : completed;
    const t = nowMs ?? this._clock();
    if (!Number.isFinite(t)) {
      throw new Error(`clock returned non-finite value: ${t}`);
    }
    this._points.unshift({ t, n });
    if (this._points.length > this._windowSize) {
      this._points.length = this._windowSize;
    }
  }

  /**
   * Compute the current estimate. See the Estimate typedef for the shape.
   * @returns {Estimate}
   */
  estimate() {
    const latest = this._points[0] ?? null;
    const completed = latest ? latest.n : 0;
    const remaining = Math.max(0, this._total - completed);

    if (this._points.length < 2) {
      return {
        elapsedSeconds: 0,
        completed,
        total: this._total,
        remaining,
        rate: null,
        remainingSeconds: null,
      };
    }

    const head = this._points[0];
    const tail = this._points[this._points.length - 1];
    const dtMs = head.t - tail.t;
    const elapsedSeconds = dtMs / 1000;

    if (!(dtMs > 0)) {
      // dtMs <= 0 means either the two timestamps are identical (slope
      // undefined) or somehow non-monotonic (clock went backwards). In both
      // cases we refuse to synthesize a rate; null propagates honestly.
      return {
        elapsedSeconds,
        completed,
        total: this._total,
        remaining,
        rate: null,
        remainingSeconds: null,
      };
    }

    const dn = head.n - tail.n;
    const rate = dn / elapsedSeconds;

    if (!(rate > 0)) {
      // rate <= 0: no forward progress across the window, or clock jitter.
      // Cannot project a completion time from a non-positive rate.
      return {
        elapsedSeconds,
        completed,
        total: this._total,
        remaining,
        rate: rate <= 0 ? 0 : rate,
        remainingSeconds: null,
      };
    }

    const remainingSeconds = remaining / rate;
    return {
      elapsedSeconds,
      completed,
      total: this._total,
      remaining,
      rate,
      remainingSeconds,
    };
  }
}
