// Binary format of the backtest file.
//
// The file is a flat array of fixed-size records, sorted by date (ascending).
// One record = one match = RECORD_SIZE bytes:
//   [0..1]    date   — day number since EPOCH_UTC (Uint16LE)
//   [2..7]    result — [h1, a1, h2, a2, h, a]    (6 × Uint8)
//   [8..2551] stats  — team statistics            (2544 × Uint8)
// h2/a2 = second-half goals (derived: h2 = h - h1, a2 = a - a1).

export const EPOCH_UTC = Date.UTC(2026, 0, 1); // reference day; must be before the oldest data

export const DATE_SIZE = 2;
export const RESULT_SIZE = 6;
export const STATS_SIZE = 2544;
export const RECORD_SIZE = DATE_SIZE + RESULT_SIZE + STATS_SIZE; // 2552

export const DATE_OFFSET = 0;
export const RESULT_OFFSET = DATE_SIZE; // 2
export const STATS_OFFSET = DATE_SIZE + RESULT_SIZE; // 6

export const RETENTION_DAYS = 365;

// On the first (bootstrap) run we only seed this many recent days, instead of
// scanning the whole RETENTION_DAYS window. After that the file grows one day
// per run until it fills up to RETENTION_DAYS.
export const BOOTSTRAP_DAYS = 7;

export const STORAGE_PATH = "backtest/year.bin.gz";

const MS_PER_DAY = 86_400_000;

/** Day number since EPOCH_UTC for the given Date (UTC). */
export function dayNumber(date: Date): number {
  return Math.floor((date.getTime() - EPOCH_UTC) / MS_PER_DAY);
}

/** "YYYY-MM-DD" (UTC day) -> day number since EPOCH_UTC. */
export function dayFromDocId(docId: string): number {
  return Math.floor((Date.parse(`${docId}T00:00:00Z`) - EPOCH_UTC) / MS_PER_DAY);
}

/** Day number since EPOCH_UTC -> "YYYY-MM-DD" (UTC day). */
export function docIdFromDay(day: number): string {
  return new Date(EPOCH_UTC + day * MS_PER_DAY).toISOString().split("T")[0];
}

/**
 * Build a single binary record for a match.
 * @param result raw result [h1, a1, h, a]; h2/a2 are derived here.
 */
export function makeRecord(
  day: number,
  result: ArrayLike<number>,
  stats: ArrayLike<number>,
): Buffer {
  const rec = Buffer.alloc(RECORD_SIZE);
  rec.writeUInt16LE(day, DATE_OFFSET);

  const h1 = result[0], a1 = result[1], h = result[2], a = result[3];
  rec[RESULT_OFFSET + 0] = h1;
  rec[RESULT_OFFSET + 1] = a1;
  rec[RESULT_OFFSET + 2] = h - h1; // h2 = full-time home - first-half home
  rec[RESULT_OFFSET + 3] = a - a1; // a2 = full-time away - first-half away
  rec[RESULT_OFFSET + 4] = h;
  rec[RESULT_OFFSET + 5] = a;

  for (let k = 0; k < STATS_SIZE; k++) rec[STATS_OFFSET + k] = stats[k];
  return rec;
}
