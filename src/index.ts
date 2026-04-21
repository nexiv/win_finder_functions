import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions";
import { updateResults } from "./functions/update_results";
import { updateStandings } from "./functions/update_standings";
import { cleanDatabase } from "./functions/clean_database";
import { generateResults } from "./functions/generate_results";

initializeApp();
setGlobalOptions({ region: 'europe-west1', timeoutSeconds: 300 });

exports.updateResults = updateResults;
exports.updateStandings = updateStandings;
exports.cleanDatabase = cleanDatabase;
exports.generateResults = generateResults;

