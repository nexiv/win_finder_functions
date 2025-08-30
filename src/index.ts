// import * as logger from "firebase-functions/logger";
import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions";
import { updateOdds } from "./functions/update_odds";

initializeApp();
setGlobalOptions({ region: 'europe-west1', timeoutSeconds: 300 });

exports.updateOdds = updateOdds;


