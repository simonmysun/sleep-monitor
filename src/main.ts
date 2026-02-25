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

const STATIC_DIR = path.resolve("static");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const staticCache = new Map<string, { content: Buffer; mime: string }>();

function serveStatic(
  filePath: string,
): { content: Buffer; mime: string } | null {
  const cached = staticCache.get(filePath);
  if (cached) {
    return cached;
  }
  const fullPath = path.join(STATIC_DIR, filePath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(STATIC_DIR)) {
    return null;
  }
  try {
    const content = fs.readFileSync(resolved);
    const ext = path.extname(resolved);
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const entry = { content, mime };
    staticCache.set(filePath, entry);
    return entry;
  } catch {
    return null;
  }
}

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
      console.log(
        `Fetched ${sleepEvents.length} / ${Object.keys(events).length} events.`,
      );
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

  // Serve static files
  const filePath = url === "/" ? "/index.html" : url;
  const file = serveStatic(filePath);
  if (file) {
    res.writeHead(200, { "Content-Type": file.mime });
    res.end(file.content);
    return;
  }

  res.writeHead(302, { Location: "/" });
  res.end();
};

http.createServer(requestListener).listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});
