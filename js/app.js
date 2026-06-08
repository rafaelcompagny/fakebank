import { watchAuth, logoutUser } from "./auth.js";
import { getUserProfile, updateUserProfile, getAllUsers } from "./db.js";

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getCardPin(profile) {
  return profile.card?.pin || "Aucun";
}

function getUserTotalBalance(profile) {
  return Object.values(profile.accounts || {}).reduce((sum, v) => sum + Number(v || 0), 0);
}

function generateCardNumber() {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 10))
    .join("")
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

function generateCvv() {
  return String(Math.floor(100 + Math.random() * 900));
}

function getExpiryFromCreatedAt(createdAt) {
  const date = new Date(createdAt || Date.now());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear() + 4;

  return `${month}/${String(year).slice(-2)}`;
}

async function adminChangeMoney(targetUid, mode) {
  const input = document.querySelector(`.admin-money-input[data-uid="${targetUid}"]`);
  const amount = Number(input?.value || 0);

  if (!amount || amount <= 0) {
    alert("Montant invalide.");
    return;
  }

  const profile = await getUserProfile(targetUid);
  if (!profile) return;

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.history = profile.history || [];

  if (mode === "add") {
    profile.accounts.courant += amount;
    profile.history.unshift(`Admin : ajout de ${formatMoney(amount)}`);
  }

  if (mode === "remove") {
    if ((profile.accounts.courant || 0) < amount) {
      alert("Solde courant insuffisant.");
      return;
    }

    profile.accounts.courant -= amount;
    profile.history.unshift(`Admin : retrait de ${formatMoney(amount)}`);
  }

  await updateUserProfile(targetUid, {
    accounts: profile.accounts,
    history: profile.history
  });
}

async function initAdmin(user) {
  bindLogout();
  await renderAdmin(user.uid);
}

const HISTORY_PER_PAGE = 15;
const historyPages = {};

function renderPaginatedHistory(containerId, history, key) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const items = history || [];
  const totalPages = Math.max(1, Math.ceil(items.length / HISTORY_PER_PAGE));

  if (!historyPages[key]) historyPages[key] = 1;
  if (historyPages[key] > totalPages) historyPages[key] = totalPages;

  const page = historyPages[key];
  const start = (page - 1) * HISTORY_PER_PAGE;
  const visibleItems = items.slice(start, start + HISTORY_PER_PAGE);

  container.innerHTML = `
    <div>
      ${
        visibleItems.length
          ? visibleItems.map(item => `<div class="list-item">${escapeHtml(item)}</div>`).join("")
          : `<div class="list-item">Aucune opération.</div>`
      }
    </div>

    <div class="history-pagination">
      <button class="history-prev" data-key="${key}" ${page <= 1 ? "disabled" : ""}>‹</button>
      <span>Page ${page}/${totalPages}</span>
      <button class="history-next" data-key="${key}" ${page >= totalPages ? "disabled" : ""}>›</button>
    </div>
  `;

  container.querySelector(".history-prev")?.addEventListener("click", () => {
    historyPages[key]--;
    renderPaginatedHistory(containerId, history, key);
  });

  container.querySelector(".history-next")?.addEventListener("click", () => {
    historyPages[key]++;
    renderPaginatedHistory(containerId, history, key);
  });
}

const page = document.body.dataset.page;

const BANK_CARDS = {
  classic: {
    name: "Classique",
    price: 0,
    savingBonus: 0,
    feeReduction: 0
  },
  green: {
    name: "Verte",
    price: 5,
    savingBonus: 0.1,
    feeReduction: 0
  },
  gold: {
    name: "Gold",
    price: 15,
    savingBonus: 0.25,
    feeReduction: 5
  },
  black: {
    name: "Black",
    price: 25,
    savingBonus: 0.5,
    feeReduction: 10
  },
  premium: {
    name: "Premium",
    price: 1000,
    savingBonus: 1,
    feeReduction: 20
  }
};

function formatMoney(value) {
  return Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) + " €";
}

