import ical, { type CalendarComponent, type FullCalendar } from "ical";
import http from "node:http";
import {
  PORT,
  HOST,
  ICAL_URL,
  EVENT_NAME,
  CACHE_EXPIRATION,
} from "./config.ts";
import type { DurationInMs, Timestamp } from "./types.d.ts";
import { HOUR_IN_MS, DAY_IN_MS, HISTORY_DAYS } from "./consts.ts";
import { SleepPredictor } from "./predictor.ts";

const cachedResult: { timestamp: Timestamp; result: string } = {
  timestamp: -Infinity,
  result: "",
};

const getSleepEvents = (
  events: FullCalendar,
  eventName: string,
): CalendarComponent[] => {
  const sleepEvents: CalendarComponent[] = [];
  for (const key in events) {
    if (events.hasOwnProperty(key)) {
      const event: CalendarComponent = events[key]!;
      if (event.summary === eventName) {
        sleepEvents.push(event);
      }
    }
  }
  return sleepEvents;
};

const getLastWakeUp = (events: CalendarComponent[]): Timestamp => {
  const endDate: Date = new Date();
  let lastWakeUp: Timestamp = -Infinity;
  for (const key in events) {
    if (events.hasOwnProperty(key)) {
      const event: CalendarComponent = events[key]!;
      if (Number(event.end!) <= Number(endDate)) {
        if (Number(event.end!) > lastWakeUp) {
          lastWakeUp = Number(event.end!);
        }
      }
    }
  }
  return lastWakeUp;
};

const getTotalSleepDurationInRange = (
  events: CalendarComponent[],
  startDate: Date,
  endDate: Date,
): DurationInMs => {
  let totalDurationInMs: DurationInMs = 0;
  for (const key in events) {
    if (events.hasOwnProperty(key)) {
      const event: CalendarComponent = events[key]!;
      if (
        Number(event.start!) > Number(endDate) ||
        Number(event.end!) < Number(startDate)
      ) {
        continue;
      }
      const validStartDate = Math.max(Number(event.start!), Number(startDate));
      const validEndDate = Math.min(Number(event.end!), Number(endDate));
      if (validStartDate < validEndDate) {
        totalDurationInMs += Number(validEndDate) - Number(validStartDate);
      }
    }
  }
  return totalDurationInMs;
};

function selectRecentSleepEvents(
  events: CalendarComponent[],
  now = new Date(),
) {
  const cutoff = now.getTime() - HISTORY_DAYS * DAY_IN_MS;
  return events
    .filter((e) => e.summary === "Slept")
    .filter((e) => e.end!.getTime() >= cutoff)
    .sort((a, b) => a.start!.getTime() - b.start!.getTime());
}

function buildPredictorFromCalendar(
  events: CalendarComponent[],
  now = new Date(),
) {
  const recent = selectRecentSleepEvents(events, now);
  const predictor = new SleepPredictor(
    recent.length > 0 ? recent[0].start! : now,
  );
  for (const e of recent) {
    predictor.updateWithSleep(e);
  }
  return predictor;
}

