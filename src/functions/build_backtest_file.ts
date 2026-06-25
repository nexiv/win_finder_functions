import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { gzipSync, gunzipSync } from "zlib";
import { decode } from "@msgpack/msgpack";
import {
  RECORD_SIZE,
  DATE_OFFSET,
  RETENTION_DAYS,
  BOOTSTRAP_DAYS,
  STORAGE_PATH,
  dayNumber,
  docIdFromDay,
  makeRecord,
} from "../backtest_format";

type DayDoc = { data: Uint8Array };
type Entry = { i: number; s: ArrayLike<number> };

/** Decompress + msgpack-decode a daily document (games-v2 / results-v2). */
function decodeDay(buf: Uint8Array): Entry[] {
  return decode(gunzipSync(buf)) as Entry[];
}

// Merges games-v2 + results-v2 into a single binary file on Storage that holds
// the last RETENTION_DAYS days. Each day it appends new matches and prunes old ones.
export const buildBacktestFile = onSchedule(
  {
    schedule: "every day 03:00", // after generateResults (02:00)
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const db = getFirestore();
    const file = getStorage().bucket().file(STORAGE_PATH);

    // 1. Load the existing file (if it exists).
    let existing: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const [exists] = await file.exists();
    if (exists) {
      const [gz] = await file.download();
      existing = gunzipSync(gz);
    }

    // 2. Determine from which day we start appending new matches.
    const todayDay = dayNumber(new Date());
    const yesterdayDay = todayDay - 1;

    let fromDay: number;
    if (existing.length >= RECORD_SIZE) {
      const lastDay = existing.readUInt16LE(existing.length - RECORD_SIZE + DATE_OFFSET);
      fromDay = lastDay + 1; // continue from the first day we don't have yet
    } else {
      fromDay = yesterdayDay - (BOOTSTRAP_DAYS - 1); // bootstrap: only the recent days we have
    }

    // 3. Collect new records day by day (skip days without data).
    const newChunks: Buffer[] = [];
    let addedDays = 0;
    for (let day = fromDay; day <= yesterdayDay; day++) {
      const docId = docIdFromDay(day);
      const [gSnap, rSnap] = await Promise.all([
        db.collection("games-v2").doc(docId).get(),
        db.collection("results-v2").doc(docId).get(),
      ]);
      if (!gSnap.exists || !rSnap.exists) continue; // skip days without data

      const games = decodeDay((gSnap.data() as DayDoc).data);
      const results = decodeDay((rSnap.data() as DayDoc).data);

      const resultById = new Map<number, ArrayLike<number>>();
      for (const r of results) resultById.set(r.i, r.s);

      for (const g of games) {
        const res = resultById.get(g.i);
        if (!res) continue; // a match without a result is skipped
        newChunks.push(makeRecord(day, res, g.s));
      }
      addedDays++;
    }

    // 4. Prune matches older than the retention window.
    const cutoff = todayDay - RETENTION_DAYS;
    let cutOffset = 0;
    while (cutOffset < existing.length) {
      if (existing.readUInt16LE(cutOffset + DATE_OFFSET) >= cutoff) break;
      cutOffset += RECORD_SIZE;
    }
    const kept = existing.subarray(cutOffset);

    // 5. Concatenate + upload.
    const finalBuf = Buffer.concat([kept, ...newChunks]);
    await file.save(gzipSync(finalBuf), { contentType: "application/gzip" });

    console.log(
      `backtest file: ${finalBuf.length / RECORD_SIZE} matches total, ` +
        `+${newChunks.length} new from ${addedDays} days, pruned ${cutOffset / RECORD_SIZE}`,
    );
  },
);
