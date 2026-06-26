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

// Maximum look-back the binary file covers.
const MAX_DAYS = 365;

// Hard cap on filter rules. The hot loop is O(matches * rules), so an unbounded
// rules array is a CPU-exhaustion vector. The UI sends only a handful.
const MAX_RULES = 32;

// A single filter rule, fixed-length tuple: [idx0, idx2, comparator, value, logic].
//
//   idx0   — primary stat index (home or away team slot).
//   idx2   — second stat index, the other team's slot. Only read when logic != 0;
//            for a single-team rule the client copies idx0 here.
//   comparator: 0 = gte (stat >= value), 1 = lte (stat <= value).
//   value  — threshold.
//   logic  — how to combine the two indices:
//              0 = single  (only idx0 is checked),
//              1 = AND     (both idx0 and idx2 must pass — "both teams"),
//              2 = OR      (either idx0 or idx2 passes — "any team").
const CMP_GTE = 0;
const LOGIC_SINGLE = 0;
const LOGIC_AND = 1;
const LOGIC_OR = 2;

type Rule = [number, number, number, number, number];

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
// things that actually matter here: a valid days count, and a bounded rules count
// (CPU). cmp/value are harmlessly coerced by the Uint16Array flattening; the
// stat-index bounds (buffer offsets) and the logic field are enforced there too.
function parseRequest(data: unknown): BacktestRequest {
  const { days, rules } = (data ?? {}) as { days?: unknown; rules?: unknown };
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new HttpsError("invalid-argument", "Invalid 'days'.");
  }
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > MAX_RULES) {
    throw new HttpsError("invalid-argument", "Invalid 'rules'.");
  }
  return { days, rules: rules as Rule[] };
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
    const ruleIdx0 = new Uint16Array(n);
    const ruleIdx2 = new Uint16Array(n);
    const ruleCmp = new Uint16Array(n);
    const ruleVal = new Uint16Array(n);
    const ruleLogic = new Uint16Array(n);
    for (let k = 0; k < n; k++) {
      const idx0 = rules[k][0];
      const idx2 = rules[k][1];
      const logic = rules[k][4];
      // Stat indices are buffer offsets — an out-of-range value would read into
      // an adjacent record (silently wrong) or off the end. Both must be bounded;
      // idx2 is only read when logic != 0 but we validate it unconditionally.
      if (!(idx0 >= 0 && idx0 < STATS_SIZE)) {
        throw new HttpsError("invalid-argument", "Invalid statIndex.");
      }
      if (!(idx2 >= 0 && idx2 < STATS_SIZE)) {
        throw new HttpsError("invalid-argument", "Invalid statIndex.");
      }
      if (logic !== LOGIC_SINGLE && logic !== LOGIC_AND && logic !== LOGIC_OR) {
        throw new HttpsError("invalid-argument", "Invalid logic.");
      }
      ruleIdx0[k] = idx0;
      ruleIdx2[k] = idx2;
      ruleCmp[k] = rules[k][2];
      ruleVal[k] = rules[k][3];
      ruleLogic[k] = logic;
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
        const gte = ruleCmp[k] === CMP_GTE;
        const v = ruleVal[k];
        const s0 = buf[stats + ruleIdx0[k]];
        const ok0 = gte ? s0 >= v : s0 <= v;

        let ok;
        if (ruleLogic[k] === LOGIC_SINGLE) {
          ok = ok0;
        } else {
          const s1 = buf[stats + ruleIdx2[k]];
          const ok1 = gte ? s1 >= v : s1 <= v;
          ok = ruleLogic[k] === LOGIC_AND ? ok0 && ok1 : ok0 || ok1;
        }

        if (!ok) {
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

    // Outcome groups as a positional array of arrays — the client parses by
    // index, no key lookup. Order is fixed and must match the client enums:
    //   [0] result  [1] doubleChance  [2] goals  [3] teamGoals  [4] btts  [5] htft
    return {
      total,
      data: [
        Array.from(acc.result),
        Array.from(acc.doubleChance),
        Array.from(acc.goals),
        Array.from(acc.teamGoals),
        Array.from(acc.btts),
        Array.from(acc.htft),
      ],
    };
  },
);
