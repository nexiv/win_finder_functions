import { getStorage } from "firebase-admin/storage";
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { gunzipSync } from "zlib";
import {
  RECORD_SIZE,
  DATE_OFFSET,
  RESULT_OFFSET,
  STATS_OFFSET,
  STATS_SIZE,
  STORAGE_PATH,
  dayNumber,
} from "../backtest_format";
import { accumulate, newAcc } from "../backtest_outcomes";

// Allowed look-back windows (days). The Storage file only holds RETENTION_DAYS.
const ALLOWED_DAYS = new Set([7, 30, 90, 180, 365]);

// Hard cap on filter rules. The hot loop is O(matches * rules), so an unbounded
// rules array is a CPU-exhaustion vector. The UI sends only a handful.
const MAX_RULES = 32;

// A single filter rule: [statIndex, comparator, value].
// comparator: 0 = gte (stat >= value), 1 = lte (stat <= value).
const CMP_GTE = 0;

type Rule = [number, number, number];

interface BacktestRequest {
  days: number;
  rules: Rule[];
}

// In-memory cache shared by all requests on this instance.
//
// The Storage file is rebuilt once per day at 03:00 UTC (buildBacktestFile), so
// the happy path is keyed on a daily "build token": after the rebuild window the
// token flips and the instance reloads once — zero Storage calls in between.
//
// Safety net: at most once per hour we re-validate against the file's `generation`
// metadata. This catches a delayed/retried scheduled build or a manual rerun
// after a failure (token alone would miss these until the next day). getMetadata
// is a cheap call; the 10MB download only happens when generation actually changes.
const REBUILD_HOUR_UTC = 3; // buildBacktestFile schedule
const REBUILD_MARGIN_MIN = 30; // build runs <=540s; margin covers it + scheduler jitter
const SAFETY_TTL_MS = 60 * 60 * 1000; // re-check generation at most hourly
const MS_PER_DAY = 86_400_000;

/** Day index shifted so the boundary falls after the daily rebuild finishes. */
function buildToken(now: number): number {
  const offsetMs = (REBUILD_HOUR_UTC * 60 + REBUILD_MARGIN_MIN) * 60_000;
  return Math.floor((now - offsetMs) / MS_PER_DAY);
}

let cache:
  | { buffer: Buffer; token: number; generation: string; checkedAt: number }
  | null = null;

async function loadBuffer(): Promise<Buffer> {
  const now = Date.now();
  const token = buildToken(now);

  // Fast path: same daily build window and validated recently → serve cache.
  if (cache && cache.token === token && now - cache.checkedAt < SAFETY_TTL_MS) {
    return cache.buffer;
  }

  // Token flipped or safety interval elapsed → confirm via cheap metadata call.
  const file = getStorage().bucket().file(STORAGE_PATH);
  const [meta] = await file.getMetadata();
  const generation = String(meta.generation);

  if (cache && cache.generation === generation) {
    cache.token = token; // unchanged file — refresh validation markers only
    cache.checkedAt = now;
    return cache.buffer;
  }

  const [gz] = await file.download();
  cache = { buffer: gunzipSync(gz), token, generation, checkedAt: now };
  return cache.buffer;
}

/** Index of the first record with day >= cutoff (records are date-sorted). */
function firstRecordFrom(buf: Buffer, cutoff: number): number {
  let lo = 0;
  let hi = buf.length / RECORD_SIZE; // exclusive
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (buf.readUInt16LE(mid * RECORD_SIZE + DATE_OFFSET) < cutoff) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Caller is restricted to our app (App Check + auth), so we only guard the two
// things that actually matter here: a valid period, and a bounded rules count
// (CPU). cmp/value are harmlessly coerced by the Uint16Array flattening; the
// statIndex bound (a buffer offset) is enforced there too.
function parseRequest(data: unknown): BacktestRequest {
  const { days, rules } = (data ?? {}) as Partial<BacktestRequest>;
  if (!ALLOWED_DAYS.has(days as number)) {
    throw new HttpsError("invalid-argument", "Invalid 'days'.");
  }
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > MAX_RULES) {
    throw new HttpsError("invalid-argument", "Invalid 'rules'.");
  }
  return { days: days as number, rules: rules as Rule[] };
}

export const runBacktest = onCall(
  {
    region: "europe-west1",
    enforceAppCheck: true,
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  async (request: CallableRequest) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be signed in.");
    }

    const { days, rules } = parseRequest(request.data);

    // Flatten rules into parallel arrays to avoid per-record allocation.
    const n = rules.length;
    const ruleIdx = new Uint16Array(n);
    const ruleCmp = new Uint16Array(n);
    const ruleVal = new Uint16Array(n);
    for (let k = 0; k < n; k++) {
      const idx = rules[k][0];
      // statIndex is a buffer offset — an out-of-range value would read into an
      // adjacent record (silently wrong) or off the end. This is the one rule
      // field that must be bounded.
      if (!(idx >= 0 && idx < STATS_SIZE)) {
        throw new HttpsError("invalid-argument", "Invalid statIndex.");
      }
      ruleIdx[k] = idx;
      ruleCmp[k] = rules[k][1];
      ruleVal[k] = rules[k][2];
    }

    const buf = await loadBuffer();
    const cutoff = dayNumber(new Date()) - days;
    const start = firstRecordFrom(buf, cutoff);

    const acc = newAcc();
    let total = 0;

    for (let off = start * RECORD_SIZE; off < buf.length; off += RECORD_SIZE) {
      const stats = off + STATS_OFFSET;
      let pass = true;
      for (let k = 0; k < n; k++) {
        const s = buf[stats + ruleIdx[k]];
        if (ruleCmp[k] === CMP_GTE ? s < ruleVal[k] : s > ruleVal[k]) {
          pass = false;
          break;
        }
      }
      if (!pass) continue;

      total++;
      const res = off + RESULT_OFFSET;
      accumulate(
        buf[res],
        buf[res + 1],
        buf[res + 2],
        buf[res + 3],
        buf[res + 4],
        buf[res + 5],
        acc,
      );
    }

    return {
      total,
      result: Array.from(acc.result),
      doubleChance: Array.from(acc.doubleChance),
      goals: Array.from(acc.goals),
      teamGoals: Array.from(acc.teamGoals),
      btts: Array.from(acc.btts),
      htft: Array.from(acc.htft),
    };
  },
);
