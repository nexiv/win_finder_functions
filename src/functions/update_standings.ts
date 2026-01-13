import { BulkWriter, Firestore, getFirestore } from "firebase-admin/firestore";
import { HEADERS, URL } from "../config";
import { onSchedule } from "firebase-functions/v2/scheduler";


export const updateStandings = onSchedule({schedule: 'every 4 hours', region: 'europe-west1'}, async (_) => {

    try {
        const firestore = getFirestore();

        const leagues = await getLeagues(firestore);

        if (leagues.length === 0) return;

        const writer = firestore.bulkWriter();

        for (const league of leagues) {
            await processLeague(league, firestore, writer);
        }

        await writer.close();
        console.log(`Standings updated for ${leagues.length} leagues.`);
    } catch (error) {
        console.error("Error updating standings:", error);
    }
});

const processLeague = async (league: League, firestore: Firestore, writer: BulkWriter) => {
    try {
        const apiStandings = await fetchStandingsFromApi(league);
        if (apiStandings) {
            const standings = createStandingsObject(apiStandings);
            const docRef = firestore.collection('standings-v1').doc(league.i.toString());
            writer.set(docRef, standings);
        }
    } catch (e) {
        console.error(`Failed to process league ${league.i}:`, e);
    }
};

const fetchStandingsFromApi = async (league: League): Promise<any | null> => {
    const url = `${URL}/standings?league=${league.i}&season=${league.s}`;
    const response = await fetch(url, { headers: HEADERS });

    if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}: ${response.statusText}`);
    }

    const remainingRequests = parseInt(response.headers.get("x-ratelimit-remaining") ?? "20", 10);

    if (remainingRequests < 20) {
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    const data: { response?: any[] } = await response.json();
    return data.response?.[0] ?? null;
};

const getLeagues = async (firestore: Firestore): Promise<League[]> => {
    const snapshot = await firestore.collection('data').doc('leagues').get();
    const leaguesData: League[] = snapshot.data()?.data ?? [];
    return leaguesData.filter(e => e.t);
}

const createStandingsObject = (apiStandings: any): Standings => ({
    updated: Date.now(),
    data: (apiStandings.league?.standings ?? []).map(createStandingFromApi),
});

const createStandingFromApi = (data: any[] = []): Standing => ({
    n: data[0]?.group ?? 'Main',
    s: data.map(createTeamStandingFromApi),
});

const createTeamStandingFromApi = (data: any = {}): TeamStanding => ({
    n: data.team?.name ?? 'Unknown',
    p: data.points,
    h: createTeamStatsFromApi(data.home),
    a: createTeamStatsFromApi(data.away),
});

const createTeamStatsFromApi = (data: any = {}): number[] => [
    data.played ?? 0,
    data.win ?? 0,
    data.draw ?? 0,
    data.lose ?? 0,
    data.goals?.for ?? 0,
    data.goals?.against ?? 0,
];

interface League {
    i: number;
    s: number;
    t: boolean;
}

interface TeamStanding {
    n: string;
    p: number;
    h: number[];
    a: number[];
}

interface Standing {
    n: string;
    s: TeamStanding[];
}

interface Standings {
    updated: number;
    data: Standing[];
}
