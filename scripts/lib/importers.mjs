import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import ical from "ical";

const NS_PER_MS = 1_000_000n;
const HTTP_AGENTS = {
  "http:": new http.Agent({ keepAlive: true, maxSockets: 2 }),
  "https:": new https.Agent({ keepAlive: true, maxSockets: 2 }),
};

function http1Request(url, options) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method: options.method,
      headers: {
        ...options.headers,
        "Content-Length": Buffer.byteLength(options.body),
      },
      agent: HTTP_AGENTS[url.protocol],
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          text: async () => body,
        });
      });
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

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

function seriesKey(measurement, tags) {
  const tagSet = Object.entries(tags)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${escapeTag(key)}=${escapeTag(value)}`)
    .join(",");
  return `${escapeMeasurement(measurement)}${tagSet ? `,${tagSet}` : ""}`;
}

export function lineProtocol(measurement, tags, fields, timestamp) {
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
  return `${seriesKey(measurement, tags)} ${fieldSet} ${timestampNs(timestamp)}`;
}

function disambiguatePointLines(points) {
  const groups = new Map();
  for (const point of points) {
    if (!groups.has(point.key)) groups.set(point.key, new Map());
    groups.get(point.key).set(point.line, point);
  }
  const lines = [];
  for (const uniquePoints of groups.values()) {
    const group = [...uniquePoints.values()].sort((a, b) => a.line.localeCompare(b.line));
    if (group.length >= Number(NS_PER_MS)) throw new Error(`Too many events share one InfluxDB point key: ${group.length}`);
    for (const [index, point] of group.entries()) {
      const timestamp = (point.timestamp + BigInt(index)).toString();
      lines.push(`${point.line.slice(0, point.line.lastIndexOf(" ") + 1)}${timestamp}`);
    }
  }
  return lines;
}

export async function writeLines(lines, config, fetchImpl = http1Request) {
  if (lines.length === 0) return 0;
  const batchSize = config.batchSize ?? 5_000;
  const retryAttempts = config.retryAttempts ?? 5;
  const retryDelayMs = config.retryDelayMs ?? 1_000;
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
    const request = {
      method: "POST",
      headers: {
        Authorization: influxV1
          ? `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
          : `Token ${config.token}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: batch.join("\n"),
    };
    for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, request);
      } catch (error) {
        if (attempt === retryAttempts) {
          throw new Error(`InfluxDB write failed after ${retryAttempts} attempts: ${error.message}`, { cause: error });
        }
        const delay = retryDelayMs * 2 ** (attempt - 1);
        console.warn(`InfluxDB write attempt ${attempt}/${retryAttempts} failed; retrying in ${delay} ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (response.ok) break;
      const responseBody = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === retryAttempts) {
        throw new Error(`InfluxDB write failed (${response.status}): ${responseBody}`);
      }
      const delay = retryDelayMs * 2 ** (attempt - 1);
      console.warn(`InfluxDB write returned ${response.status} on attempt ${attempt}/${retryAttempts}; retrying in ${delay} ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
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

export async function importIcs({
  sources,
  start,
  end,
  titlePattern,
  influx,
  fetchImpl = fetch,
  writeImpl = fetchImpl === fetch ? undefined : fetchImpl,
}) {
  const points = [];
  for (const source of sources) {
    const calendar = ical.parseICS(await readSource(source, fetchImpl));
    for (const event of Object.values(calendar)) {
      if (event?.type !== "VEVENT" || !event.start) continue;
      const title = String(event.summary ?? "(untitled)");
      if (titlePattern && !titlePattern.test(title)) continue;
      for (const occurrence of eventOccurrences(event, start, end)) {
        const tags = { calendar: event.organizer?.params?.CN ?? "default" };
        const fields = {
          title,
          uid: String(event.uid ?? ""),
          end_time: occurrence.end.toISOString(),
          duration_seconds: (occurrence.end.getTime() - occurrence.start.getTime()) / 1_000,
          all_day: event.datetype === "date",
          location: String(event.location ?? ""),
        };
        const timestamp = BigInt(occurrence.start.getTime()) * NS_PER_MS;
        points.push({
          key: `${seriesKey("calendar_event", tags)}\u0000${timestamp}`,
          line: lineProtocol("calendar_event", tags, fields, occurrence.start),
          timestamp,
        });
      }
    }
  }
  return writeLines(disambiguatePointLines(points), influx, writeImpl);
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

async function activityWatchFiles(sourcePath) {
  const stat = await fs.stat(sourcePath);
  if (stat.isFile()) return [sourcePath];
  if (!stat.isDirectory()) throw new Error(`ActivityWatch source is not a file or directory: ${sourcePath}`);
  const files = [];
  for (const entry of await fs.readdir(sourcePath, { withFileTypes: true })) {
    const entryPath = path.join(sourcePath, entry.name);
    if (entry.isDirectory()) files.push(...await activityWatchFiles(entryPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) files.push(entryPath);
  }
  return files.sort();
}

export async function importActivityWatch({
  path: sourcePath,
  start,
  end,
  mergeGapSeconds,
  minDurationSeconds,
  smooth = true,
  influx,
  fetchImpl,
  onFileImported,
}) {
  const files = await activityWatchFiles(sourcePath);
  if (files.length === 0) throw new Error(`No ActivityWatch JSON files found under ${sourcePath}`);
  let totalCount = 0;
  for (const [index, file] of files.entries()) {
    let exportData;
    try {
      exportData = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      throw new Error(`Cannot parse ActivityWatch export ${file}: ${error.message}`, { cause: error });
    }
    if (!exportData?.buckets || typeof exportData.buckets !== "object" || Array.isArray(exportData.buckets)) {
      throw new Error(`Missing ActivityWatch buckets object in ${file}`);
    }
    const points = [];
    for (const bucket of Object.values(exportData.buckets)) {
      const eventsInRange = (bucket.events ?? []).filter((event) => {
        const timestamp = new Date(event.timestamp).getTime();
        return timestamp >= start.getTime() && timestamp <= end.getTime();
      });
      const events = smooth
        ? smoothActivityEvents(eventsInRange, bucket.type, { mergeGapSeconds, minDurationSeconds })
        : eventsInRange;
      for (const event of events) {
        const eventStart = new Date(event.timestamp);
        const duration = Number(event.duration) || 0;
        const tags = {
          bucket_id: bucket.id,
          bucket_type: bucket.type,
          hostname: bucket.hostname,
          app: event.data?.app ?? undefined,
          domain: hostnameFromUrl(event.data?.url),
        };
        const fields = {
          duration_seconds: duration,
          end_time: new Date(eventStart.getTime() + duration * 1_000).toISOString(),
          title: String(event.data?.title ?? ""),
          package: String(event.data?.package ?? ""),
          data_json: JSON.stringify(event.data ?? {}),
        };
        const timestamp = BigInt(eventStart.getTime()) * NS_PER_MS;
        points.push({
          key: `${seriesKey("activity_event", tags)}\u0000${timestamp}`,
          line: lineProtocol("activity_event", tags, fields, eventStart),
          timestamp,
        });
      }
    }
    const lines = disambiguatePointLines(points);
    const count = await writeLines(lines, influx, fetchImpl);
    totalCount += count;
    onFileImported?.({ file, index: index + 1, total: files.length, count });
  }
  return totalCount;
}
