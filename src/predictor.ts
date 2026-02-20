import type { CalendarComponent } from "ical";
import type {
  AngleInRad,
  DurationInHour,
  Debt,
  Weight,
  Timestamp,
} from "./types.d.ts";

import { MINUTE_IN_MS, HOUR_IN_MS } from "./consts.ts";

import { clamp, wrapPhase, sigmoid, randn } from "./math-utils.ts";

const HISTORY_DAYS = 45;

export class SleepPredictor {}
