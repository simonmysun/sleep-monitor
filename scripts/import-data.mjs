#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { importActivityWatch, importHomeAssistant, importIcs } from "./lib/importers.mjs";

if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
}

function list(value) {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function date(value, fallback) {
  const result = new Date(value ?? fallback);
  if (!Number.isFinite(result.getTime())) throw new Error(`Invalid date: ${value}`);
  return result;
}

const command = process.argv[2] ?? "all";
if (!["all", "ics", "ha", "activitywatch"].includes(command)) {
  throw new Error("Usage: npm run import -- [all|ics|ha|activitywatch]");
}

const end = date(process.env.IMPORT_END, Date.now());
const start = date(process.env.IMPORT_START, end.getTime() - 30 * 86_400_000);
const influxVersion = process.env.INFLUXDB_VERSION ?? (process.env.INFLUXDB_USERNAME ? "1" : "2");
if (!["1", "2"].includes(influxVersion)) throw new Error("INFLUXDB_VERSION must be 1 or 2");
const influx = {
  version: influxVersion,
  url: process.env.INFLUXDB_URL ?? "http://localhost:8086",
  token: influxVersion === "2" ? required("INFLUXDB_TOKEN") : undefined,
  org: influxVersion === "2" ? process.env.INFLUXDB_ORG ?? "sleep-monitor" : undefined,
  bucket: influxVersion === "2" ? process.env.INFLUXDB_BUCKET ?? "sleep" : undefined,
  username: influxVersion === "1" ? required("INFLUXDB_USERNAME") : undefined,
  password: influxVersion === "1" ? required("INFLUXDB_PASSWORD") : undefined,
  database: influxVersion === "1" ? process.env.INFLUXDB_DATABASE ?? "sleep" : undefined,
  batchSize: Number(process.env.INFLUXDB_BATCH_SIZE ?? 5_000),
};

async function run(name, configured, importer) {
  if (!configured && command === "all") {
    console.log(`Skipping ${name}: source is not configured`);
    return;
  }
  if (!configured) throw new Error(`${name} source is not configured`);
  const count = await importer();
  console.log(`${name}: wrote ${count} points`);
}

if (command === "all" || command === "ics") {
  const sources = list(process.env.ICS_SOURCES ?? process.env.ICAL_URL);
  await run("ICS", sources.length > 0, () => importIcs({
    sources,
    start,
    end,
    titlePattern: process.env.ICS_TITLE_PATTERN ? new RegExp(process.env.ICS_TITLE_PATTERN, "i") : undefined,
    influx,
  }));
}

if (command === "all" || command === "ha") {
  const entityIds = list(process.env.HA_ENTITY_IDS);
  const homeAssistantUrl = process.env.HA_URL ?? process.env.HOME_ASSISTANT_URL;
  const homeAssistantToken = process.env.HA_TOKEN ?? process.env.HOME_ASSISTANT_TOKEN;
  await run("Home Assistant", Boolean(homeAssistantUrl && homeAssistantToken && entityIds.length), () => importHomeAssistant({
    url: homeAssistantUrl,
    token: homeAssistantToken,
    entityIds,
    start,
    end,
    chunkDays: Number(process.env.HA_CHUNK_DAYS ?? 7),
    influx,
  }));
}

if (command === "all" || command === "activitywatch") {
  const exportPath = process.env.AW_EXPORT_PATH;
  await run("ActivityWatch", Boolean(exportPath), () => importActivityWatch({
    path: path.resolve(exportPath),
    start,
    end,
    mergeGapSeconds: Number(process.env.AW_MERGE_GAP_SECONDS ?? 5),
    minDurationSeconds: Number(process.env.AW_MIN_DURATION_SECONDS ?? 0.5),
    influx,
  }));
}
