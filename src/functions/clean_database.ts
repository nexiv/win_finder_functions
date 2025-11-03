import { getFirestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/scheduler";

export const cleanDatabase =  onSchedule({schedule: 'every 24 hours', region: 'europe-west1'}, async (_) => {
    try {
        const firestore = getFirestore();

        // --- Calculate cutoff date ---
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 5);
        cutoffDate.setHours(0, 0, 0, 0);

        const timestamp = cutoffDate.getTime();
        const year = cutoffDate.getFullYear();
        const month = (cutoffDate.getMonth() + 1).toString().padStart(2, "0");
        const day = cutoffDate.getDate().toString().padStart(2, "0");
        const yyyyMMdd = parseInt(`${year}${month}${day}`, 10);

        // --- Define queries ---
        const gamesQuery = firestore.collection("games-v1").where("date", "<", yyyyMMdd);
        const gameResultQuery = firestore.collection("game-result-v1").where("t", "<", timestamp);

        const bulkWriter = firestore.bulkWriter();

        // Get documents to delete from both collections in parallel
        const [gamesSnapshot, gameResultSnapshot] = await Promise.all([
            gamesQuery.get(),
            gameResultQuery.get(),
        ])

        // Queue deletes
        gamesSnapshot.docs.forEach(doc => bulkWriter.delete(doc.ref));
        gameResultSnapshot.docs.forEach(doc => bulkWriter.delete(doc.ref));

        // Commit all writes
        await bulkWriter.close();
        console.log(`Database cleanup successful. Deleted ${gamesSnapshot.size} games and ${gameResultSnapshot.size} game results.`);
    } catch (error) {
        console.error("Error during database cleanup:", error);
    }
}
);