function getTotalBalance(profile) {
  return Object.values(profile.accounts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function getSavingRate(profile) {
  const baseRate = 5;
  const cardType = profile.card?.type || "classic";
  const bonus = BANK_CARDS[cardType]?.savingBonus || 0;
  return baseRate + bonus;
}

function getLevelData(xp = 0) {
  let level = 1;
  let required = 1000;
  let remaining = xp;

  while (remaining >= required) {
    remaining -= required;
    level++;
    required = Math.floor(required * 1.35);
  }

  return {
    level,
    currentXp: remaining,
    requiredXp: required,
    percent: Math.min(100, (remaining / required) * 100)
  };
}

function addXp(profile, amount, reason) {
  profile.xp = Number(profile.xp || 0) + amount;
  profile.history = profile.history || [];
  profile.history.unshift(`XP +${amount} — ${reason}`);
}

function updateAdminNavVisibility(profile) {
  const link = document.getElementById("adminNavLink");
  if (link) link.style.display = profile?.isAdmin ? "flex" : "none";
}

function bindLogout() {
  const btn = document.getElementById("logoutBtn");
  if (!btn) return;

  btn.onclick = async () => {
    await logoutUser();
    window.location.href = "index.html";
  };
}

async function applySavingInterest(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const now = Date.now();
  const last = profile.lastInterestPayment || now;
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (now - last < oneDayMs) return;

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.history = profile.history || [];

  const rate = getSavingRate(profile) / 100;
  const dailyRate = rate / 365;
  const interest = (profile.accounts.epargne || 0) * dailyRate;

  profile.accounts.epargne += interest;
  profile.lastInterestPayment = now;

  if (interest > 0) {
    profile.history.unshift(`Intérêts épargne +${formatMoney(interest)}`);
  }

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    lastInterestPayment: profile.lastInterestPayment
  });
}

async function renderHome(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  updateAdminNavVisibility(profile);

  const totalBalance = document.getElementById("totalBalance");
  const currentBalance = document.getElementById("currentBalance");
  const savingBalance = document.getElementById("savingBalance");
  const welcomeText = document.getElementById("welcomeText");
  const ibanText = document.getElementById("ibanText");
  const savingRateText = document.getElementById("savingRateText");
  const cardTypeText = document.getElementById("cardTypeText");
  const cardAdvantagesText = document.getElementById("cardAdvantagesText");
  const historyEl = document.getElementById("history");
  const levelText = document.getElementById("levelText");
  const xpText = document.getElementById("xpText");
  const xpBar = document.getElementById("xpBar");

  const accounts = profile.accounts || { courant: 0, epargne: 0 };
  const cardType = profile.card?.type || "classic";
  const card = BANK_CARDS[cardType] || BANK_CARDS.classic;
  const levelData = getLevelData(profile.xp || 0);

  if (totalBalance) totalBalance.innerText = formatMoney(getTotalBalance(profile));
  if (currentBalance) currentBalance.innerText = formatMoney(accounts.courant || 0);
  if (savingBalance) savingBalance.innerText = formatMoney(accounts.epargne || 0);
  if (welcomeText) welcomeText.innerText = `Bienvenue ${profile.displayName || profile.username || ""}`;
  if (ibanText) ibanText.innerText = `IBAN : ${profile.iban || "Non défini"}`;
  if (savingRateText) savingRateText.innerText = `Taux épargne : ${getSavingRate(profile).toFixed(2)}% / an`;

  if (cardTypeText) cardTypeText.innerText = `Carte ${card.name}`;
  if (cardAdvantagesText) {
    cardAdvantagesText.innerText =
      `Bonus épargne : +${card.savingBonus}% • Réduction frais : ${card.feeReduction}%`;
  }

  if (levelText) levelText.innerText = `Niveau ${levelData.level}`;
  if (xpText) {
    xpText.innerText =
      `${Math.floor(levelData.currentXp).toLocaleString("fr-FR")} / ${levelData.requiredXp.toLocaleString("fr-FR")} XP`;
  }
  if (xpBar) xpBar.style.width = `${levelData.percent}%`;

  const history = profile.history || [];
  if (historyEl) {
    renderPaginatedHistory("history", profile.history || [], "homeHistory");
  }
}

