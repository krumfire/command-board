import { initializeApp } from "firebase/app";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDw4o2yLQtYlKVW1wDDFCuidBAHMxt6czQ",
  authDomain: "command-board-59e23.firebaseapp.com",
  projectId: "command-board-59e23",
  storageBucket: "command-board-59e23.firebasestorage.app",
  messagingSenderId: "339639440969",
  appId: "1:339639440969:web:4b5e24a5a6e8c9fa4ad198",
  measurementId: "G-PT3DMJDBG3"
};

export const app = initializeApp(firebaseConfig);

// Offline persistence: Firestore caches reads/writes in IndexedDB and
// queues writes made while offline, syncing them automatically once
// connectivity returns — this is what makes "usable with no internet,
// syncs when back online" work, without any custom sync code.
// persistentMultipleTabManager lets it work correctly if the board is
// open in more than one browser tab at once on the same device.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
