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