async function transferSaving(uid, direction) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const amount = Number(document.getElementById("savingAmount")?.value || 0);
  if (!amount || amount <= 0) return alert("Montant invalide.");

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.history = profile.history || [];

  if (direction === "deposit") {
    if ((profile.accounts.courant || 0) < amount) return alert("Solde courant insuffisant.");

    profile.accounts.courant -= amount;
    profile.accounts.epargne += amount;
    profile.history.unshift(`Transfert vers épargne -${formatMoney(amount)}`);
    addXp(profile, 5, "Épargne");
  }

  if (direction === "withdraw") {
    if ((profile.accounts.epargne || 0) < amount) return alert("Solde épargne insuffisant.");

    profile.accounts.epargne -= amount;
    profile.accounts.courant += amount;
    profile.history.unshift(`Retrait depuis épargne +${formatMoney(amount)}`);
    addXp(profile, 5, "Épargne");
  }

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    xp: profile.xp
  });

  document.getElementById("savingAmount").value = "";
  await renderHome(uid);
}

async function initHome(user) {
  bindLogout();

  await applySavingInterest(user.uid);
  await renderHome(user.uid);

  const depositSavingBtn = document.getElementById("depositSavingBtn");
  const withdrawSavingBtn = document.getElementById("withdrawSavingBtn");

  if (depositSavingBtn) {
    depositSavingBtn.onclick = async () => {
      await transferSaving(user.uid, "deposit");
    };
  }

  if (withdrawSavingBtn) {
    withdrawSavingBtn.onclick = async () => {
      await transferSaving(user.uid, "withdraw");
    };
  }
}



/////////////////////////////////////////////////////////////////////////
              /// PAYMENTS ///
/////////////////////////////////////////////////////////////////////////


async function renderPayments(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  updateAdminNavVisibility(profile);

  const paymentBalance = document.getElementById("paymentBalance");
  const myIban = document.getElementById("myIban");
  const contactsList = document.getElementById("contactsList");
  const paymentsHistory = document.getElementById("paymentsHistory");

  if (paymentBalance) {
    paymentBalance.innerText = formatMoney(profile.accounts?.courant || 0);
  }

  if (myIban) {
    myIban.innerText = `IBAN : ${profile.iban || "Non défini"}`;
  }

  const contacts = profile.contacts || [];

  if (contactsList) {
    contactsList.innerHTML = contacts.length
      ? contacts.map((contact, index) => `
        <div class="list-item">
          <strong>${contact.name}</strong><br>
          <span class="small">${contact.iban}</span>

          <div class="row" style="margin-top:8px;">
            <button class="use-contact-btn" data-iban="${contact.iban}">Utiliser</button>
            <button class="secondary delete-contact-btn" data-index="${index}">Supprimer</button>
          </div>
        </div>
      `).join("")
      : `<div class="list-item">Aucun contact enregistré.</div>`;
  }

  document.querySelectorAll(".use-contact-btn").forEach(btn => {
    btn.onclick = () => {
      const receiverIban = document.getElementById("receiverIban");
      if (receiverIban) receiverIban.value = btn.dataset.iban;
    };
  });

  document.querySelectorAll(".delete-contact-btn").forEach(btn => {
    btn.onclick = async () => {
      const freshProfile = await getUserProfile(uid);
      const contacts = freshProfile.contacts || [];

      contacts.splice(Number(btn.dataset.index), 1);

      await updateUserProfile(uid, { contacts });
      await renderPayments(uid);
    };
  });

  const history = profile.history || [];

  if (paymentsHistory) {
    const transferHistory = history.filter(item =>
      item.includes("Virement")
    );

    paymentsHistory.innerHTML = transferHistory.length
      ? transferHistory.slice(0, 20).map(item => `<div class="list-item">${item}</div>`).join("")
      : `<div class="list-item">Aucun virement pour le moment.</div>`;
  }
}

