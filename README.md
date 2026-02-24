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

$$F(t) = (1 - w) \cdot A(t) + w \cdot B(t)$$

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

## Tuning guide

1. **Start with $A$ only** (`WEIGHT_B=0`). Adjust `K_UP`, `K_DOWN`, and `LAMBDA_A` until the $A$ peaks in the history chart align with your actual sleep-onset times.
2. **Enable $B$** (set `WEIGHT_B=0.3`). Raise `ETA` if multi-day sleep debt isn't captured; lower `LAMBDA_B` for longer memory.
3. **Set threshold** to the $F$ value at which you historically fall asleep involuntarily.

## License

MIT
