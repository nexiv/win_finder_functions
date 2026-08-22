import { getFirestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { fetchGamesByIds } from "../api_football";

const GAME_DURATION_BUFFER_MS = 120 * 60 * 1000; // 120 minutes
const COLLECTION = "game-result-v1";

export const updateResults =  onSchedule({schedule: 'every 15 minutes', region: 'europe-west1'}, async () => {
    try {
        const firestore = getFirestore();
        const cutoffTime = Date.now() - GAME_DURATION_BUFFER_MS;

        const querySnapshot = await firestore.collection(COLLECTION)
            .where("f", "==", false)
            .where("t", "<", cutoffTime)
            .get();

        if (querySnapshot.empty) return;

        const ids = querySnapshot.docs.map(d => d.id);
        const { games, failed } = await fetchGamesByIds(ids);

        const writer = firestore.bulkWriter();
        let closed = 0;

        games.forEach(game => {
            const docRef = firestore.collection(COLLECTION).doc(game.id.toString());

            // Canceled has to come first: for ABD/AWD the API does publish a fulltime
            // score even though the match was never played out.
            if (game.canceled) {
                writer.set(docRef, { f: true, s: [] }, { merge: true });
                closed++;
            } else if (game.settled) {
                writer.set(docRef, { f: true, s: game.score }, { merge: true });
                closed++;
            }
            // Anything else is still running or kicked off late — leave f false so the
            // next run picks it up again.
        });

        await writer.close();
        console.log(
            `Closed ${closed} of ${ids.length} games; ${ids.length - closed - failed} not settled yet` +
            (failed ? `, ${failed} could not be fetched` : "") + "."
        );
    } catch (error) {
        console.error("Error during results update:", error);
    }
}
);
