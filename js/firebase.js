import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCaTCUGcfjoambag2Bq4ieHcDb5tG9S-g4",
  authDomain: "fake-bank-b6e00.firebaseapp.com",
  projectId: "fake-bank-b6e00",
  storageBucket: "fake-bank-b6e00.firebasestorage.app",
  messagingSenderId: "177702690472",
  appId: "1:177702690472:web:8691892f3ac1f102376c9d"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);