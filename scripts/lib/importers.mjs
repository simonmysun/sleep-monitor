import fs from "node:fs/promises";
import ical from "ical";

const NS_PER_MS = 1_000_000n;

function timestampNs(value) {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp: ${value}`);
  return (BigInt(ms) * NS_PER_MS).toString();
}

function escapeTag(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(" ", "\\ ").replaceAll(",", "\\,").replaceAll("=", "\\=");
}

function escapeMeasurement(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(" ", "\\ ").replaceAll(",", "\\,");
}

function stringField(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`;
}

export function lineProtocol(measurement, tags, fields, timestamp) {
  const tagSet = Object.entries(tags)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${escapeTag(key)}=${escapeTag(value)}`)
    .join(",");
  const fieldSet = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && !(typeof value === "number" && !Number.isFinite(value)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (typeof value === "string") return `${escapeTag(key)}=${stringField(value)}`;
      if (typeof value === "boolean") return `${escapeTag(key)}=${value}`;
      if (typeof value === "bigint") return `${escapeTag(key)}=${value}i`;
      return `${escapeTag(key)}=${value}`;
    })
    .join(",");
  if (!fieldSet) throw new Error(`Point for ${measurement} has no fields`);
  return `${escapeMeasurement(measurement)}${tagSet ? `,${tagSet}` : ""} ${fieldSet} ${timestampNs(timestamp)}`;
}

export async function writeLines(lines, config, fetchImpl = fetch) {
  if (lines.length === 0) return 0;
  const batchSize = config.batchSize ?? 5_000;
  for (let offset = 0; offset < lines.length; offset += batchSize) {
    const batch = lines.slice(offset, offset + batchSize);
    const influxV1 = config.version === "1";
    const url = new URL(influxV1 ? "/write" : "/api/v2/write", config.url);
    if (influxV1) {
      url.searchParams.set("db", config.database);
    } else {
      url.searchParams.set("org", config.org);
      url.searchParams.set("bucket", config.bucket);
    }
    url.searchParams.set("precision", "ns");
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: influxV1
          ? `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
          : `Token ${config.token}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: batch.join("\n"),
    });
    if (!response.ok) throw new Error(`InfluxDB write failed (${response.status}): ${await response.text()}`);
  }
  return lines.length;
}

async function readSource(source, fetchImpl) {
  if (/^https?:\/\//i.test(source) || /^webcal:\/\//i.test(source)) {
    const response = await fetchImpl(source.replace(/^webcal:/i, "https:"));
    if (!response.ok) throw new Error(`ICS fetch failed (${response.status}) for ${source}`);
    return response.text();
  }
  return fs.readFile(source, "utf8");
}

function eventOccurrences(event, start, end) {
  const eventStart = new Date(event.start);
  const eventEnd = new Date(event.end ?? event.start);
  const duration = Math.max(0, eventEnd.getTime() - eventStart.getTime());
  if (!event.rrule) return eventEnd >= start && eventStart <= end ? [{ start: eventStart, end: eventEnd }] : [];
  return event.rrule.between(start, end, true).map((occurrence) => ({
    start: occurrence,
    end: new Date(occurrence.getTime() + duration),
  }));
}

export async function importIcs({ sources, start, end, titlePattern, influx, fetchImpl = fetch }) {
  const lines = [];
  for (const source of sources) {
    const calendar = ical.parseICS(await readSource(source, fetchImpl));
    for (const event of Object.values(calendar)) {
      if (event?.type !== "VEVENT" || !event.start) continue;
      const title = String(event.summary ?? "(untitled)");
      if (titlePattern && !titlePattern.test(title)) continue;
      for (const occurrence of eventOccurrences(event, start, end)) {
        lines.push(lineProtocol("calendar_event", { calendar: event.organizer?.params?.CN ?? "default" }, {
          title,
          uid: String(event.uid ?? ""),
          end_time: occurrence.end.toISOString(),
          duration_seconds: (occurrence.end.getTime() - occurrence.start.getTime()) / 1_000,
          all_day: event.datetype === "date",
          location: String(event.location ?? ""),
        }, occurrence.start));
      }
    }
  }
  return writeLines([...new Set(lines)], influx, fetchImpl);
}

function stateKey(state) {
  return `${state.entity_id}\u0000${state.last_updated ?? state.last_changed}`;
}

export async function fetchHomeAssistantHistory({ url, token, entityIds, start, end, chunkDays = 7, fetchImpl = fetch }) {
  const states = new Map();
  const chunkMs = chunkDays * 86_400_000;
  for (let cursor = start.getTime(); cursor < end.getTime(); cursor += chunkMs) {
    const chunkEnd = new Date(Math.min(cursor + chunkMs, end.getTime()));
    const endpoint = new URL(`/api/history/period/${encodeURIComponent(new Date(cursor).toISOString())}`, url);
    endpoint.searchParams.set("end_time", chunkEnd.toISOString());
    endpoint.searchParams.set("filter_entity_id", entityIds.join(","));
    endpoint.searchParams.set("minimal_response", "");
    endpoint.searchParams.set("no_attributes", "");
    const response = await fetchImpl(endpoint, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Home Assistant history failed (${response.status}): ${await response.text()}`);
    for (const history of await response.json()) {
      const entityId = history.find((state) => state.entity_id)?.entity_id;
      for (const state of history) {
        const completeState = {
          ...state,
          entity_id: state.entity_id ?? entityId,
          last_updated: state.last_updated ?? state.last_changed,
        };
        if (completeState.entity_id) states.set(stateKey(completeState), completeState);
      }
    }
  }
  return [...states.values()];
}

