import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions";
import { updateOdds } from "./functions/update_odds";
import { updateResults } from "./functions/update_results";
import { updateStandings } from "./functions/update_standings";
import { cleanDatabase } from "./functions/clean_database";

initializeApp();
setGlobalOptions({ region: 'europe-west1', timeoutSeconds: 300 });

exports.updateOdds = updateOdds;
exports.update_results = updateResults;
exports.updateStandings = updateStandings;
exports.cleanDatabase = cleanDatabase;