async function sendTransfer(uid) {
  const sender = await getUserProfile(uid);
  if (!sender) return;

  const receiverIban = document.getElementById("receiverIban").value.trim();
  const amount = Number(document.getElementById("transferAmount").value);
  const reason = document.getElementById("transferReason").value.trim() || "Virement";

  if (!receiverIban) return alert("Entre un IBAN.");
  if (!amount || amount <= 0) return alert("Montant invalide.");

  sender.accounts = sender.accounts || { courant: 0, epargne: 0 };
  sender.history = sender.history || [];

  if ((sender.accounts.courant || 0) < amount) {
    return alert("Solde courant insuffisant.");
  }

  const allUsers = await getAllUsers();

  const receiver = allUsers.find(user => user.iban === receiverIban);

  if (!receiver) {
    return alert("Aucun utilisateur trouvé avec cet IBAN.");
  }

  if (receiver.uid === uid) {
    return alert("Tu ne peux pas te faire un virement à toi-même.");
  }

  const receiverProfile = await getUserProfile(receiver.uid);

  receiverProfile.accounts = receiverProfile.accounts || { courant: 0, epargne: 0 };
  receiverProfile.history = receiverProfile.history || [];

  sender.accounts.courant -= amount;
  receiverProfile.accounts.courant += amount;

  const senderName = sender.displayName || sender.username || sender.email;
  const receiverName = receiverProfile.displayName || receiverProfile.username || receiverProfile.email;

  sender.history.unshift(
    `Virement envoyé à ${receiverName} -${formatMoney(amount)} • ${reason}`
  );

  receiverProfile.history.unshift(
    `Virement reçu de ${senderName} +${formatMoney(amount)} • ${reason}`
  );

  addXp(sender, 10, "Virement");

  await updateUserProfile(uid, {
    accounts: sender.accounts,
    history: sender.history,
    xp: sender.xp
  });

  await updateUserProfile(receiver.uid, {
    accounts: receiverProfile.accounts,
    history: receiverProfile.history
  });

  document.getElementById("receiverIban").value = "";
  document.getElementById("transferAmount").value = "";
  document.getElementById("transferReason").value = "";

  alert("Virement envoyé.");
  await renderPayments(uid);
}

async function addContact(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const name = document.getElementById("contactName").value.trim();
  const iban = document.getElementById("contactIban").value.trim();

  if (!name) return alert("Entre un nom.");
  if (!iban) return alert("Entre un IBAN.");

  profile.contacts = profile.contacts || [];

  profile.contacts.push({
    name,
    iban
  });

  await updateUserProfile(uid, {
    contacts: profile.contacts
  });

  document.getElementById("contactName").value = "";
  document.getElementById("contactIban").value = "";

  await renderPayments(uid);
}

async function initPayments(user) {
  bindLogout();

  const profile = await getUserProfile(user.uid);
  updateAdminNavVisibility(profile);

  await renderPayments(user.uid);

  const sendTransferBtn = document.getElementById("sendTransferBtn");
  const addContactBtn = document.getElementById("addContactBtn");

  if (sendTransferBtn) {
    sendTransferBtn.onclick = async () => {
      await sendTransfer(user.uid);
    };
  }

  if (addContactBtn) {
    addContactBtn.onclick = async () => {
      await addContact(user.uid);
    };
  }
}


/////////////////////////////////////////////////////////////////////////
                             /// CARTES  ///
/////////////////////////////////////////////////////////////////////////

