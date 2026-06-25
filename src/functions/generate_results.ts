import { getFirestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { gzipSync } from "zlib";
import { encode } from "@msgpack/msgpack";


export const generateResults = onSchedule({ schedule: 'every day 02:00', region: 'europe-west1' }, async (_) => {
    try {
        const db = getFirestore();
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

        const docId = yesterday.toISOString().split('T')[0];

        await Promise.all([
            db.collection("results-v1").doc(docId).set({ data: gzipSync(JSON.stringify(data)) }),
            db.collection("results-v2").doc(docId).set({ data: gzipSync(Buffer.from(encode(data))) }),
        ]);

    } catch (error) {
        console.error("Error generating results:", error);
    }
});