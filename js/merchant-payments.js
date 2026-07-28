import { auth, db } from "./firebase.js";
import { watchAuth, logoutUser } from "./auth.js";
import { getUserProfile } from "./db.js";

import {
  collection,
  query,
  where,
  getDocs,
  doc,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const money = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR"
});

let currentUser = null;
let currentProfile = null;
let requestsCache = [];

function esc(value) {
  return String(value ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function requestDate(request) {
  if (request.createdAt?.seconds) return new Date(request.createdAt.seconds * 1000);
  if (request.createdAtLocal) return new Date(request.createdAtLocal);
  return null;
}

function statusInfo(status) {
  const map = {
    pending: ["En attente", "merchant-status-pending"],
    approved: ["Accepté", "merchant-status-approved"],
    declined: ["Refusé", "merchant-status-declined"],
    insufficient_funds: ["Solde insuffisant", "merchant-status-declined"],
    expired: ["Expiré", "merchant-status-muted"],
    cancelled: ["Annulé", "merchant-status-muted"]
  };
  return map[status] || [status || "Inconnu", "merchant-status-muted"];
}

async function loadRequests() {
  if (!currentUser?.email) return;

  const q = query(
    collection(db, "merchantPaymentRequests"),
    where("payerEmail", "==", currentUser.email.toLowerCase())
  );

  const snap = await getDocs(q);
  requestsCache = snap.docs
    .map(document => ({ id: document.id, ...document.data() }))
    .sort((a,b) => (requestDate(b)?.getTime() || 0) - (requestDate(a)?.getTime() || 0));

  renderRequests();
  updatePendingBadge();
}

function updatePendingBadge() {
  const count = requestsCache.filter(r => r.status === "pending").length;
  const el = document.getElementById("merchantPendingCount");
  if (el) el.textContent = count;
}

function renderRequests() {
  const pendingBox = document.getElementById("merchantPendingList");
  const historyBox = document.getElementById("merchantHistoryList");

  const pending = requestsCache.filter(r => r.status === "pending");
  const history = requestsCache.filter(r => r.status !== "pending");

  pendingBox.innerHTML = pending.length
    ? pending.map(renderPendingCard).join("")
    : `<div class="merchant-empty">
         <div>✓</div>
         <strong>Aucune demande en attente</strong>
         <p>Les demandes RafaTech apparaîtront ici automatiquement.</p>
       </div>`;

  historyBox.innerHTML = history.length
    ? history.slice(0,30).map(renderHistoryCard).join("")
    : `<div class="list-item">Aucun paiement partenaire dans l'historique.</div>`;

  document.querySelectorAll(".approve-merchant-payment").forEach(button => {
    button.addEventListener("click", () => approveRequest(button.dataset.id));
  });

  document.querySelectorAll(".decline-merchant-payment").forEach(button => {
    button.addEventListener("click", () => declineRequest(button.dataset.id));
  });
}

function renderPendingCard(request) {
  const date = requestDate(request);
  return `
    <article class="merchant-payment-card">
      <div class="merchant-payment-head">
        <div class="merchant-logo rafatech-merchant-logo">
          <img src="img/rafatech.webp" alt="RafaTech">
        </div>
        <div class="merchant-main">
          <span class="merchant-kicker">Demande de paiement</span>
          <h3>${esc(request.merchantName || "RafaTech")}</h3>
          <p>${esc(request.orderNumber || "")}</p>
        </div>
        <strong class="merchant-amount">${money.format(request.amount || 0)}</strong>
      </div>

      <div class="merchant-payment-details">
        <div><span>Montant HT</span><strong>${money.format(request.amountHT || 0)}</strong></div>
        <div><span>TVA</span><strong>${money.format(request.vatAmount || 0)}</strong></div>
        <div><span>Compte débité</span><strong>Compte courant</strong></div>
        <div><span>Date</span><strong>${date ? date.toLocaleString("fr-FR") : "À l'instant"}</strong></div>
      </div>

      <div class="merchant-security-note">
        <span>🔐</span>
        <p>Vérifie le commerçant et le montant avant d'autoriser. Cryptex débitera ton compte courant immédiatement.</p>
      </div>

      <div class="merchant-payment-actions">
        <button class="decline-merchant-payment secondary" data-id="${request.id}">Refuser</button>
        <button class="approve-merchant-payment" data-id="${request.id}">Autoriser ${money.format(request.amount || 0)}</button>
      </div>
    </article>
  `;
}

function renderHistoryCard(request) {
  const [label, css] = statusInfo(request.status);
  const date = requestDate(request);

  return `
    <div class="merchant-history-row">
      <div class="merchant-logo small">
        <img src="img/rafatech.webp" alt="RafaTech">
      </div>
      <div>
        <strong>${esc(request.merchantName || "RafaTech")}</strong>
        <span>${esc(request.orderNumber || "")} • ${date ? date.toLocaleDateString("fr-FR") : ""}</span>
      </div>
      <span class="merchant-status ${css}">${label}</span>
      <strong>${money.format(request.amount || 0)}</strong>
    </div>
  `;
}


async function findRafaTechEnterpriseUser() {
  const q = query(
    collection(db, "users"),
    where("email", "==", "rafatech@cryptex.fr")
  );
  const snap = await getDocs(q);

  if (snap.empty) {
    throw new Error(
      "Le compte Cryptex rafatech@cryptex.fr existe peut-être dans Authentication, " +
      "mais aucun profil correspondant n'a été trouvé dans Firestore /users."
    );
  }

  const docSnap = snap.docs[0];
  return { id: docSnap.id, ...docSnap.data() };
}

async function approveRequest(requestId) {
  if (!currentUser) return;

  const request = requestsCache.find(r => r.id === requestId);
  if (!request) return;

  if (!confirm(`Autoriser le paiement de ${money.format(request.amount || 0)} à RafaTech ?`)) return;

  try {
    const rafaTechUser = await findRafaTechEnterpriseUser();

    const userRef = doc(db, "users", currentUser.uid);
    const requestRef = doc(db, "merchantPaymentRequests", requestId);
    const merchantRef = doc(db, "merchantAccounts", "rafatech");
    const merchantUserRef = doc(db, "users", rafaTechUser.id);

    await runTransaction(db, async transaction => {
      // Toutes les lectures avant les écritures.
      const requestSnap = await transaction.get(requestRef);
      const userSnap = await transaction.get(userRef);
      const merchantSnap = await transaction.get(merchantRef);
      const merchantUserSnap = await transaction.get(merchantUserRef);

      if (!requestSnap.exists()) throw new Error("Demande introuvable.");
      if (!userSnap.exists()) throw new Error("Profil Cryptex introuvable.");
      if (!merchantUserSnap.exists()) throw new Error("Compte RafaTech Entreprise introuvable dans Firestore.");

      const payment = requestSnap.data();
      const profile = userSnap.data();

      if (payment.status !== "pending") {
        throw new Error("Cette demande a déjà été traitée.");
      }

      if (String(payment.payerEmail || "").toLowerCase() !== String(currentUser.email || "").toLowerCase()) {
        throw new Error("Cette demande ne correspond pas à ton compte Cryptex.");
      }

      const amount = Number(payment.amount || 0);
      if (!(amount > 0)) throw new Error("Montant de paiement invalide.");

      const accounts = { ...(profile.accounts || { courant:0, epargne:0 }) };
      const currentBalance = Number(accounts.courant || 0);

      if (currentBalance < amount) {
        transaction.update(requestRef, {
          status: "insufficient_funds",
          declineReason: "Solde du compte courant insuffisant.",
          processedByUid: currentUser.uid,
          processedAt: serverTimestamp(),
          processedAtLocal: new Date().toISOString()
        });
        return;
      }

      accounts.courant = Math.round((currentBalance - amount) * 100) / 100;

      const transactionId = `CTX-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
      const tx = {
        id: transactionId,
        label: `Paiement RafaTech — ${payment.orderNumber || ""}`,
        amount: -amount,
        category: "merchant_payment",
        merchant: "RafaTech",
        merchantPaymentRequestId: requestId,
        createdAt: Date.now(),
        monthKey: new Date().toISOString().slice(0,7)
      };

      const transactions = [tx, ...(profile.transactions || [])];

      // VRAI compte utilisateur Cryptex RafaTech Entreprise.
      const merchantUser = merchantUserSnap.data();
      const merchantUserAccounts = {
        ...(merchantUser.accounts || { courant: 0, epargne: 0 })
      };

      const merchantUserBalance = Number(merchantUserAccounts.courant || 0);
      merchantUserAccounts.courant =
        Math.round((merchantUserBalance + amount) * 100) / 100;

      const merchantUserTx = {
        id: transactionId,
        label: `Vente RafaTech — ${payment.orderNumber || ""}`,
        amount,
        category: "merchant_income",
        merchant: "RafaTech",
        payerEmail: payment.payerEmail || "",
        merchantPaymentRequestId: requestId,
        createdAt: Date.now(),
        monthKey: new Date().toISOString().slice(0,7)
      };

      const merchantUserTransactions = [
        merchantUserTx,
        ...(merchantUser.transactions || [])
      ];

      const merchantUserHistory = [
        `Vente RafaTech ${payment.orderNumber || ""} +${money.format(amount)}`,
        ...(merchantUser.history || [])
      ];

      const merchantUserNotifications = [{
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        title: "Vente RafaTech reçue",
        message: `${money.format(amount)} ont été crédités sur le compte courant RafaTech Entreprise.`,
        type: "success",
        read: false,
        createdAt: Date.now()
      }, ...(merchantUser.notifications || [])];

      // Compte marchand interne conservé pour statistiques / historique global.
      const merchantAccount = merchantSnap.exists()
        ? merchantSnap.data()
        : {
            merchantId: "rafatech",
            name: "RafaTech Entreprise",
            email: "rafatech@cryptex.fr",
            balance: 0,
            transactions: []
          };

      const merchantBalance = Number(merchantAccount.balance || 0);
      const merchantTx = {
        id: transactionId,
        label: `Vente RafaTech — ${payment.orderNumber || ""}`,
        amount,
        type: "credit",
        payerEmail: payment.payerEmail || "",
        paymentRequestId: requestId,
        createdAt: Date.now()
      };

      const newMerchantBalance = Math.round((merchantBalance + amount) * 100) / 100;
      const merchantTransactions = [merchantTx, ...(merchantAccount.transactions || [])].slice(0, 250);

      const history = [
        `Paiement RafaTech ${payment.orderNumber || ""} -${money.format(amount)}`,
        ...(profile.history || [])
      ];
      const notifications = [{
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        title: "Paiement RafaTech accepté",
        message: `${money.format(amount)} ont été débités de ton compte courant.`,
        type: "success",
        read: false,
        createdAt: Date.now()
      }, ...(profile.notifications || [])];

      transaction.update(userRef, {
        accounts,
        transactions,
        history,
        notifications
      });

      // Crédit du vrai compte Cryptex rafatech@cryptex.fr
      transaction.update(merchantUserRef, {
        accounts: merchantUserAccounts,
        transactions: merchantUserTransactions,
        history: merchantUserHistory,
        notifications: merchantUserNotifications
      });

      transaction.set(merchantRef, {
        merchantId: "rafatech",
        name: "RafaTech Entreprise",
        email: "rafatech@cryptex.fr",
        balance: newMerchantBalance,
        transactions: merchantTransactions,
        updatedAt: serverTimestamp()
      }, { merge: true });

      transaction.update(requestRef, {
        status: "approved",
        transactionId,
        approvedByUid: currentUser.uid,
        approvedAt: serverTimestamp(),
        approvedAtLocal: new Date().toISOString()
      });
    });

    await refreshProfile();
    await loadRequests();
  } catch (error) {
    console.error(error);
    alert(error.message || "Impossible d'autoriser ce paiement.");
  }
}

async function declineRequest(requestId) {
  if (!currentUser) return;
  if (!confirm("Refuser cette demande de paiement RafaTech ?")) return;

  try {
    const requestRef = doc(db, "merchantPaymentRequests", requestId);

    await runTransaction(db, async transaction => {
      const snap = await transaction.get(requestRef);
      if (!snap.exists()) throw new Error("Demande introuvable.");

      const payment = snap.data();
      if (payment.status !== "pending") throw new Error("Cette demande a déjà été traitée.");
      if (String(payment.payerEmail || "").toLowerCase() !== String(currentUser.email || "").toLowerCase()) {
        throw new Error("Cette demande ne correspond pas à ton compte.");
      }

      transaction.update(requestRef, {
        status: "declined",
        declineReason: "Paiement refusé par le client Cryptex Bank.",
        processedByUid: currentUser.uid,
        processedAt: serverTimestamp(),
        processedAtLocal: new Date().toISOString()
      });
    });

    await loadRequests();
  } catch (error) {
    console.error(error);
    alert(error.message || "Impossible de refuser ce paiement.");
  }
}

async function refreshProfile() {
  currentProfile = await getUserProfile(currentUser.uid);
  const balance = document.getElementById("merchantCurrentBalance");
  if (balance) balance.textContent = money.format(currentProfile?.accounts?.courant || 0);
}

function bindLogout() {
  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    await logoutUser();
    location.href = "index.html";
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindLogout();

  watchAuth(async user => {
    if (!user) {
      location.href = "index.html";
      return;
    }

    currentUser = user;
    currentProfile = await getUserProfile(user.uid);

    document.getElementById("merchantAccountEmail").textContent = user.email || "";
    await refreshProfile();
    await loadRequests();

    // Les demandes RafaTech peuvent arriver pendant que la page est ouverte.
    setInterval(loadRequests, 4000);
  });
});