async function renderCards(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  profile.card = profile.card || {};

  let cardChanged = false;

  if (!profile.card.number) {
    profile.card.number = generateCardNumber();
    cardChanged = true;
  }

  if (!profile.card.cvv) {
    profile.card.cvv = generateCvv();
    cardChanged = true;
  }

  if (!profile.card.expiry) {
    profile.card.expiry = getExpiryFromCreatedAt(profile.createdAt);
    cardChanged = true;
  }

  if (cardChanged) {
    await updateUserProfile(uid, {
      card: profile.card
    });
  }

  updateAdminNavVisibility(profile);

  const cardType = profile.card?.type || "classic";
  const card = BANK_CARDS[cardType] || BANK_CARDS.classic;

  const bankCardVisual = document.getElementById("bankCardVisual");
  const cardOwner = document.getElementById("cardOwner");
  const cardTypeName = document.getElementById("cardTypeName");
  const cardStatus = document.getElementById("cardStatus");
  const cardsList = document.getElementById("cardsList");

  const pinCreateRow = document.getElementById("pinCreateRow");
  const cardInfoRow = document.getElementById("cardInfoRow");
  const pinInfoText = document.getElementById("pinInfoText");
  const cardNumber = document.getElementById("cardNumber");
  const cardExtraInfo = document.getElementById("cardExtraInfo");

  if (bankCardVisual) {
    bankCardVisual.className = `bank-card ${cardType}`;
  }

  if (cardOwner) {
    cardOwner.innerText = (profile.displayName || profile.username || "CLIENT").toUpperCase();
  }

  if (cardTypeName) {
    cardTypeName.innerText = card.name.toUpperCase();
  }

  if (cardStatus) {
    cardStatus.innerText = profile.card?.blocked ? "BLOQUÉE" : "ACTIVE";
  }

  if (cardsList) {
    cardsList.innerHTML = Object.entries(BANK_CARDS).map(([key, item]) => {
      const active = key === cardType;
      const canBuy = (profile.accounts?.courant || 0) >= item.price;

      return `
        <div class="card-option ${active ? "active" : ""}">
          <h3>${item.name}</h3>
          <p>Prix : <strong>${formatMoney(item.price)}</strong></p>
          <p class="small">Bonus épargne : +${item.savingBonus}%</p>
          <p class="small">Réduction frais : ${item.feeReduction}%</p>

          <button class="buy-card-btn" data-card-type="${key}" ${active || !canBuy ? "disabled" : ""}>
            ${active ? "Carte active" : canBuy ? "Choisir cette carte" : "Solde insuffisant"}
          </button>
        </div>
      `;
    }).join("");
  }

  const hasPin = !!profile.card?.pin;
  const revealed = !!profile.card?.revealed;

  if (pinCreateRow) pinCreateRow.style.display = hasPin ? "none" : "grid";
  if (cardInfoRow) cardInfoRow.style.display = hasPin ? "grid" : "none";

  if (pinInfoText) {
    pinInfoText.innerText = hasPin
      ? "Ton PIN est défini. Il est nécessaire pour voir les informations complètes."
      : "Définis ton code PIN à 4 chiffres. Il ne pourra plus être modifié ici.";
  }

  const last4 = (profile.card.number || "0000").slice(-4);

  cardNumber.innerText = revealed
    ? profile.card.number
    : `**** **** **** ${last4}`;

  cardExtraInfo.innerText = revealed
    ? `EXP : ${profile.card.expiry} • CVV : ${profile.card.cvv}`
    : "EXP : **/** • CVV : ***";

    document.querySelectorAll(".buy-card-btn").forEach(btn => {
      btn.onclick = async () => {
        await buyBankCard(uid, btn.dataset.cardType);
      };
    });
  }

async function buyBankCard(uid, cardType) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const card = BANK_CARDS[cardType];
  if (!card) return;

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.card = profile.card || { type: "classic", pin: null, blocked: false };
  profile.history = profile.history || [];

  if ((profile.accounts.courant || 0) < card.price) {
    alert("Solde courant insuffisant.");
    return;
  }

  profile.accounts.courant -= card.price;
  profile.card.type = cardType;

  profile.history.unshift(`Carte ${card.name} activée -${formatMoney(card.price)}`);
  addXp(profile, 15, "Carte bancaire");

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    card: profile.card,
    history: profile.history,
    xp: profile.xp
  });

  await renderCards(uid);
}

