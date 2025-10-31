import { Firestore, getFirestore } from "firebase-admin/firestore";
import { PubSubOptions, onMessagePublished } from "firebase-functions/v2/pubsub";
import { HEADERS, URL } from "../config";

const GAME_DURATION_BUFFER_MS = 110 * 60 * 1000; // 110 minutes
const COLLECTION = "game-result-v1";

export const updateResults = onMessagePublished({ topic: 'updateResults', region: 'europe-west1' } as PubSubOptions, async (_) => {
    const firestore = getFirestore();

    const cutoffTime = Date.now() - GAME_DURATION_BUFFER_MS;

    const querySnapshot = await firestore.collection(COLLECTION).where("f", "==", false).where("t", "<", cutoffTime).get();

    if (querySnapshot.empty) return;

    const ids = querySnapshot.docs.map(d => d.id);

    const chunks = splitArrayIntoChunks(ids, 20);

    await Promise.all(chunks.map(chunk => processGameChunk(chunk, firestore)));
});

const processGameChunk = async (chunkIds: string[], firestore: Firestore) => {
    const games = await getGames(chunkIds.join('-'));

    const updates = games.map(apiGame => {
        if (apiGame.finished || apiGame.canceled) {
            const docRef = firestore.collection(COLLECTION).doc(apiGame.id.toString());
            const data = {
                f: true,
                s: apiGame.finished ? [apiGame.h1, apiGame.a1, apiGame.h, apiGame.a] : [],
            };
            return docRef.set(data, { merge: true });
        }
        return Promise.resolve();
    });

    await Promise.all(updates);
};

const getGames = async (ids: string) => {
    const url = `${URL}/fixtures?ids=${ids}`;
    const res = await fetch(url, { headers: HEADERS });
    const data: { response?: any[] } = await res.json();
    const response = data.response ?? [];
    return response.map(game => new ApiGame(game));
}

const splitArrayIntoChunks = <T>(arr: T[], chunkSize: number): T[][] => {
    const result = [];
    for (let i = 0; i < arr.length; i += chunkSize) {
        result.push(arr.slice(i, i + chunkSize));
    }
    return result;
}

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