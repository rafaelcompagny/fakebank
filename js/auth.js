import { auth } from "./firebase.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

export async function registerUser(email, password) {
  return await createUserWithEmailAndPassword(auth, email, password);
}

export async function loginUser(email, password) {
  return await signInWithEmailAndPassword(auth, email, password);
}

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  return await signInWithPopup(auth, provider);
}

export async function resetPassword(email) {
  return await sendPasswordResetEmail(auth, email);
}

export async function logoutUser() {
  return await signOut(auth);
}

export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}