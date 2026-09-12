# Sleep Monitor

A polyphasic sleep fatigue prediction system. It ingests sleep events from an iCal feed, quantifies acute and chronic fatigue via a homeostatic pressure model, and forecasts when the next involuntary "crash" (forced sleep) is likely to occur.

Designed for non-24-hour or polyphasic sleepers whose circadian rhythm is absent or unreliable — the model is entirely **Process S** (homeostatic) with no circadian component.

## Mathematical Model

The system tracks two coupled fatigue indices and combines them into a single crash predictor.

### 1. Acute Fatigue — $A(t)$

Short-term fatigue reflecting the past few hours of wakefulness and recovery.

The time axis is divided into contiguous segments, each labelled **wake** or **sleep**. For each segment $[t_s, t_e]$, its contribution to $A$ at the current time $t$ is computed via exponential-decay integral:

$$\Delta A = \frac{V}{\lambda_A} \left( e^{-\lambda_A (t - t_e)} - e^{-\lambda_A (t - t_s)} \right)$$

where:

| Symbol | Meaning | Default |
|---|---|---|
| $V = k_{\text{up}}$ | fatigue growth rate (wake segment) | `1.0` |
| $V = -k_{\text{down}}$ | recovery rate (sleep segment) | `2.0` |
| $\lambda_A$ | decay rate (h⁻¹); controls memory span | `0.3` (~2.3 h half-life) |

$A(t)$ is the sum of contributions from all segments within a 72-hour lookback window.

### 2. Chronic Fatigue — $B(t)$

Long-term sleep debt. $B$ is the **second-order integral**: $A$ drives its rate of change.

$$\frac{dB}{dt} = \eta \left( A(t) + c \right) - \lambda_B \, B$$

This ODE is solved numerically (exact exponential step, 30-min resolution) over a 14-day lookback with warm-up:

$$B(t + \Delta t) = B(t) \cdot e^{-\lambda_B \Delta t} + \frac{\eta (A(t) + c)}{\lambda_B} \left(1 - e^{-\lambda_B \Delta t}\right)$$

| Symbol | Meaning | Default |
|---|---|---|
| $\eta$ | coupling coefficient (A → B) | `0.02` |
| $c$ | baseline offset | `0.0` |
| $\lambda_B$ | chronic decay rate (h⁻¹) | `0.04` (~17 h half-life) |

Because $B$ integrates $A$ over time, it **lags** behind $A$ — even after a nap brings $A$ down, $B$ remains elevated, capturing the "still tired despite sleeping" phenomenon of accumulated sleep debt.

### 3. Total Fatigue — $F(t)$

$$F(t) = A(t) + w \cdot B(t)$$

| Symbol | Meaning | Default |
|---|---|---|
| $w$ | chronic fatigue weight | `0.8` |
| threshold | crash threshold for $F$ | `3.5` |

When $F(t) \geq \text{threshold}$, the system flags a **high crash-risk zone**.

### Zone classification

| Zone | Condition | Meaning |
|---|---|---|
| 🟢 Safe | $F < 0.7 \times \text{threshold}$ | Low fatigue |
| 🟡 Warning | $0.7 \times \text{threshold} \leq F < \text{threshold}$ | Fatigue building, nap recommended |
| 🔴 Danger | $F \geq \text{threshold}$ | Imminent crash |

## Architecture

```
Browser ──fetch──▶ GET /           → static index.html
                   GET /api/data   → JSON { prediction, oldPrediction }
                                        ▲
                                        │
                   iCal feed ──parse──▶ Predictor.predict()
```

- **Backend**: Node.js HTTP server (no framework). Fetches an iCal feed, parses sleep events, runs the model, returns JSON. Results cached per `CACHE_EXPIRATION`.
- **Frontend**: Static HTML with Chart.js. Fetches `/api/data` on load and renders:
  - Status cards (A, B, F, crash ETA)
  - 7-day history chart with sleep event overlays and peak annotations
  - 24-hour forecast chart with zone colouring and crash point marker

## Setup

### Prerequisites

- Node.js ≥ 18
- An iCal/ICS URL containing sleep events (e.g. from a calendar app)

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `HOST` | Bind address | `localhost` |
| `ICAL_URL` | URL to the iCal feed | *(required)* |
| `EVENT_NAME` | Calendar event summary to match | `Slept` |
| `CACHE_EXPIRATION` | Cache TTL in seconds | `300` |
| `LAMBDA_A` | Acute decay rate | `0.3` |
| `LAMBDA_B` | Chronic decay rate | `0.04` |
| `K_UP` | Wake fatigue growth | `1.0` |
| `K_DOWN` | Sleep recovery rate | `2.0` |
| `ETA` | A → B coupling | `0.1` |
| `C_OFFSET` | Baseline offset in B equation | `0.0` |
| `WEIGHT_B` | Chronic weight in F | `0.3` |
| `THRESHOLD` | Crash threshold | `3.5` |

