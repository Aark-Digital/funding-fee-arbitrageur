export const ONE_DAY_IN_MS = 1000 * 60 * 60 * 24;

export const EIGHT_HOUR_IN_MS = 1000 * 60 * 60 * 8;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
