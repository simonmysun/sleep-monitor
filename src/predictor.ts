import type { SleepEvent, Timestamp } from "./types.d.ts";
import { HOUR_IN_MS, DAY_IN_MS } from "./consts.ts";

export interface ModelConfig {
  lambdaA: number; // acute decay rate (per hour), default 0.3
  lambdaB: number; // chronic decay rate (per hour), default 0.04
  kUp: number; // fatigue growth rate during wakefulness
  kDown: number; // fatigue recovery rate during sleep
  eta: number; // coupling coefficient: how fast A feeds into B
  c: number; // baseline offset in dB/dt = η(A+c) − λ_B·B
  weightB: number; // chronic fatigue weight in total F
  threshold: number; // crash threshold
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  lambdaA: 0.3,
  lambdaB: 0.04,
  kUp: 1.0,
  kDown: 2.0,
  eta: 0.1,
  c: 0.0,
  weightB: 0.3,
  threshold: 5.0,
};

interface Segment {
  start: number; // ms
  end: number; // ms
  type: "sleep" | "wake";
}

export interface FatigueStatus {
  time: Timestamp;
  acuteFatigue: number;
  chronicFatigue: number;
  totalFatigue: number;
}

export interface ForecastPoint {
  time: Timestamp;
  totalFatigue: number;
  zone: "safe" | "warning" | "danger";
}

export interface PredictionResult {
  currentStatus: FatigueStatus;
  history: FatigueStatus[];
  forecast: ForecastPoint[];
  crashPoint: Timestamp | null;
  crashInHours: number | null;
  sleepEvents: SleepEvent[];
  config: ModelConfig;
  wokeUpHoursAgo: number;
  forecastHours: number;
}

const ACUTE_LOOKBACK_HOURS = 168;
const CHRONIC_LOOKBACK_DAYS = 14;
const CHRONIC_STEP_MINUTES = 30; // resolution for B's numerical ODE integration

export class Predictor {
  private events: SleepEvent[];
  private config: ModelConfig;

  constructor(
    events: SleepEvent[],
    config: ModelConfig = DEFAULT_MODEL_CONFIG,
  ) {
    this.events = events
      .filter((e) => e.start < e.end)
      .sort((a, b) => a.start - b.start);
    this.config = config;
  }

  /**
   * Build alternating sleep/wake segments within [windowStart, windowEnd].
   * Events are clamped to the window boundaries.
   */
  private buildSegments(windowStart: number, windowEnd: number): Segment[] {
    const segments: Segment[] = [];
    const relevant: SleepEvent[] = [];

    for (const event of this.events) {
      if (event.end <= windowStart || event.start >= windowEnd) continue;
      relevant.push({
        start: Math.max(event.start, windowStart),
        end: Math.min(event.end, windowEnd),
      });
    }

    let cursor = windowStart;
    for (const event of relevant) {
      if (cursor < event.start) {
        segments.push({ start: cursor, end: event.start, type: "wake" });
      }
      segments.push({ start: event.start, end: event.end, type: "sleep" });
      cursor = event.end;
    }

    if (cursor < windowEnd) {
      segments.push({ start: cursor, end: windowEnd, type: "wake" });
    }

    return segments;
  }

  /**
   * Compute contribution of a single segment to fatigue at time t using
   * the exponential decay integral:
   *   ΔA = (V / λ) · (e^{-λ(t−t_end)} − e^{-λ(t−t_start)})
   * Times are converted to hours internally.
   */
  private segmentContribution(
    segment: Segment,
    t: number,
    lambda: number,
  ): number {
    const V = segment.type === "wake" ? this.config.kUp : -this.config.kDown;
    const dtEnd = (t - segment.end) / HOUR_IN_MS;
    const dtStart = (t - segment.start) / HOUR_IN_MS;

    // Only count fully past segments
    if (dtEnd < 0) return 0;

    return (
      (V / lambda) * (Math.exp(-lambda * dtEnd) - Math.exp(-lambda * dtStart))
    );
  }