async function saveCardPin(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  profile.card = profile.card || { type: "classic", blocked: false };

  if (profile.card.pin) {
    alert("Un PIN est déjà défini. Pour le modifier, il faudra passer par une vérification par mail.");
    return;
  }

  const pin = document.getElementById("newPinInput").value.trim();

  if (!/^\d{4}$/.test(pin)) {
    alert("Le PIN doit contenir exactement 4 chiffres.");
    return;
  }

  profile.card.pin = pin;
  profile.card.revealed = false;

  profile.history = profile.history || [];
  profile.history.unshift("Code PIN de carte créé");

  await updateUserProfile(uid, {
    card: profile.card,
    history: profile.history
  });

  document.getElementById("newPinInput").value = "";
  alert("PIN créé.");
  await renderCards(uid);
}

async function showCardInfo(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  if (!profile.card?.pin) {
    alert("Tu dois d'abord créer un PIN.");
    return;
  }

  const enteredPin = prompt("Entre ton PIN :");

  if (!enteredPin) return;

  if (enteredPin !== profile.card.pin) {
    alert("PIN incorrect.");
    return;
  }

  profile.card.revealed = !profile.card.revealed;

  await updateUserProfile(uid, {
    card: profile.card
  });

  await renderCards(uid);
}

async function initCards(user) {
  bindLogout();

  await renderCards(user.uid);

  const savePinBtn = document.getElementById("savePinBtn");

  if (savePinBtn) {
    savePinBtn.onclick = async () => {
      await saveCardPin(user.uid);
    };
  }

  const showCardInfoBtn = document.getElementById("showCardInfoBtn");

  if (showCardInfoBtn) {
    showCardInfoBtn.onclick = async () => {
      await showCardInfo(user.uid);
    };
  }
}


/////////////////////////////////////////////////////////////////////////
                             /// ADMIN ///
/////////////////////////////////////////////////////////////////////////

async function renderAdmin(currentUid) {
  const currentProfile = await getUserProfile(currentUid);

  if (!currentProfile?.isAdmin) {
    window.location.href = "home.html";
    return;
  }

  updateAdminNavVisibility(currentProfile);

  const adminUsersList = document.getElementById("adminUsersList");
  if (!adminUsersList) return;

  const users = await getAllUsers();

  adminUsersList.innerHTML = users.map(user => {
    const history = user.history || [];
    const cardType = BANK_CARDS[user.card?.type || "classic"]?.name || "Classique";
    return `
      <div class="admin-user-card">
        <div class="admin-user-head">
          <div>
            <h3>${escapeHtml(user.displayName || user.username || "Utilisateur")}</h3>
            <p class="small">${escapeHtml(user.email || "")}</p>
          </div>
          <strong>${formatMoney(getUserTotalBalance(user))}</strong>
        </div>

        <div class="admin-info-grid">
          <p><strong>UID :</strong> ${escapeHtml(user.uid)}</p>
          <p><strong>Nom :</strong> ${escapeHtml(user.username || user.displayName || "")}</p>
          <p><strong>Email :</strong> ${escapeHtml(user.email || "")}</p>
          <p><strong>IBAN :</strong> ${escapeHtml(user.iban || "")}</p>
          <p><strong>PIN :</strong> ${escapeHtml(getCardPin(user))}</p>
          <p><strong>Carte :</strong> ${escapeHtml(cardType)}</p>
          <p><strong>Compte courant :</strong> ${formatMoney(user.accounts?.courant || 0)}</p>
          <p><strong>Épargne :</strong> ${formatMoney(user.accounts?.epargne || 0)}</p>
          <p><strong>XP :</strong> ${Number(user.xp || 0).toLocaleString("fr-FR")}</p>
          <p><strong>Admin :</strong> ${user.isAdmin ? "Oui" : "Non"}</p>
        </div>

        <div class="row">
          <input class="admin-money-input" data-uid="${user.uid}" type="number" placeholder="Montant">
          <button class="admin-add-money-btn" data-uid="${user.uid}">Ajouter</button>
          <button class="admin-remove-money-btn secondary" data-uid="${user.uid}">Enlever</button>
          <button class="admin-history-btn secondary" data-uid="${user.uid}">Historique</button>
        </div>

        <div
            id="admin-history-${user.uid}"
            class="admin-history-box"
            style="display:none;">
         </div>
      </div>
    `;
  }).join("");

  users.forEach(user => {
    renderPaginatedHistory(
      `admin-history-${user.uid}`,
      user.history || [],
      `adminHistory-${user.uid}`
    );
  });

  document.querySelectorAll(".admin-history-btn").forEach(btn => {
    btn.onclick = () => {
      const box = document.getElementById(`admin-history-${btn.dataset.uid}`);
      if (box) box.style.display = box.style.display === "none" ? "block" : "none";
    };
  });

  document.querySelectorAll(".admin-add-money-btn").forEach(btn => {
    btn.onclick = async () => {
      await adminChangeMoney(btn.dataset.uid, "add");
      await renderAdmin(currentUid);
    };
  });

  document.querySelectorAll(".admin-remove-money-btn").forEach(btn => {
    btn.onclick = async () => {
      await adminChangeMoney(btn.dataset.uid, "remove");
      await renderAdmin(currentUid);
    };
  });
}