export async function importHomeAssistant(options) {
  const states = await fetchHomeAssistantHistory(options);
  const lines = states.map((state) => {
    const numeric = Number(state.state);
    return lineProtocol("home_assistant_state", { entity_id: state.entity_id }, {
      state: String(state.state),
      numeric_value: Number.isFinite(numeric) ? numeric : undefined,
      last_changed: String(state.last_changed ?? ""),
      attributes_json: JSON.stringify(state.attributes ?? {}),
    }, state.last_updated ?? state.last_changed);
  });
  return writeLines(lines, options.influx, options.fetchImpl);
}

function activityIdentity(event) {
  return JSON.stringify(event.data ?? {}, Object.keys(event.data ?? {}).sort());
}

export function smoothActivityEvents(events, bucketType, { mergeGapSeconds = 5, minDurationSeconds = 0.5 } = {}) {
  const instantaneous = bucketType === "os.lockscreen.unlocks";
  const unique = new Map();
  for (const event of events) {
    const key = `${event.timestamp}\u0000${event.duration ?? 0}\u0000${activityIdentity(event)}`;
    unique.set(key, { ...event, duration: Math.max(0, Number(event.duration) || 0), data: event.data ?? {} });
  }
  const sorted = [...unique.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  if (instantaneous) return sorted;
  const meaningful = sorted.filter((event) => event.duration >= minDurationSeconds);
  const merged = [];
  for (const event of meaningful) {
    const start = new Date(event.timestamp).getTime();
    const end = start + event.duration * 1_000;
    const previous = merged.at(-1);
    if (previous && activityIdentity(previous) === activityIdentity(event)) {
      const previousStart = new Date(previous.timestamp).getTime();
      const previousEnd = previousStart + previous.duration * 1_000;
      if (start <= previousEnd + mergeGapSeconds * 1_000) {
        previous.duration = (Math.max(previousEnd, end) - previousStart) / 1_000;
        continue;
      }
    }
    merged.push({ ...event });
  }
  return merged;
}

function hostnameFromUrl(value) {
  try { return new URL(value).hostname; } catch { return ""; }
}

export async function importActivityWatch({ path, start, end, mergeGapSeconds, minDurationSeconds, influx, fetchImpl = fetch }) {
  const exportData = JSON.parse(await fs.readFile(path, "utf8"));
  const lines = [];
  for (const bucket of Object.values(exportData.buckets ?? {})) {
    const eventsInRange = (bucket.events ?? []).filter((event) => {
      const timestamp = new Date(event.timestamp).getTime();
      return timestamp >= start.getTime() && timestamp <= end.getTime();
    });
    const events = smoothActivityEvents(eventsInRange, bucket.type, { mergeGapSeconds, minDurationSeconds });
    for (const event of events) {
      const start = new Date(event.timestamp);
      const duration = Number(event.duration) || 0;
      lines.push(lineProtocol("activity_event", {
        bucket_id: bucket.id,
        bucket_type: bucket.type,
        hostname: bucket.hostname,
        app: event.data?.app ?? undefined,
        domain: hostnameFromUrl(event.data?.url),
      }, {
        duration_seconds: duration,
        end_time: new Date(start.getTime() + duration * 1_000).toISOString(),
        title: String(event.data?.title ?? ""),
        package: String(event.data?.package ?? ""),
        data_json: JSON.stringify(event.data ?? {}),
      }, start));
    }
  }
  return writeLines(lines, influx, fetchImpl);
}
