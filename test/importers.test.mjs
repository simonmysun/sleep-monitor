import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  importActivityWatch,
  importIcs,
  lineProtocol,
  smoothActivityEvents,
  writeLines,
} from "../scripts/lib/importers.mjs";

test("lineProtocol escapes tags and fields", () => {
  const line = lineProtocol("sleep event", { source: "a,b" }, { title: 'a "nap"', duration: 12.5 }, "2026-01-01T00:00:00Z");
  assert.equal(line, 'sleep\\ event,source=a\\,b duration=12.5,title="a \\"nap\\"" 1767225600000000000');
});

test("smoothActivityEvents removes duplicates and merges adjacent identical activity", () => {
  const events = [
    { timestamp: "2026-01-01T00:00:00Z", duration: 2, data: { app: "Reader" } },
    { timestamp: "2026-01-01T00:00:00Z", duration: 2, data: { app: "Reader" } },
    { timestamp: "2026-01-01T00:00:03Z", duration: 2, data: { app: "Reader" } },
    { timestamp: "2026-01-01T00:00:05Z", duration: 0, data: { app: "Launcher" } },
  ];
  assert.deepEqual(smoothActivityEvents(events, "currentwindow", { mergeGapSeconds: 1 }), [
    { timestamp: "2026-01-01T00:00:00Z", duration: 5, data: { app: "Reader" } },
  ]);
});

test("smoothActivityEvents preserves unique unlock events", () => {
  const events = [
    { timestamp: "2026-01-01T00:00:00Z", duration: 0, data: {} },
    { timestamp: "2026-01-01T00:00:00Z", duration: 0, data: {} },
  ];
  assert.equal(smoothActivityEvents(events, "os.lockscreen.unlocks").length, 1);
});

test("importIcs maps calendar event fields to InfluxDB", async () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:sleep-1",
    "DTSTART:20260102T010000Z",
    "DTEND:20260102T030000Z",
    "SUMMARY:Slept",
    "LOCATION:Bedroom",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:sleep-2",
    "DTSTART:20260102T010000Z",
    "DTEND:20260102T020000Z",
    "SUMMARY:Nap",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  let body = "";
  const fetchImpl = async (url, options) => {
    if (!options) return new Response(ics);
    body = options.body;
    return new Response(null, { status: 204 });
  };
  const count = await importIcs({
    sources: ["https://example.test/sleep.ics"],
    start: new Date("2026-01-01T00:00:00Z"),
    end: new Date("2026-01-03T00:00:00Z"),
    titlePattern: /slept|nap/i,
    influx: { url: "http://influx.test", token: "token", org: "org", bucket: "sleep" },
    fetchImpl,
  });
  assert.equal(count, 2);
  assert.match(body, /^calendar_event,/);
  assert.match(body, /duration_seconds=7200/);
  assert.match(body, /title="Slept"/);
  assert.match(body, /title="Nap"/);
  const timestamps = body.split("\n").map((line) => BigInt(line.match(/ (\d+)$/)[1])).sort();
  assert.equal(timestamps[1] - timestamps[0], 1n);
});

test("writeLines supports the InfluxDB 1.x write endpoint", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(null, { status: 204 });
  };
  const count = await writeLines(["sleep value=1 1"], {
    version: "1",
    url: "https://influx.example.test",
    database: "sleep",
    username: "writer",
    password: "secret",
  }, fetchImpl);
  assert.equal(count, 1);
  assert.equal(request.url.pathname, "/write");
  assert.equal(request.url.searchParams.get("db"), "sleep");
  assert.equal(request.url.searchParams.get("precision"), "ns");
  assert.equal(request.options.headers.Authorization, "Basic d3JpdGVyOnNlY3JldA==");
});

test("writeLines retries transient network failures", async () => {
  let attempts = 0;
  const count = await writeLines(["sleep value=1 1"], {
    url: "https://influx.example.test",
    token: "token",
    org: "org",
    bucket: "sleep",
    retryAttempts: 2,
    retryDelayMs: 0,
  }, async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("fetch failed");
    return new Response(null, { status: 204 });
  });
  assert.equal(count, 1);
  assert.equal(attempts, 2);
});

test("writeLines uses the built-in HTTP/1.1 transport by default", async (t) => {
  let received;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        httpVersion: request.httpVersion,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const count = await writeLines(["sleep value=1 1"], {
    version: "1",
    url: `http://127.0.0.1:${port}`,
    database: "sleep",
    username: "writer",
    password: "secret",
  });
  assert.equal(count, 1);
  assert.deepEqual(received, {
    httpVersion: "1.1",
    authorization: "Basic d3JpdGVyOnNlY3JldA==",
    body: "sleep value=1 1",
  });
});

test("importActivityWatch recursively imports a directory in filename order", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "activitywatch-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "nested");
  await fs.mkdir(nested);
  const document = (timestamp, app) => ({
    buckets: {
      bucket: {
        id: "bucket",
        type: "currentwindow",
        hostname: "test",
        events: [{ timestamp, duration: 0, data: { app } }],
      },
    },
  });
  const january = document("2026-01-01T00:00:00Z", "One");
  january.buckets.bucket.events.push({
    timestamp: "2026-01-01T00:00:00Z",
    duration: 0,
    data: { app: "One", title: "Different event at the same point key" },
  });
  await fs.writeFile(path.join(root, "2026-01.json"), JSON.stringify(january));
  await fs.writeFile(path.join(nested, "2026-02.JSON"), JSON.stringify(document("2026-02-01T00:00:00Z", "Two")));
  await fs.writeFile(path.join(root, "ignored.txt"), "not JSON");
  const requests = [];
  const progress = [];
  const count = await importActivityWatch({
    path: root,
    start: new Date("2026-01-01T00:00:00Z"),
    end: new Date("2026-03-01T00:00:00Z"),
    smooth: false,
    influx: { url: "http://influx.test", token: "token", org: "org", bucket: "sleep" },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, { status: 204 });
    },
    onFileImported: (result) => progress.push(path.basename(result.file)),
  });
  assert.equal(count, 3);
  assert.equal(requests.length, 2);
  assert.deepEqual(progress, ["2026-01.json", "2026-02.JSON"]);
  assert.match(requests[0].options.body, /app=One/);
  assert.match(requests[1].options.body, /app=Two/);
  const januaryTimestamps = requests[0].options.body.split("\n").map((line) => BigInt(line.match(/ (\d+)$/)[1])).sort();
  assert.equal(januaryTimestamps[1] - januaryTimestamps[0], 1n);
});