/////////////////////////////////////////////////////////////////////////
                             /// PROFILE ///
/////////////////////////////////////////////////////////////////////////


function formatDate(timestamp) {
  if (!timestamp) return "Date inconnue";

  return new Date(timestamp).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
}

async function renderProfile(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  updateAdminNavVisibility(profile);

  const cardType = profile.card?.type || "classic";
  const card = BANK_CARDS[cardType] || BANK_CARDS.classic;
  const levelData = getLevelData(profile.xp || 0);

  document.getElementById("profileName").innerText =
    profile.displayName || profile.username || "Utilisateur";

  document.getElementById("profileEmail").innerText =
    profile.email || "";

  document.getElementById("profileCreatedAt").innerText =
    `Client depuis le ${formatDate(profile.createdAt)}`;

  document.getElementById("profileTotalBalance").innerText =
    formatMoney(getTotalBalance(profile));

  document.getElementById("profileLevel").innerText =
    `Niveau ${levelData.level}`;

  document.getElementById("profileXp").innerText =
    `${Math.floor(levelData.currentXp).toLocaleString("fr-FR")} / ${levelData.requiredXp.toLocaleString("fr-FR")} XP`;

  document.getElementById("profileXpBar").style.width =
    `${levelData.percent}%`;

  document.getElementById("profileIban").innerText =
    profile.iban || "Non défini";

  document.getElementById("profileCard").innerText =
    card.name;

  document.getElementById("profileCurrent").innerText =
    formatMoney(profile.accounts?.courant || 0);

  document.getElementById("profileSaving").innerText =
    formatMoney(profile.accounts?.epargne || 0);

  document.getElementById("profileSavingRate").innerText =
    `${getSavingRate(profile).toFixed(2)}% / an`;

  document.getElementById("profileAdvisor").textContent =
    `Conseiller : ${profile.advisor || "Rafaël Granero"}`;

  const history = profile.history || [];
  const profileHistory = document.getElementById("profileHistory");

  if (profileHistory) {
    renderPaginatedHistory("profileHistory", profile.history || [], "profileHistory");
  }}

async function initProfile(user) {
  bindLogout();
  await renderProfile(user.uid);
}

/////////////////////////////////////////////////////////////////////////
                             /// BOOT ///
/////////////////////////////////////////////////////////////////////////

watchAuth(async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  if (page === "home") {
    await initHome(user);
  }

  if (page === "payments") {
    await initPayments(user);
  }

  if (page === "cards") {
    await initCards(user);
  }
  if (page === "admin") {
    await initAdmin(user);
  }

  if (page === "profile") {
    await initProfile(user);
  }
});
