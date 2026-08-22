import { getFirestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { gzipSync } from "zlib";
import { encode } from "@msgpack/msgpack";
import { ApiGame, fetchGamesByIds } from "../api_football";

const COLLECTION = "game-result-v1";

// 03:00 rather than 02:00: a match kicking off just before midnight can still be in
// extra time at 02:00, and whatever is missing when the day is archived is missing
// for good.
export const generateResults = onSchedule({ schedule: 'every day 03:00', region: 'europe-west1' }, async (_) => {
    try {
        const db = getFirestore();
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const snapshot = await db.collection(COLLECTION)
            .where("t", ">=", yesterday.getTime())
            .where("t", "<", today.getTime())
            .get();

        const stored = snapshot.docs.map(doc => ({
            i: Number(doc.id),
            s: (doc.data().s ?? []) as number[],
        }));

        // Read the day once more, straight from the API, before it becomes permanent.
        // Plenty can have moved since updateResults last looked: a goal added or
        // revoked afterwards, a corrected half-time, or a match that never settled.
        const fresh = await fetchFresh(stored.map(g => g.i));

        const writer = db.bulkWriter();
        let corrected = 0;

        const data = stored.map(({ i, s }) => {
            const game = fresh.get(i);
            if (!game) return { i, s }; // no longer served by the API — keep what we have

            const score = archivedScore(game, yesterday.getTime(), today.getTime());
            // Only ever write an improvement back. An empty score here means "not
            // played on this day", which is right for the archive but must not wipe
            // the fixture's own document.
            if (score.length === 4 && !sameScore(score, s)) {
                writer.set(db.collection(COLLECTION).doc(String(i)), { s: score }, { merge: true });
                corrected++;
            }
            return { i, s: score };
        });

        const docId = yesterday.toISOString().split('T')[0];

        await Promise.all([
            db.collection("results-v1").doc(docId).set({ data: gzipSync(JSON.stringify(data)) }),
            db.collection("results-v2").doc(docId).set({ data: gzipSync(Buffer.from(encode(data))) }),
        ]);
        await writer.close();

        const withScore = data.filter(d => d.s.length === 4).length;
        console.log(
            `Archived ${docId}: ${data.length} games, ${withScore} with a score, ` +
            `${data.length - withScore} without, ${corrected} corrected against the API.`
        );
    } catch (error) {
        console.error("Error generating results:", error);
    }
});

/** Every fixture the API still knows about, keyed by id. */
const fetchFresh = async (ids: number[]): Promise<Map<number, ApiGame>> => {
    const { games, failed } = await fetchGamesByIds(ids.map(String));

    // Whatever did not come back simply keeps its stored score. Losing the whole
    // day's archive over a few bad requests would be the worse outcome.
    if (failed) console.error(`${failed} fixtures could not be re-checked; keeping their stored score.`);

    return new Map(games.map(game => [game.id, game]));
};

/**
 * The score to file under the day being archived. Empty unless the match settled
 * and actually kicked off that day — a postponed fixture belongs to the day it is
 * eventually played on, not the one it was originally scheduled for.
 */
const archivedScore = (game: ApiGame, from: number, to: number): number[] => {
    if (game.canceled || !game.settled) return [];
    if (game.kickoff < from || game.kickoff >= to) return [];
    return game.score;
};

const sameScore = (a: number[], b: number[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
