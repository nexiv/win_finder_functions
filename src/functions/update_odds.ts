import { Firestore, getFirestore } from "firebase-admin/firestore";
import { PubSubOptions, onMessagePublished } from "firebase-functions/v2/pubsub";
import { HEADERS, URL } from "../config";
import { gzip } from 'zlib';
import { promisify } from 'util';


export const updateOdds = onMessagePublished({ topic: 'update-odds' } as PubSubOptions, async (e) => {

    try {

        const firestore = getFirestore();

        const leagues = await getLeagues(firestore);

        const { firstDate, lastDate } = getDates();

        const apiOdds: ApiOdds[] = [];

        for (const league of leagues) {
            const id = league[0];
            const season = league[1];
            var odds = await getOddsForLeague(id, season);
            odds = filterOddsByDates(odds, firstDate, lastDate);
            odds = convertOddsToApiOds(odds);
            apiOdds.push(...odds);
        }
        const gameOdds = convertApiOddsToGameOdds(apiOdds);

        await saveOdds(firestore, gameOdds);

    } catch (error) {
        console.error(error);
    }

});

const delay = (ms: number) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}


const getLeagues = async (firestore: Firestore): Promise<[string, string][]> => {
    const res = await firestore.doc('data/leagues').get();
    const data = res.data()?.data ?? {};
    return Object.entries(data);
}


const saveOdds = async (firestore: Firestore, odds: GameOdds[]) => {
    const gzipPromise = promisify(gzip);
    const bytes = await gzipPromise(JSON.stringify(odds));
    const data = bytes.toString('base64');
    await firestore.doc('data/odds').set({ data });
}

const getOddsForLeague = async (id: string, season: string): Promise<any[]> => {
    var page = 1;
    var done = false;
    const odds = [];

    while (!done) {
        const url = `${URL}/odds?league=${id}&season=${season}&bookmaker=32&page=${page}`;
        const response = await fetch(url, { headers: HEADERS });
        const oddsRes = await response.json() as OddsResonse;
        odds.push(...oddsRes.response);
        page == oddsRes.paging.total ? done = true : page++;
        const rateLimit = response.headers.get('X-RateLimit-Remaining') ?? '0';
        const delayMillis = Number.parseInt(rateLimit) < 100 ? 200 : 50;
        await delay(delayMillis);
    }
    return odds;
}

const getDates = () => {
    const today = new Date();
    const firstDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 0, 0, 0);
    const lastDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3, 23, 59, 59);
    return { firstDate, lastDate };
}

const filterOddsByDates = (odds: any[], firstDate: Date, lastDate: Date): any[] => {
    const first = firstDate.getTime() / 1000;
    const last = lastDate.getTime() / 1000;
    return odds.filter(e => {
        const { fixture: { timestamp } } = e;
        return timestamp >= first && timestamp <= last;
    });
}

const convertOddsToApiOds = (odds: any[]): ApiOdds[] => {
    return odds.map(e => new ApiOdds(e))
}

const convertApiOddsToGameOdds = (odds: ApiOdds[]): GameOdds[] => {
    return odds.map(o => {
        const res = {
            'i': o.id,
            'o': apiOddsDefinitions.map(e => convertOddToPercent(o.bets[e.i]?.[e.v])),
        };
        return res;
    });
}


const convertOddToPercent = (odd: number | undefined): number => {
    if (odd) {
        const percent = (1 / odd * 100).toFixed(2);
        return Number.parseFloat(percent);
    }
    return 0;
}


interface OddsResonse {
    paging: {
        total: number;
        current: number;
    };
    response: any[];
}

interface ApiBets {
    [key: number]: ApiBetValues;
}

interface ApiBetValues {
    [key: string]: number;
}

interface GameOdds {
    i: number;
    o: number[];
}

interface Odd {
    i: number;
    v: string;
}

class ApiOdds {
    id: number;
    bets: ApiBets;

    constructor(data: any) {
        const { fixture, bookmakers } = data;

        this.id = fixture.id;
        this.bets = {};

        const betsList = bookmakers[0]?.bets as any[] ?? [];

        for (const { id, values } of betsList) {
            if (betIds.has(id)) {
                const betValues: ApiBetValues = {};
                for (const { value, odd } of values) {
                    betValues[value] = Number.parseFloat(odd);
                }
                this.bets[id] = betValues;
            }
        }
    }
}


const betIds = new Set([1, 3, 5, 6, 7, 8, 12, 13, 16, 17, 20, 33, 34, 35, 105, 106, 107, 108]);