### Run locally

```bash
cp .env.example .env   # fill in ICAL_URL
npm install
npm run dev             # build + watch + auto-restart
```

### Docker

```bash
docker compose up --build
```

## InfluxDB and Grafana

The repository includes a development data stack and an importer for calendar,
Home Assistant, and ActivityWatch data. Credentials are read from `.env`; real
tokens must not be committed.

### Start the development stack

Copy the data-related settings from `.env.example` into `.env`, choose a long
`INFLUXDB_TOKEN`, then start the `dev` profile:

```bash
docker compose --profile dev up -d influxdb grafana
```

- InfluxDB: <http://localhost:8086>
- Grafana: <http://localhost:3000>
- Provisioned dashboard: **Sleep Monitor / Sleep and Activity Overview**

InfluxDB initialization settings only apply to a new `influxdb-data` volume.
The token in `.env` must continue to match the initialized token unless the dev
volume is deliberately recreated.

### Configure data sources

The importer loads `.env` automatically. Important settings are:

| Variable | Purpose |
|---|---|
| `INFLUXDB_VERSION` | `2` for the local dev stack; `1` for an InfluxDB 1.x server |
| `INFLUXDB_URL` | InfluxDB base URL |
| `INFLUXDB_ORG`, `INFLUXDB_BUCKET`, `INFLUXDB_TOKEN` | InfluxDB 2.x destination and token |
| `INFLUXDB_DATABASE`, `INFLUXDB_USERNAME`, `INFLUXDB_PASSWORD` | InfluxDB 1.x destination and credentials |
| `IMPORT_START`, `IMPORT_END` | Shared import range; defaults to the last 30 days |
| `ICS_SOURCES` | Comma-separated ICS file paths or HTTP(S) URLs |
| `ICS_TITLE_PATTERN` | Optional case-insensitive event-title regular expression |
| `HA_URL`, `HA_TOKEN` | Home Assistant base URL and long-lived access token |
| `HA_ENTITY_IDS` | Comma-separated entity IDs whose history should be imported |
| `HA_CHUNK_DAYS` | HA history request chunk size, default `7` days |
| `AW_EXPORT_PATH` | ActivityWatch bucket export JSON path |
| `AW_MERGE_GAP_SECONDS` | Merge gap for adjacent identical activity, default `5` seconds |
| `AW_MIN_DURATION_SECONDS` | Discard shorter non-instant activity fragments, default `0.5` seconds |

The provided Home Assistant token belongs in local `.env` as `HA_TOKEN`. Entity
IDs can be copied from Home Assistant's Developer Tools > States page. Do not
put the token directly in scripts or Compose YAML.

The production Home Assistant streams all state changes directly to the
`home_assistant` InfluxDB database. Keep the HA importer unconfigured for normal
one-command imports; it remains available for API-based backfills or other Home
Assistant instances.

### Import data

```bash
# One-command import for every configured source. Unconfigured sources are skipped.
npm run import

# Or import one source and fail if its settings are incomplete.
npm run import -- ics
npm run import -- ha
npm run import -- activitywatch
```

Measurements written to the configured bucket:

| Measurement | Contents |
|---|---|
| `calendar_event` | Title, start/end, duration, location, and UID |
| `home_assistant_state` | Entity state, numeric value when available, and timestamps |
| `activity_event` | Smoothed activity intervals, app/domain, duration, and original data JSON |

Imports are idempotent because each point uses stable source tags and its
original timestamp. ActivityWatch imports additionally remove exact duplicate
events, retain unlocks as instantaneous events, discard tiny non-instant
fragments, and merge adjacent identical activities. Since ActivityWatch exports
cannot be range-limited, the importer applies `IMPORT_START` and `IMPORT_END`
while reading the export.

The dashboard's **Sleep title regex** defaults to English sleep/nap titles. Edit
it in Grafana if calendar events use another naming convention. If
`INFLUXDB_BUCKET` is not `sleep`, update the hidden dashboard constant after
opening dashboard settings > Variables.

## Tuning guide

1. **Start with $A$ only** (`WEIGHT_B=0`). Adjust `K_UP`, `K_DOWN`, and `LAMBDA_A` until the $A$ peaks in the history chart align with your actual sleep-onset times.
2. **Enable $B$** (set `WEIGHT_B=0.3`). Raise `ETA` if multi-day sleep debt isn't captured; lower `LAMBDA_B` for longer memory.
3. **Set threshold** to the $F$ value at which you historically fall asleep involuntarily.

## License

MIT
