import ical, { type CalendarComponent, type FullCalendar } from "ical";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  PORT,
  HOST,
  ICAL_URL,
  EVENT_NAME,
  CACHE_EXPIRATION,
  MODEL_CONFIG,
} from "./config.ts";
import type { SleepEvent, Timestamp } from "./types.d.ts";
import { OldPredictor } from "./oldPredictor.ts";
import { Predictor } from "./predictor.ts";

const indexHtml = fs.readFileSync(path.resolve("src/index.html"), "utf8");

const cachedData: { timestamp: Timestamp; json: string } = {
  timestamp: -Infinity,
  json: "",
};

function buildData(sleepEvents: CalendarComponent[]): string {
  const sleepEventList: SleepEvent[] = sleepEvents.map(
    (event) =>
      ({
        start: Number(event.start),
        end: Number(event.end),
      }) as SleepEvent,
  );

  const oldPredictor = new OldPredictor(sleepEventList);
  const oldPrediction = oldPredictor.predict();

  const predictor = new Predictor(sleepEventList, MODEL_CONFIG);
  const prediction = predictor.predict();

  return JSON.stringify({ prediction, oldPrediction });
}

function fetchAndCache(): Promise<string> {
  return fetch(ICAL_URL)
    .then((response: Response): Promise<string> => response.text())
    .then((data: string): string => {
      const events: FullCalendar = ical.parseICS(data);
      const sleepEvents: CalendarComponent[] = [];
      for (const key in events) {
        if (events.hasOwnProperty(key)) {
          const event: CalendarComponent = events[key]!;
          if (event.summary === EVENT_NAME) {
            sleepEvents.push(event);
          }
        }
      }
      const json = buildData(sleepEvents);
      cachedData.timestamp = Date.now();
      cachedData.json = json;
      return json;
    });
}

function isCacheValid(): boolean {
  return (
    CACHE_EXPIRATION >= 0 &&
    cachedData.timestamp + CACHE_EXPIRATION >= Date.now()
  );
}

const requestListener: http.RequestListener = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void => {
  const url = req.url || "/";

  if (url === "/api/data") {
    if (isCacheValid()) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(cachedData.json);
      return;
    }

    fetchAndCache()
      .then((json) => {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(json);
      })
      .catch((error) => {
        console.error("Error:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      });
    return;
  }

  // Serve static HTML for everything else
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(indexHtml);
};

http.createServer(requestListener).listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});
