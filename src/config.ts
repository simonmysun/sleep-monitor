export const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
export const HOST = process.env.HOST ? process.env.HOST : "localhost";
export const ICAL_URL = process.env.ICAL_URL ? process.env.ICAL_URL : "";
export const EVENT_NAME = process.env.EVENT_NAME
  ? process.env.EVENT_NAME
  : "Slept";
export const CACHE_EXPIRATION =
  (process.env.CACHE_EXPIRATION
    ? parseInt(process.env.CACHE_EXPIRATION, 10)
    : 300) * 1000;

// Fatigue model configuration (overridable via environment variables)
export const MODEL_CONFIG = {
  lambdaA: process.env.LAMBDA_A ? parseFloat(process.env.LAMBDA_A) : 0.3,
  lambdaB: process.env.LAMBDA_B ? parseFloat(process.env.LAMBDA_B) : 0.04,
  kUp: process.env.K_UP ? parseFloat(process.env.K_UP) : 1.0,
  kDown: process.env.K_DOWN ? parseFloat(process.env.K_DOWN) : 2.0,
  eta: process.env.ETA ? parseFloat(process.env.ETA) : 0.1,
  c: process.env.C_OFFSET ? parseFloat(process.env.C_OFFSET) : 0.0,
  weightB: process.env.WEIGHT_B ? parseFloat(process.env.WEIGHT_B) : 0.3,
  threshold: process.env.THRESHOLD ? parseFloat(process.env.THRESHOLD) : 2.0,
};
