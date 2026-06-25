// Outcome computation for the backtest filter.
//
// For each match that passes the user filter we count how many of the ~106
// outcomes it hit. Outcomes are grouped to mirror the client enums exactly;
// within each group the array index equals the enum's index.
//
// Result bytes per match: [h1, a1, h2, a2, h, a]
//   h1/a1 = first-half goals, h2/a2 = second-half goals, h/a = full-time goals.
//   T  = h + a   (full-time total)
//   T1 = h1 + a1 (first-half total)
//   T2 = h2 + a2 (second-half total)

export const RESULT_LEN = 15;
export const DOUBLE_CHANCE_LEN = 15;
export const GOALS_LEN = 35;
export const TEAM_GOALS_LEN = 24;
export const BTTS_LEN = 8;
export const HTFT_LEN = 9;

export interface OutcomeAcc {
  result: Int32Array;
  doubleChance: Int32Array;
  goals: Int32Array;
  teamGoals: Int32Array;
  btts: Int32Array;
  htft: Int32Array;
}

export function newAcc(): OutcomeAcc {
  return {
    result: new Int32Array(RESULT_LEN),
    doubleChance: new Int32Array(DOUBLE_CHANCE_LEN),
    goals: new Int32Array(GOALS_LEN),
    teamGoals: new Int32Array(TEAM_GOALS_LEN),
    btts: new Int32Array(BTTS_LEN),
    htft: new Int32Array(HTFT_LEN),
  };
}

/** Increment +1 if cond is true (avoids branchy if-blocks). */
const inc = (arr: Int32Array, i: number, cond: boolean) => {
  if (cond) arr[i]++;
};

