import { getFirestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { gzipSync } from "zlib";


export const generateResults = onSchedule({ schedule: 'every day 02:00', region: 'europe-west1' }, async (_) => {
    try {
        const db = getFirestore();
        // Calculate start and end of yesterday (UTC)
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const snapshot = await db.collection("game-result-v1")
            .where("t", ">=", yesterday.getTime())
            .where("t", "<", today.getTime())
            .get();


        const data = snapshot.docs.map(doc => ({
            i: Number(doc.id),
            s: doc.data().s,
        }));

        const compressedData = gzipSync(JSON.stringify(data));

        const docId = yesterday.toISOString().split('T')[0]
        await db.collection("results-v1").doc(docId).set({ data: compressedData });

    } catch (error) {
        console.error("Error generating results:", error);
    }
});