const requestListener: http.RequestListener = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void => {
  if (
    CACHE_EXPIRATION < 0 ||
    cachedResult.timestamp + CACHE_EXPIRATION < Number(Date.now())
  ) {
    fetch(ICAL_URL)
      .then((response: Response): Promise<string> => response.text())
      .then((data: string): void => {
        let result = "";

        const sleepEvents: CalendarComponent[] = getSleepEvents(
          ical.parseICS(data),
          EVENT_NAME,
        );
        const predictor = buildPredictorFromCalendar(sleepEvents, new Date());
        const predictResult = {
          awake: predictor.predictRemainingAwake(new Date()),
          curve: predictor.predictSleepPressureCurve(new Date()),
          params: predictor.getParams(),
          state: predictor.getDebugState(),
        };

        result += `=== Sleep Prediction Result (睡眠预测结果) ===\n\n`;
        result += `Predicted remaining awake time (预测剩余清醒时间):\n`;
        result += `- P50: ${predictResult.awake.p50.toFixed(2)} h\n`;
        result += `- P25: ${predictResult.awake.p25.toFixed(2)} h\n`;
        result += `- P75: ${predictResult.awake.p75.toFixed(2)} h\n`;
        result += `- Min: ${predictResult.awake.min.toFixed(2)} h\n`;
        result += `- Max: ${predictResult.awake.max.toFixed(2)} h\n`;
        result += `- Uncertainty (不确定性): ${(predictResult.awake.uncertainty * 100).toFixed(2)} %\n\n`;

        result += `Predicted sleep pressure curve for next 6 hours (未来6小时睡眠压力曲线预测):\n`;
        for (const point of predictResult.curve) {
          result += `- ${point.time.toISOString()}: Risk ${(point.risk * 100).toFixed(2)} %\n`;
        }
        result += `\n`;

        result += `Debug state: \n`;
        result += `Phase (相位): ${((predictResult.state.phase / (Math.PI * 2)) * 100).toFixed(2)} %\n`;
        result += `Tau (周期): ${predictResult.state.tau.toFixed(2)} h\n`;
        result += `Debt (睡眠债): ${predictResult.state.debt.toFixed(2)} h\n\n`;

        result += `Debug params: \n`;
        result += `Fatigue rate: ${predictResult.params.fatigueRate.toFixed(2)} compared to default 0.15\n`;
        result += `Recovery rate: ${predictResult.params.recoveryRate.toFixed(2)} compared to default 0.8\n`;
        result += `Phase weight: ${predictResult.params.phaseWeight.toFixed(2)} compared to default 2.0\n`;
        result += `Debt weight: ${predictResult.params.debtWeight.toFixed(2)} compared to default 1.5\n\n`;

        let startDate: Date = new Date();
        const endDate: Date = new Date();
        let totalDurationInMs: DurationInMs;
        let estimatedTiredness = 0;

        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        const lastWakeUp: Timestamp = getLastWakeUp(sleepEvents);
        result += `Woke up ${((Date.now() - lastWakeUp) / HOUR_IN_MS).toFixed(2)}h ago\n`;

        startDate = new Date(Number(endDate) - DAY_IN_MS * 1);
        totalDurationInMs = getTotalSleepDurationInRange(
          sleepEvents,
          startDate,
          endDate,
        );
        const awakeRatio24H = totalDurationInMs / (DAY_IN_MS * 1);
        result += `Total duration between ${startDate.toISOString()} and ${endDate.toISOString()}: ${(totalDurationInMs / HOUR_IN_MS).toFixed(2)}h (${(awakeRatio24H * 100).toFixed(2)}%)\n`;
        estimatedTiredness += awakeRatio24H * 1;

        startDate = new Date(Number(endDate) - DAY_IN_MS * 3);
        totalDurationInMs = getTotalSleepDurationInRange(
          sleepEvents,
          startDate,
          endDate,
        );
        const awakeRatio72H = totalDurationInMs / (DAY_IN_MS * 3);
        result += `Total duration between ${startDate.toISOString()} and ${endDate.toISOString()}: ${(totalDurationInMs / HOUR_IN_MS).toFixed(2)}h (${(awakeRatio72H * 100).toFixed(2)}%)\n`;
        estimatedTiredness += awakeRatio72H * 1;

        startDate = new Date(Number(endDate) - DAY_IN_MS * 7);
        totalDurationInMs = getTotalSleepDurationInRange(
          sleepEvents,
          startDate,
          endDate,
        );
        const awakeRatio168H = totalDurationInMs / (DAY_IN_MS * 7);
        result += `Total duration between ${startDate.toISOString()} and ${endDate.toISOString()}: ${(totalDurationInMs / HOUR_IN_MS).toFixed(2)}h (${(awakeRatio168H * 100).toFixed(2)}%)\n`;

        estimatedTiredness += awakeRatio168H * 1;

        result += `Estimated next sleep: ${((estimatedTiredness / 3) * 48 - (Date.now() - lastWakeUp) / HOUR_IN_MS).toFixed(2)}h\n`;

        cachedResult.timestamp = Number(Date.now());
        cachedResult.result = result;
        res.end(result);
      })
      .catch((error) => {
        console.error("Error:", error);
        res.writeHead(500);
        res.end("Internal Server Error");
      });
  } else {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(cachedResult.result);
  }
};

http.createServer(requestListener).listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});
