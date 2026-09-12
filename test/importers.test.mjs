import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchHomeAssistantHistory,
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
    titlePattern: /slept/i,
    influx: { url: "http://influx.test", token: "token", org: "org", bucket: "sleep" },
    fetchImpl,
  });
  assert.equal(count, 1);
  assert.match(body, /^calendar_event,/);
  assert.match(body, /duration_seconds=7200/);
  assert.match(body, /title="Slept"/);
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

test("fetchHomeAssistantHistory fills minimal states and deduplicates chunk boundaries", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return Response.json([[
      { entity_id: "sensor.bed", state: "1", last_changed: "2026-01-01T00:00:00Z" },
      { state: "2", last_changed: "2026-01-02T00:00:00Z" },
    ]]);
  };
  const states = await fetchHomeAssistantHistory({
    url: "https://ha.example.test",
    token: "token",
    entityIds: ["sensor.bed"],
    start: new Date("2026-01-01T00:00:00Z"),
    end: new Date("2026-01-03T00:00:00Z"),
    chunkDays: 1,
    fetchImpl,
  });
  assert.equal(requests, 2);
  assert.equal(states.length, 2);
  assert.equal(states[1].entity_id, "sensor.bed");
  assert.equal(states[1].last_updated, states[1].last_changed);
});
