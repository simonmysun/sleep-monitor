import type {
  AngleInRad,
  DurationInHour,
  Debt,
  Weight,
  Timestamp,
} from "./types.d.ts";

import {
  TAU_MIN,
  TAU_MAX,
  PHASE_SLEEP_CENTER,
  MINUTE_IN_MS,
  HOUR_IN_MS,
} from "./consts.ts";

import { clamp, wrapPhase, sigmoid, randn } from "./math-utils.ts";
import type { CalendarComponent } from "ical";

type Particle = {
  phase: AngleInRad; // φ ∈ [0, 2π)
  tau: DurationInHour; // 生理周期（小时）
  debt: Debt; // 睡眠债 / 疲劳（无量纲）
  weight: Weight;
  lastTime: Timestamp; // 时间戳（ms）
};

type ModelParams = {
  fatigueRate: number; // 原 0.15
  recoveryRate: number; // 原 0.8
  phaseWeight: number; // 原 2.0
  debtWeight: number; // 原 1.5
};

const HISTORY_DAYS = 45;

export class SleepPredictor {
  private particles: Particle[] = [];
  private readonly N = 200;
  private params: ModelParams = {
    fatigueRate: 0.15,
    recoveryRate: 0.8,
    phaseWeight: 2.0,
    debtWeight: 1.5,
  };

  constructor(now: Date) {
    const t = now.getTime();
    for (let i = 0; i < this.N; i++) {
      this.particles.push({
        phase: Math.random() * Math.PI * 2,
        tau: TAU_MIN + Math.random() * (TAU_MAX - TAU_MIN),
        debt: Math.random(),
        weight: 1 / this.N,
        lastTime: t,
      });
    }
  }

  advanceTo(now: Date) {
    const t = now.getTime();

    for (const p of this.particles) {
      const dtHours = (t - p.lastTime) / HOUR_IN_MS;
      if (dtHours <= 0) continue;

      // 相位推进
      p.phase = wrapPhase(p.phase + (Math.PI * 2 * dtHours) / p.tau);

      // 疲劳累积（相位调制）
      const phaseFactor = 1 + 0.3 * Math.cos(p.phase);
      p.debt += 0.15 * dtHours * phaseFactor;

      // τ 漂移
      p.tau += randn() * 0.02;
      p.tau = clamp(p.tau, TAU_MIN, TAU_MAX);

      p.lastTime = t;
    }
  }

  private adaptParameters(sleepDurationH: number) {
    // 平均预测睡眠概率
    const avgProb = this.particles.reduce(
      (s, p) =>
        s +
        p.weight *
          sigmoid(
            this.params.phaseWeight * Math.cos(p.phase - PHASE_SLEEP_CENTER) +
              this.params.debtWeight * p.debt,
          ),
      0,
    );

    const error = 1 - avgProb; // 你真的睡了

    const lr = 0.02; // 很小，防抖

    // 如果模型低估了睡意 → 提高权重
    this.params.phaseWeight += lr * error;
    this.params.debtWeight += lr * error;

    // 睡眠时长 vs 预期
    const avgDebt = this.particles.reduce((s, p) => s + p.debt * p.weight, 0);

    const expected = 1.5 + 2.5 * avgDebt;
    const durationError = sleepDurationH - expected;

    this.params.recoveryRate += 0.01 * durationError;
    this.params.recoveryRate = clamp(this.params.recoveryRate, 0.3, 1.2);

    this.params.fatigueRate = clamp(this.params.fatigueRate, 0.05, 0.3);
  }