  /**
   * Acute fatigue A(t): short-memory exponential integral over past 72 h.
   */
  private calculateAcuteFatigue(t: number): number {
    const windowStart = t - ACUTE_LOOKBACK_HOURS * HOUR_IN_MS;
    const segments = this.buildSegments(windowStart, t);
    let A = 0;
    for (const seg of segments) {
      A += this.segmentContribution(seg, t, this.config.lambdaA);
    }
    return A;
  }

  /**
   * Chronic fatigue B(t): numerical ODE integration of
   *   dB/dt = η·(A(t) + c) − λ_B·B
   * Solved by stepping through the past CHRONIC_LOOKBACK_DAYS at
   * CHRONIC_STEP_MINUTES resolution. B genuinely lags behind A.
   */
  private calculateChronicFatigue(t: number): number {
    const windowStart = t - CHRONIC_LOOKBACK_DAYS * DAY_IN_MS;
    const stepMs = CHRONIC_STEP_MINUTES * 60 * 1000;
    const dtH = CHRONIC_STEP_MINUTES / 60; // step size in hours
    const { lambdaB, eta, c } = this.config;
    const steps = Math.ceil((t - windowStart) / stepMs);

    let B = 0;
    for (let i = 0; i < steps; i++) {
      const tau = windowStart + i * stepMs;
      const A = this.calculateAcuteFatigue(tau);
      // Exact ODE step assuming A is constant over [tau, tau+dt]:
      //   B(t+dt) = B(t)·e^{-λ_B·dt} + η·(A+c)/λ_B · (1 − e^{-λ_B·dt})
      const decay = Math.exp(-lambdaB * dtH);
      B = B * decay + ((eta * (A + c)) / lambdaB) * (1 - decay);
    }
    return B;
  }

  /**
   * Full fatigue status at a given time.
   *   F(t) = (1 - w) · A(t) + w · B(t)
   */
  calculateCurrentStatus(time: number): FatigueStatus {
    const A = this.calculateAcuteFatigue(time);
    const B = this.calculateChronicFatigue(time);
    const F = (1 - this.config.weightB) * A + this.config.weightB * B;
    return { time, acuteFatigue: A, chronicFatigue: B, totalFatigue: F };
  }

  private getZone(fatigue: number): "safe" | "warning" | "danger" {
    const { threshold } = this.config;
    if (fatigue >= threshold) return "danger";
    if (fatigue >= threshold * 0.7) return "warning";
    return "safe";
  }

  /**
   * Simulate the next `hours` under "continuous wakefulness" assumption.
   * B is continued incrementally from `bStart`.
   *
   * Returns { forecast, crashPoint }.
   */
  private computeForecast(
    hours: number = 24,
    stepMinutes: number = 15,
    bStart: number = 0,
  ): { forecast: ForecastPoint[]; crashPoint: Timestamp | null } {
    const now = Date.now();
    const points: ForecastPoint[] = [];
    const steps = Math.ceil((hours * 60) / stepMinutes);
    const stepMs = stepMinutes * 60 * 1000;
    const dtH = stepMinutes / 60;
    const { lambdaB, eta, c, weightB, threshold } = this.config;

    let B = bStart;
    let crashPoint: Timestamp | null = null;

    for (let i = 0; i <= steps; i++) {
      const t = now + i * stepMs;
      const A = this.calculateAcuteFatigue(t);

      if (i > 0) {
        const decay = Math.exp(-lambdaB * dtH);
        B = B * decay + ((eta * (A + c)) / lambdaB) * (1 - decay);
      }

      const F = (1 - weightB) * A + weightB * B;
      points.push({ time: t, totalFatigue: F, zone: this.getZone(F) });

      if (crashPoint === null && F >= threshold) {
        // Refine crash point between previous step and this one
        if (i === 0) {
          crashPoint = t;
        } else {
          crashPoint = this.refineCrashPoint(t - stepMs, t);
        }
      }
    }
    return { forecast: points, crashPoint };
  }

