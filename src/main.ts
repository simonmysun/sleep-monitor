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