  updateWithSleep(event: CalendarComponent) {
    const start = event.start!.getTime();
    const end = event.end!.getTime();
    const durationH = (end - start) / HOUR_IN_MS;

    // 1️⃣ 推进到入睡时刻（清醒阶段）
    this.advanceTo(event.start!);

    let weightSum = 0;

    // 2️⃣ 用「你真的在这时睡了」来更新权重
    for (const p of this.particles) {
      const phaseTerm = Math.cos(p.phase - PHASE_SLEEP_CENTER);

      // 入睡概率模型
      const sleepProb = sigmoid(
        this.params.phaseWeight * phaseTerm + this.params.debtWeight * p.debt,
      );

      // 睡眠时长似然（长睡 = 睡前更累）
      const expectedDuration = 1.5 + 2.5 * p.debt;

      const durationError = durationH - expectedDuration;

      const durationLikelihood = Math.exp(
        (-0.5 * durationError ** 2) / 1.0 ** 2,
      );

      p.weight *= sleepProb * durationLikelihood;
      weightSum += p.weight;
    }

    // 3️⃣ 权重归一化
    if (weightSum > 0) {
      for (const p of this.particles) {
        p.weight /= weightSum;
      }
    }

    // 4️⃣ 睡眠阶段：相位推进 + 疲劳恢复
    for (const p of this.particles) {
      // 相位继续自然推进（你睡着了，生理钟还在走）
      p.phase = wrapPhase(p.phase + (Math.PI * 2 * durationH) / p.tau);

      // ⭐ 疲劳恢复（这里是你问的重点）
      p.debt = Math.max(0, p.debt - this.params.recoveryRate * durationH);

      p.lastTime = end;
    }

    // 5️⃣ 重采样（防止退化）
    this.resample();

    // 6️⃣ 在线自适应参数
    this.adaptParameters(durationH);
  }

  private resample() {
    const newParticles: Particle[] = [];
    const cdf: number[] = [];
    let acc = 0;

    for (const p of this.particles) {
      acc += p.weight;
      cdf.push(acc);
    }

    for (let i = 0; i < this.N; i++) {
      const r = Math.random();
      const idx = cdf.findIndex((v) => v >= r);
      const base = this.particles[Math.max(0, idx)];

      newParticles.push({
        ...base,
        weight: 1 / this.N,
      });
    }

    this.particles = newParticles;
  }

  getUncertainty() {
    const mean = <K extends keyof Particle>(k: K) =>
      this.particles.reduce((s, p) => s + p[k] * p.weight, 0);

    const variance = <K extends keyof Particle>(k: K) => {
      const m = mean(k);
      return this.particles.reduce((s, p) => s + p.weight * (p[k] - m) ** 2, 0);
    };

    return {
      tauStd: Math.sqrt(variance("tau")),
      debtStd: Math.sqrt(variance("debt")),
      phaseStd: Math.sqrt(variance("phase")),
    };
  }

  predictRemainingAwake(now: Date) {
    this.advanceTo(now);

    const samples: number[] = [];

    for (const p of this.particles) {
      // 定义一个“崩溃阈值”
      const threshold = 3.0;

      const remainingH = (threshold - p.debt) / 0.15;

      samples.push(Math.max(0, remainingH));
    }

    samples.sort((a, b) => a - b);

    const uncertainty = this.getUncertainty();
    const confidence = Math.exp(
      -0.5 *
        (uncertainty.tauStd / 2 + uncertainty.debtStd + uncertainty.phaseStd),
    );

    return {
      p50: samples[Math.floor(samples.length * 0.5)],
      p25: samples[Math.floor(samples.length * 0.25)],
      p75: samples[Math.floor(samples.length * 0.75)],
      min: samples[0],
      max: samples[samples.length - 1],
      uncertainty: clamp(confidence, 0, 1),
    };
  }

  getDebugState() {
    const avg = <K extends keyof Particle>(k: K) =>
      this.particles.reduce((s, p) => s + p[k], 0) / this.N;

    return {
      phase: avg("phase"),
      tau: avg("tau"),
      debt: avg("debt"),
    };
  }

  predictSleepPressureCurve(now: Date, hoursAhead = 6, stepMinutes = 10) {
    this.advanceTo(now);

    const result: {
      time: Date;
      risk: number;
    }[] = [];

    const steps = Math.floor((hoursAhead * 60) / stepMinutes);
    const stepMs = stepMinutes * MINUTE_IN_MS;

    for (let i = 0; i <= steps; i++) {
      const t = now.getTime() + i * stepMs;
      let weightedRisk = 0;

      for (const p of this.particles) {
        const dtH = (t - p.lastTime) / HOUR_IN_MS;

        // 相位推进
        const phase = wrapPhase(p.phase + (Math.PI * 2 * dtH) / p.tau);

        // 疲劳累积
        const debt = p.debt + 0.15 * dtH * (1 + 0.3 * Math.cos(phase));

        const phaseTerm = Math.cos(phase - PHASE_SLEEP_CENTER);
        const risk = sigmoid(2.0 * phaseTerm + 1.5 * debt);

        weightedRisk += risk * p.weight;
      }

      result.push({
        time: new Date(t),
        risk: weightedRisk,
      });
    }

    return result;
  }
  getParams() {
    return { ...this.params };
  }
}
