import type { DurationInMs, SleepEvent, Timestamp } from "./types.d.ts";
import { HOUR_IN_MS, DAY_IN_MS, HISTORY_DAYS } from "./consts.ts";

type DurationSummary = {
  rangeInDays: number;
  startIso: string;
  endIso: string;
  totalSleepHours: number;
  sleepRatioPercent: number;
};

export type OldPredictionResult = {
  wokeUpHoursAgo: number;
  durations: DurationSummary[];
  estimatedNextSleepHours: number;
};

export class OldPredictor {
  sleepEvents: SleepEvent[];

  constructor(sleepEvents: SleepEvent[]) {
    this.sleepEvents = sleepEvents;
  }

  getLastWakeUp(): Timestamp {
    const endDate: Date = new Date();
    let lastWakeUp: Timestamp = -Infinity;
    for (const key in this.sleepEvents) {
      if (this.sleepEvents.hasOwnProperty(key)) {
        const event: SleepEvent = this.sleepEvents[key]!;
        if (Number(event.end!) <= Number(endDate)) {
          if (Number(event.end!) > lastWakeUp) {
            lastWakeUp = Number(event.end!);
          }
        }
      }
    }
    return lastWakeUp;
  }

  getTotalSleepDurationInRange(startDate: Date, endDate: Date): DurationInMs {
    let totalDurationInMs: DurationInMs = 0;
    for (const key in this.sleepEvents) {
      if (this.sleepEvents.hasOwnProperty(key)) {
        const event: SleepEvent = this.sleepEvents[key]!;
        if (
          Number(event.start!) > Number(endDate) ||
          Number(event.end!) < Number(startDate)
        ) {
          continue;
        }
        const validStartDate = Math.max(
          Number(event.start!),
          Number(startDate),
        );
        const validEndDate = Math.min(Number(event.end!), Number(endDate));
        if (validStartDate < validEndDate) {
          totalDurationInMs += Number(validEndDate) - Number(validStartDate);
        }
      }
    }
    return totalDurationInMs;
  }

  predict(): OldPredictionResult {
    let startDate: Date = new Date();
    const endDate: Date = new Date();
    let totalDurationInMs: DurationInMs;
    let estimatedTiredness = 0;
    const durations: DurationSummary[] = [];

    const lastWakeUp: Timestamp = this.getLastWakeUp();
    const wokeUpHoursAgo = Number(
      ((Date.now() - lastWakeUp) / HOUR_IN_MS).toFixed(2),
    );

    startDate = new Date(Number(endDate) - DAY_IN_MS * 1);
    totalDurationInMs = this.getTotalSleepDurationInRange(startDate, endDate);
    const sleepRatio24H = totalDurationInMs / (DAY_IN_MS * 1);
    durations.push({
      rangeInDays: 1,
      startIso: startDate.toISOString(),
      endIso: endDate.toISOString(),
      totalSleepHours: Number((totalDurationInMs / HOUR_IN_MS).toFixed(2)),
      sleepRatioPercent: Number((sleepRatio24H * 100).toFixed(2)),
    });
    estimatedTiredness += sleepRatio24H * 1;

    startDate = new Date(Number(endDate) - DAY_IN_MS * 3);
    totalDurationInMs = this.getTotalSleepDurationInRange(startDate, endDate);
    const sleepRatio72H = totalDurationInMs / (DAY_IN_MS * 3);
    durations.push({
      rangeInDays: 3,
      startIso: startDate.toISOString(),
      endIso: endDate.toISOString(),
      totalSleepHours: Number((totalDurationInMs / HOUR_IN_MS).toFixed(2)),
      sleepRatioPercent: Number((sleepRatio72H * 100).toFixed(2)),
    });
    estimatedTiredness += sleepRatio72H * 1;

    startDate = new Date(Number(endDate) - DAY_IN_MS * 7);
    totalDurationInMs = this.getTotalSleepDurationInRange(startDate, endDate);
    const sleepRatio168H = totalDurationInMs / (DAY_IN_MS * 7);
    durations.push({
      rangeInDays: 7,
      startIso: startDate.toISOString(),
      endIso: endDate.toISOString(),
      totalSleepHours: Number((totalDurationInMs / HOUR_IN_MS).toFixed(2)),
      sleepRatioPercent: Number((sleepRatio168H * 100).toFixed(2)),
    });

    estimatedTiredness += sleepRatio168H * 1;

    const estimatedNextSleepHours = Number(
      (
        (estimatedTiredness / 3) * 48 -
        (Date.now() - lastWakeUp) / HOUR_IN_MS
      ).toFixed(2),
    );

    return {
      wokeUpHoursAgo,
      durations,
      estimatedNextSleepHours,
    };
  }
}
