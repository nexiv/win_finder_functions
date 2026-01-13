import { getAuth, FirebaseAuthError } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";


export const deleteUser = onCall({ region: 'europe-west1' }, async (req) => {
    if (!req.auth) {
        throw new HttpsError("unauthenticated", "");
    }

    const uid = req.auth.uid;
    const auth = getAuth();
    const firestore = getFirestore();

    try {
        // Delete user-related data
        await firestore.collection("user-filters").doc(uid).delete();

        // Delete auth user
        await auth.deleteUser(uid);

        return { success: true };
    } catch (error) {
        // If the auth user is already gone, treat as success
        if (
            error instanceof FirebaseAuthError &&
            error.code === "auth/user-not-found"
        ) {
            return { success: true };
        }

        console.error("Error deleting account for uid:", uid, error);
        throw new HttpsError("internal", "");
    }
}
);