/** Accumulate all outcome counts for a single match. */
export function accumulate(
  h1: number,
  a1: number,
  h2: number,
  a2: number,
  h: number,
  a: number,
  acc: OutcomeAcc,
): void {
  const T = h + a;
  const T1 = h1 + a1;
  const T2 = h2 + a2;

  // --- OutcomeResult (1X2, per half, and combined with total goals) ---
  const r = acc.result;
  inc(r, 0, h > a);
  inc(r, 1, h1 > a1);
  inc(r, 2, h2 > a2);
  inc(r, 3, h === a);
  inc(r, 4, h1 === a1);
  inc(r, 5, h2 === a2);
  inc(r, 6, a > h);
  inc(r, 7, a1 > h1);
  inc(r, 8, a2 > h2);
  inc(r, 9, h > a && T >= 3);
  inc(r, 10, h === a && T >= 3);
  inc(r, 11, a > h && T >= 3);
  inc(r, 12, h > a && T <= 2);
  inc(r, 13, h === a && T <= 2);
  inc(r, 14, a > h && T <= 2);

  // --- OutcomeDoubleChance (>=, per half, combined with total goals) ---
  const dc = acc.doubleChance;
  inc(dc, 0, h >= a);
  inc(dc, 1, h1 >= a1);
  inc(dc, 2, h2 >= a2);
  inc(dc, 3, h !== a);
  inc(dc, 4, h1 !== a1);
  inc(dc, 5, h2 !== a2);
  inc(dc, 6, a >= h);
  inc(dc, 7, a1 >= h1);
  inc(dc, 8, a2 >= h2);
  inc(dc, 9, h >= a && T >= 3);
  inc(dc, 10, h !== a && T >= 3);
  inc(dc, 11, a >= h && T >= 3);
  inc(dc, 12, h >= a && T <= 2);
  inc(dc, 13, h !== a && T <= 2);
  inc(dc, 14, a >= h && T <= 2);

  // --- OutcomeGoals (total goals, ranges inclusive; _12ht = holds in both halves) ---
  const g = acc.goals;
  inc(g, 0, T === 0);
  inc(g, 1, T1 === 0);
  inc(g, 2, T2 === 0);
  inc(g, 3, T >= 1);
  inc(g, 4, T1 >= 1);
  inc(g, 5, T2 >= 1);
  inc(g, 6, T >= 2);
  inc(g, 7, T1 >= 2);
  inc(g, 8, T2 >= 2);
  inc(g, 9, T >= 3);
  inc(g, 10, T1 >= 3);
  inc(g, 11, T2 >= 3);
  inc(g, 12, T >= 4);
  inc(g, 13, T >= 5);
  inc(g, 14, T >= 6);
  inc(g, 15, T >= 7);
  inc(g, 16, T <= 1);
  inc(g, 17, T1 <= 1);
  inc(g, 18, T2 <= 1);
  inc(g, 19, T <= 2);
  inc(g, 20, T1 <= 2);
  inc(g, 21, T2 <= 2);
  inc(g, 22, T >= 1 && T <= 2);
  inc(g, 23, T1 >= 1 && T1 <= 2);
  inc(g, 24, T2 >= 1 && T2 <= 2);
  inc(g, 25, T >= 1 && T <= 3);
  inc(g, 26, T1 >= 1 && T1 <= 3);
  inc(g, 27, T2 >= 1 && T2 <= 3);
  inc(g, 28, T >= 2 && T <= 3);
  inc(g, 29, T >= 2 && T <= 4);
  inc(g, 30, T >= 2 && T <= 5);
  inc(g, 31, T1 >= 1 && T2 >= 1);
  inc(g, 32, T1 >= 2 && T2 >= 2);
  inc(g, 33, T1 >= 1 && T1 <= 2 && T2 >= 1 && T2 <= 2);
  inc(g, 34, T1 >= 1 && T1 <= 3 && T2 >= 1 && T2 <= 3);

  // --- OutcomeTeamGoals (t1 = home h/h1/h2, t2 = away a/a1/a2) ---
  const tg = acc.teamGoals;
  inc(tg, 0, h === 0);
  inc(tg, 1, h1 === 0);
  inc(tg, 2, h2 === 0);
  inc(tg, 3, h >= 1);
  inc(tg, 4, h1 >= 1);
  inc(tg, 5, h2 >= 1);
  inc(tg, 6, h >= 2);
  inc(tg, 7, h1 >= 2);
  inc(tg, 8, h2 >= 2);
  inc(tg, 9, h >= 3);
  inc(tg, 10, h1 >= 3);
  inc(tg, 11, h2 >= 3);
  inc(tg, 12, a === 0);
  inc(tg, 13, a1 === 0);
  inc(tg, 14, a2 === 0);
  inc(tg, 15, a >= 1);
  inc(tg, 16, a1 >= 1);
  inc(tg, 17, a2 >= 1);
  inc(tg, 18, a >= 2);
  inc(tg, 19, a1 >= 2);
  inc(tg, 20, a2 >= 2);
  inc(tg, 21, a >= 3);
  inc(tg, 22, a1 >= 3);
  inc(tg, 23, a2 >= 3);

  // --- OutcomeBtts (both teams to score) ---
  const b = acc.btts;
  const bttsFt = h >= 1 && a >= 1;
  const btts1 = h1 >= 1 && a1 >= 1;
  const btts2 = h2 >= 1 && a2 >= 1;
  inc(b, 0, bttsFt);
  inc(b, 1, btts1);
  inc(b, 2, btts2);
  inc(b, 3, !bttsFt);
  inc(b, 4, !btts1);
  inc(b, 5, !btts2);
  inc(b, 6, btts1 && btts2);
  inc(b, 7, bttsFt && T >= 3);

  // --- OutcomeHtFt (half-time result x full-time result) ---
  const ht = acc.htft;
  const htHome = h1 > a1, htDraw = h1 === a1, htAway = a1 > h1;
  const ftHome = h > a, ftDraw = h === a, ftAway = a > h;
  inc(ht, 0, htHome && ftHome);
  inc(ht, 1, htHome && ftDraw);
  inc(ht, 2, htHome && ftAway);
  inc(ht, 3, htDraw && ftHome);
  inc(ht, 4, htDraw && ftDraw);
  inc(ht, 5, htDraw && ftAway);
  inc(ht, 6, htAway && ftHome);
  inc(ht, 7, htAway && ftDraw);
  inc(ht, 8, htAway && ftAway);
}