const apiOddsDefinitions: Odd[] = [
    // *** RESULT ***
    { i: 1, v: 'Home' }, // ft
    { i: 13, v: 'Home' }, // 1ht
    { i: 3, v: 'Home' }, // 2ht
    { i: 1, v: 'Draw' }, // ft
    { i: 13, v: 'Draw' }, // 1ht
    { i: 3, v: 'Draw' }, // 2ht
    { i: 1, v: 'Away' }, // ft
    { i: 13, v: 'Away' }, //1ht
    { i: 3, v: 'Away' }, // 2ht
    { i: 12, v: 'Home/Draw' }, // ft
    { i: 20, v: 'Home/Draw' }, // 1ht
    { i: 33, v: 'Home/Draw' }, // 2ht
    { i: 12, v: 'Draw/Away' }, // ft
    { i: 20, v: 'Draw/Away' }, // 1ht
    { i: 33, v: 'Draw/Away' }, // 2ht
    // *** GOALS ***
    { i: 5, v: 'Over 0.5' }, // ft
    { i: 6, v: 'Over 0.5' }, // 1ht
    { i: 26, v: 'Over 0.5' }, // 2ht
    { i: 5, v: 'Over 1.5' }, // ft
    { i: 6, v: 'Over 1.5' }, // 1ht
    { i: 26, v: 'Over 1.5' }, // 2ht
    { i: 5, v: 'Over 2.5' }, // ft
    { i: 5, v: 'Over 3.5' }, // ft
    { i: 5, v: 'Over 4.5' }, // ft
    { i: 5, v: 'Over 5.5' }, // ft
    { i: 5, v: 'Over 6.5' }, // ft
    { i: 5, v: 'Under 0.5' }, // ft 
    { i: 6, v: 'Under 0.5' }, // 1ht
    { i: 26, v: 'Under 0.5' }, // 2ht
    { i: 5, v: 'Under 1.5' }, // ft
    { i: 6, v: 'Under 1.5' }, // 1ht
    { i: 26, v: 'Under 1.5' }, // 2ht
    { i: 5, v: 'Under 2.5' }, // ft
    { i: 5, v: 'Under 3.5' }, // ft
    // *** TEAM GAOLS ***
    // home
    { i: 16, v: 'Over 0.5' }, // ft
    { i: 105, v: 'Over 0.5' }, // 1ht
    { i: 107, v: 'Over 0.5' }, // 2ht
    { i: 16, v: 'Over 1.5' }, // ft
    { i: 105, v: 'Over 1.5' }, // 1ht
    { i: 107, v: 'Over 1.5' }, // 2ht
    { i: 16, v: 'Under 0.5' }, // ft
    { i: 105, v: 'Under 0.5' }, // 1ht
    { i: 107, v: 'Under 0.5' }, // 2ht
    { i: 16, v: 'Under 1.5' }, // ft
    { i: 105, v: 'Under 1.5' }, // 1ht
    { i: 107, v: 'Under 1.5' }, // 2ht
    // away
    { i: 17, v: 'Over 0.5' }, // ft
    { i: 106, v: 'Over 0.5' }, // 1ht
    { i: 108, v: 'Over 0.5' }, // 2ht
    { i: 17, v: 'Over 1.5' }, // ft
    { i: 106, v: 'Over 1.5' }, // 1ht
    { i: 108, v: 'Over 1.5' }, // 2ht
    { i: 17, v: 'Under 0.5' }, // ft
    { i: 106, v: 'Under 0.5' }, // 1ht
    { i: 108, v: 'Under 0.5' }, // 2ht
    { i: 17, v: 'Under 1.5' }, // ft
    { i: 106, v: 'Under 1.5' }, // 1ht
    { i: 108, v: 'Under 1.5' }, // 2ht
    // *** BTTS ***
    { i: 8, v: 'Yes' }, // ft
    { i: 34, v: 'Yes' }, // 1ht
    { i: 35, v: 'Yes' }, // 2ht
    { i: 8, v: 'No' }, // ft
    { i: 34, v: 'No' }, // 1ht
    { i: 35, v: 'No' }, // 2ht
    // *** HT/FT ***
    { i: 7, v: 'Home/Home' },
    { i: 7, v: 'Home/Draw' },
    { i: 7, v: 'Home/Away' },
    { i: 7, v: 'Draw/Home' },
    { i: 7, v: 'Draw/Draw' },
    { i: 7, v: 'Draw/Away' },
    { i: 7, v: 'Away/Home' },
    { i: 7, v: 'Away/Draw' },
    { i: 7, v: 'Away/Away' },
];

