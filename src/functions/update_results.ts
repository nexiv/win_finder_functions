import { Firestore, getFirestore } from "firebase-admin/firestore";
import { HEADERS, URL } from "../config";
import { onSchedule } from "firebase-functions/scheduler";

const GAME_DURATION_BUFFER_MS = 110 * 60 * 1000; // 110 minutes
const COLLECTION = "game-result-v1";
const API_CHUNK_SIZE = 20;

export const updateResults =  onSchedule({schedule: 'every 30 minutes', region: 'europe-west1'}, async () => {
    try {
        const firestore = getFirestore();
        const cutoffTime = Date.now() - GAME_DURATION_BUFFER_MS;

        const querySnapshot = await firestore.collection(COLLECTION)
            .where("f", "==", false)
            .where("t", "<", cutoffTime)
            .get();

        if (querySnapshot.empty) return;

        const ids = querySnapshot.docs.map(d => d.id);
        const chunks = splitArrayIntoChunks(ids, API_CHUNK_SIZE);

        const writer = firestore.bulkWriter();

        await Promise.all(chunks.map(chunk => processGameChunk(chunk, firestore, writer)));

        await writer.close();
        console.log(`Successfully updated results for ${ids.length} games.`);
    } catch (error) {
        console.error("Error during results update:", error);
    }
}
);

const processGameChunk = async (chunkIds: string[], firestore: Firestore, writer: FirebaseFirestore.BulkWriter) => {
    const games = await fetchGames(chunkIds);

    games.forEach(game => {
        if (game.finished || game.canceled) {
            const docRef = firestore.collection(COLLECTION).doc(game.id.toString());
            const data = {
                f: true,
                s: game.finished ? [game.h1, game.a1, game.h, game.a] : [],
            };
            writer.set(docRef, data, { merge: true });
        }
    });
};

const fetchGames = async (ids: string[]) => {
    const url = `${URL}/fixtures?ids=${ids.join('-')}`;

    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Failed to fetch games: ${res.status} ${res.statusText}`);

    const data: { response?: any[] } = await res.json();
    return (data.response ?? []).map(game => new ApiGame(game));
};

const splitArrayIntoChunks = <T>(arr: T[], chunkSize: number): T[][] =>
    Array.from({ length: Math.ceil(arr.length / chunkSize) }, (_, i) =>
        arr.slice(i * chunkSize, i * chunkSize + chunkSize)
    );

class ApiGame {
    id: number;
    status: string;
    h: number;
    h1: number;
    a: number;
    a1: number;

    constructor(data: any) {
        const { fixture, score } = data;

        this.id = fixture.id;
        this.status = fixture.status.short;

        this.h = score.fulltime?.home ?? 0;
        this.h1 = score.halftime?.home ?? 0;
        this.a = score.fulltime?.away ?? 0;
        this.a1 = score.halftime?.away ?? 0;
    }

    get notStarted(): boolean {
        return this.status === 'NS';
    }

    get active(): boolean {
        return ['1H', 'HT', '2H', 'INT', 'LIVE'].includes(this.status);
    }

    get finished(): boolean {
        return ['FT', 'ET', 'BT', 'P', 'AET', 'PEN'].includes(this.status);
    }

    get canceled(): boolean {
        return ['SUSP', 'PST', 'CANC', 'ABD', 'AWD', 'WO'].includes(this.status);
    }
}
