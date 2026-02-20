import type { DurationInMs, SleepEvent, Timestamp } from "./types.d.ts";
import { HOUR_IN_MS, DAY_IN_MS, HISTORY_DAYS } from "./consts.ts";

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

  predict(): string {
    let result = "";
    let startDate: Date = new Date();
    const endDate: Date = new Date();
    let totalDurationInMs: DurationInMs;
    let estimatedTiredness = 0;

    const lastWakeUp: Timestamp = this.getLastWakeUp();
    result += `Woke up ${((Date.now() - lastWakeUp) / HOUR_IN_MS).toFixed(2)}h ago\n`;

    startDate = new Date(Number(endDate) - DAY_IN_MS * 1);
    totalDurationInMs = this.getTotalSleepDurationInRange(startDate, endDate);
    const awakeRatio24H = totalDurationInMs / (DAY_IN_MS * 1);
    result += `Total duration between ${startDate.toISOString()} and ${endDate.toISOString()}: ${(totalDurationInMs / HOUR_IN_MS).toFixed(2)}h (${(awakeRatio24H * 100).toFixed(2)}%)\n`;
    estimatedTiredness += awakeRatio24H * 1;

    startDate = new Date(Number(endDate) - DAY_IN_MS * 3);
    totalDurationInMs = this.getTotalSleepDurationInRange(startDate, endDate);
    const awakeRatio72H = totalDurationInMs / (DAY_IN_MS * 3);
    result += `Total duration between ${startDate.toISOString()} and ${endDate.toISOString()}: ${(totalDurationInMs / HOUR_IN_MS).toFixed(2)}h (${(awakeRatio72H * 100).toFixed(2)}%)\n`;
    estimatedTiredness += awakeRatio72H * 1;

    startDate = new Date(Number(endDate) - DAY_IN_MS * 7);
    totalDurationInMs = this.getTotalSleepDurationInRange(startDate, endDate);
    const awakeRatio168H = totalDurationInMs / (DAY_IN_MS * 7);
    result += `Total duration between ${startDate.toISOString()} and ${endDate.toISOString()}: ${(totalDurationInMs / HOUR_IN_MS).toFixed(2)}h (${(awakeRatio168H * 100).toFixed(2)}%)\n`;

    estimatedTiredness += awakeRatio168H * 1;

    result += `Estimated next sleep: ${((estimatedTiredness / 3) * 48 - (Date.now() - lastWakeUp) / HOUR_IN_MS).toFixed(2)}h\n`;
    return result;
  }
}
