import { getFirestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";

function toCutoff(daysAgo: number): { timestamp: number; yyyyMMdd: number } {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    date.setHours(0, 0, 0, 0);
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    return {
        timestamp: date.getTime(),
        yyyyMMdd: parseInt(`${year}${month}${day}`, 10),
    };
}

export const cleanDatabase = onSchedule({ schedule: 'every 24 hours', region: 'europe-west1' }, async (_) => {
    try {
        const firestore = getFirestore();

        const v1 = toCutoff(5);
        const v2 = toCutoff(30);

        const [
            gamesV1Snapshot,
            gameResultV1Snapshot,
            resultsV1Snapshot,
            gamesV2Snapshot,
            resultsV2Snapshot,
        ] = await Promise.all([
            firestore.collection("games-v1").where("date", "<", v1.yyyyMMdd).get(),
            firestore.collection("game-result-v1").where("t", "<", v1.timestamp).get(),
            firestore.collection("results-v1").where("t", "<", v1.timestamp).get(),
            firestore.collection("games-v2").where("date", "<", v2.yyyyMMdd).get(),
            firestore.collection("results-v2").where("t", "<", v2.timestamp).get(),
        ]);

        const bulkWriter = firestore.bulkWriter();

        for (const doc of gamesV1Snapshot.docs) {
            bulkWriter.delete(doc.ref);
        }
        for (const doc of gameResultV1Snapshot.docs) {
            bulkWriter.delete(doc.ref);
            bulkWriter.delete(firestore.doc(`game-last-games-v1/${doc.id}`));
        }
        for (const doc of resultsV1Snapshot.docs) {
            bulkWriter.delete(doc.ref);
        }
        for (const doc of gamesV2Snapshot.docs) {
            bulkWriter.delete(doc.ref);
        }
        for (const doc of resultsV2Snapshot.docs) {
            bulkWriter.delete(doc.ref);
        }

        await bulkWriter.close();
        console.log(
            `Cleanup done. V1: ${gamesV1Snapshot.size} games, ${gameResultV1Snapshot.size} game-results, ${resultsV1Snapshot.size} results. ` +
            `V2: ${gamesV2Snapshot.size} games, ${resultsV2Snapshot.size} results.`
        );
    } catch (error) {
        console.error("Error during database cleanup:", error);
    }
}
);