  private refineCrashPoint(
    lo: number,
    hi: number,
    precision: number = 60_000, // 1 minute
  ): number {
    while (hi - lo > precision) {
      const mid = (lo + hi) / 2;
      if (
        this.calculateCurrentStatus(mid).totalFatigue >= this.config.threshold
      ) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return Math.round(hi);
  }

  /**
   * Historical fatigue curve for the past `days` days, sampled every `stepMinutes`.
   * B is computed incrementally via ODE stepping (warmed up over CHRONIC_LOOKBACK_DAYS
   * before the visible history window).
   *
   * Returns { history, bAtEnd } so the caller can continue B forward into forecast.
   */
  private computeHistory(
    days: number = 7,
    stepMinutes: number = 15,
  ): { history: FatigueStatus[]; bAtEnd: number } {
    const now = Date.now();
    const historyStart = now - days * DAY_IN_MS;
    const warmupStart = historyStart - CHRONIC_LOOKBACK_DAYS * DAY_IN_MS;
    const stepMs = stepMinutes * 60 * 1000;
    const dtH = stepMinutes / 60;
    const { lambdaB, eta, c, weightB } = this.config;

    const totalSteps = Math.ceil((now - warmupStart) / stepMs);
    const points: FatigueStatus[] = [];
    let B = 0;

    for (let i = 0; i <= totalSteps; i++) {
      const t = warmupStart + i * stepMs;
      const A = this.calculateAcuteFatigue(t);

      // ODE step: B(t+dt) = B(t)·e^{-λ_B·dt} + η·(A+c)/λ_B · (1 − e^{-λ_B·dt})
      if (i > 0) {
        const decay = Math.exp(-lambdaB * dtH);
        B = B * decay + ((eta * (A + c)) / lambdaB) * (1 - decay);
      }

      if (t >= historyStart) {
        const F = (1 - weightB) * A + weightB * B;
        points.push({
          time: t,
          acuteFatigue: A,
          chronicFatigue: B,
          totalFatigue: F,
        });
      }
    }
    return { history: points, bAtEnd: B };
  }

  getLastWakeUp(): Timestamp {
    const now = Date.now();
    let lastWakeUp = -Infinity;
    for (const event of this.events) {
      if (event.end <= now && event.end > lastWakeUp) {
        lastWakeUp = event.end;
      }
    }
    return lastWakeUp;
  }

  getRecentSleepEvents(days: number = 7): SleepEvent[] {
    const cutoff = Date.now() - days * DAY_IN_MS;
    return this.events.filter((e) => e.end > cutoff);
  }

  /**
   * Full prediction: current status, history, forecast, crash point.
   *
   * Computes everything in one efficient pass:
   *   1. History (with B warmup) → gives B(now)
   *   2. Current status from last history point
   *   3. Forecast continuing B(now) forward incrementally
   */
  predict(
    historyDays: number = 7,
    forecastHours: number = 24,
  ): PredictionResult {
    const now = Date.now();
    const lastWakeUp = this.getLastWakeUp();
    const wokeUpHoursAgo =
      lastWakeUp > 0 ? (now - lastWakeUp) / HOUR_IN_MS : -1;

    // 1. History with incremental B (includes warmup period)
    const { history, bAtEnd } = this.computeHistory(historyDays);

    // 2. Current status using B(now) from history
    const Anow = this.calculateAcuteFatigue(now);
    const Fnow =
      (1 - this.config.weightB) * Anow + this.config.weightB * bAtEnd;
    const currentStatus: FatigueStatus = {
      time: now,
      acuteFatigue: Anow,
      chronicFatigue: bAtEnd,
      totalFatigue: Fnow,
    };

    // 3. Forecast continuing from B(now)
    const { forecast, crashPoint } = this.computeForecast(
      forecastHours,
      15,
      bAtEnd,
    );
    const crashInHours =
      crashPoint !== null ? (crashPoint - now) / HOUR_IN_MS : null;

    return {
      currentStatus,
      history,
      forecast,
      crashPoint,
      crashInHours,
      sleepEvents: this.getRecentSleepEvents(historyDays),
      config: this.config,
      wokeUpHoursAgo,
      forecastHours,
    };
  }
}
