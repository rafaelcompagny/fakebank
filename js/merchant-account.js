import { auth, db } from "./firebase.js";
import { watchAuth, logoutUser } from "./auth.js";
import { getUserProfile } from "./db.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const money = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR"
});

function isAdmin(profile) {
  return profile?.role === "admin" || profile?.isAdmin === true;
}

async function loadMerchantAccount() {
  const snap = await getDoc(doc(db, "merchantAccounts", "rafatech"));
  const account = snap.exists()
    ? snap.data()
    : { balance: 0, transactions: [] };

  document.getElementById("companyBalance").textContent = money.format(account.balance || 0);

  const list = document.getElementById("companyTransactions");
  const transactions = account.transactions || [];

  list.innerHTML = transactions.length
    ? transactions.slice(0, 50).map(tx => `
        <div class="merchant-company-transaction">
          <div>
            <strong>${tx.label || "Vente RafaTech"}</strong>
            <span>${tx.payerEmail || ""}</span>
          </div>
          <strong>+${money.format(tx.amount || 0)}</strong>
        </div>
      `).join("")
    : `<div class="list-item">Aucune vente encaissée pour le moment.</div>`;
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    await logoutUser();
    location.href = "index.html";
  });

  watchAuth(async user => {
    if (!user) {
      location.href = "index.html";
      return;
    }

    const profile = await getUserProfile(user.uid);
    if (!isAdmin(profile)) {
      alert("Cette page est réservée à l'administration Cryptex.");
      location.href = "home.html";
      return;
    }

    await loadMerchantAccount();
  });
});
