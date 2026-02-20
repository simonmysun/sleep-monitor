import ical, { type CalendarComponent, type FullCalendar } from "ical";
import http from "node:http";
import {
  PORT,
  HOST,
  ICAL_URL,
  EVENT_NAME,
  CACHE_EXPIRATION,
} from "./config.ts";
import type { SleepEvent, Timestamp } from "./types.d.ts";
import { OldPredictor } from "./oldPredictor.ts";

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

        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });

        const oldPredictor = new OldPredictor(
          sleepEvents.map(
            (event) =>
              ({
                start: Number(event.start),
                end: Number(event.end),
              }) as SleepEvent,
          ),
        );
        result += oldPredictor.predict();

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
