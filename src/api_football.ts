import { HEADERS, URL } from "./config";

// api-sports caps /fixtures?ids= at 20 ids per request.
export const API_CHUNK_SIZE = 20;

// api-sports reads a burst of simultaneous requests as abuse and starts refusing
// them, so requests are sent one at a time with a gap in between.
const API_REQUEST_GAP_MS = 300;
const API_RETRY_DELAY_MS = 3000;
const API_RATE_LIMIT_PAUSE_MS = 5000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** api-sports sends `errors: []` when all is well, and an object with a reason when not. */
const hasErrors = (errors: any): boolean =>
    Array.isArray(errors) ? errors.length > 0 : !!errors && Object.keys(errors).length > 0;

/** One fixture as returned by api-sports /fixtures. */
export class ApiGame {
    id: number;
    status: string;
    kickoff: number;
    h: number | null;
    h1: number | null;
    a: number | null;
    a1: number | null;

    constructor(data: any) {
        const { fixture, score } = data;

        this.id = fixture.id;
        this.status = fixture.status.short;
        this.kickoff = fixture.timestamp * 1000;

        // Deliberately nullable. The API leaves fulltime null for as long as a match
        // is running, and coercing that to 0 is what used to store matches as 0-0.
        this.h = score.fulltime?.home ?? null;
        this.h1 = score.halftime?.home ?? null;
        this.a = score.fulltime?.away ?? null;
        this.a1 = score.halftime?.away ?? null;
    }

    get notStarted(): boolean {
        return this.status === 'NS';
    }

    get active(): boolean {
        return ['1H', 'HT', '2H', 'INT', 'LIVE', 'ET', 'BT', 'P'].includes(this.status);
    }

    get canceled(): boolean {
        return ['SUSP', 'PST', 'CANC', 'ABD', 'AWD', 'WO'].includes(this.status);
    }

    /**
     * True once the API has published the 90-minute score. We read the data rather
     * than the status on purpose: fulltime stays null through extra time and
     * penalties as well, so a match that is still running can never slip through,
     * whatever the status happens to be called.
     */
    get settled(): boolean {
        return this.h !== null && this.h1 !== null && this.a !== null && this.a1 !== null;
    }

    /** The 90-minute score in storage order. Only meaningful once settled. */
    get score(): number[] {
        return [this.h1!, this.a1!, this.h!, this.a!];
    }
}

/** A single request. Pass at most API_CHUNK_SIZE ids. */
export const fetchGames = async (ids: string[]): Promise<ApiGame[]> => {
    const url = `${URL}/fixtures?ids=${ids.join('-')}`;

    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Failed to fetch games: ${res.status} ${res.statusText}`);

    // Same courtesy updateStandings shows: ease off before hitting the limit.
    const remaining = parseInt(res.headers.get("x-ratelimit-remaining") ?? "20", 10);
    if (remaining < 20) await sleep(API_RATE_LIMIT_PAUSE_MS);

    const data: { response?: any[]; errors?: any } = await res.json();

    // A refused request still answers 200 — the complaint only shows up in the body.
    // Without this the caller cannot tell "no such fixtures" from "we were throttled",
    // and silently skips every match in the chunk.
    if (hasErrors(data.errors)) throw new Error(`API refused the request: ${JSON.stringify(data.errors)}`);

    return (data.response ?? []).map(game => new ApiGame(game));
};

/** One request, retried once — api-sports drops one now and then. */
const fetchChunk = async (chunk: string[]): Promise<ApiGame[] | null> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            return await fetchGames(chunk);
        } catch (error) {
            console.error(`Fixture request failed (attempt ${attempt}/2) for ${chunk.length} ids:`, error);
            if (attempt < 2) await sleep(API_RETRY_DELAY_MS);
        }
    }
    return null;
};

/**
 * Fetch any number of fixtures, one request at a time. A chunk that fails twice is
 * given up on rather than failing the whole run: `failed` says how many ids never
 * came back, and the caller decides what to do about them.
 */
export const fetchGamesByIds = async (ids: string[]): Promise<{ games: ApiGame[]; failed: number }> => {
    const chunks = splitArrayIntoChunks(ids, API_CHUNK_SIZE);
    const games: ApiGame[] = [];
    let failed = 0;

    for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await sleep(API_REQUEST_GAP_MS);

        const fetched = await fetchChunk(chunks[i]);
        if (fetched) games.push(...fetched);
        else failed += chunks[i].length;
    }

    return { games, failed };
};

export const splitArrayIntoChunks = <T>(arr: T[], chunkSize: number): T[][] =>
    Array.from({ length: Math.ceil(arr.length / chunkSize) }, (_, i) =>
        arr.slice(i * chunkSize, i * chunkSize + chunkSize)
    );
