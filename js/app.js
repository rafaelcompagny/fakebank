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

function addTransaction(profile, label, amount, category = "general") {
  profile.transactions = profile.transactions || [];
  profile.history = profile.history || [];

  const tx = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    label,
    amount: Number(amount || 0),
    category,
    createdAt: Date.now(),
    monthKey: getMonthKey()
  };

  profile.transactions.unshift(tx);

  const sign = tx.amount >= 0 ? "+" : "-";
  profile.history.unshift(`${label} ${sign}${formatMoney(Math.abs(tx.amount))}`);

  return tx;
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

function getCreditScoreLabel(score = 500) {
  if (score >= 850) return "Excellent";
  if (score >= 700) return "Très bon";
  if (score >= 550) return "Correct";
  if (score >= 350) return "Fragile";
  return "Risque élevé";
}

function updateCreditScore(profile, amount) {
  profile.creditScore = Number(profile.creditScore || 500);
  profile.creditScore = Math.max(0, Math.min(1000, profile.creditScore + amount));
}

function getOverdraftLimit(profile) {
  const type = profile.card?.type || "classic";

  const limits = {
    classic: 0,
    green: 100,
    gold: 500,
    black: 1000,
    premium: 5000
  };

  return limits[type] || 0;
}

function canPayWithOverdraft(profile, amount) {
  const balance = profile.accounts?.courant || 0;
  const overdraft = getOverdraftLimit(profile);

  return balance + overdraft >= amount;
}

function isCardBlocked(profile) {
  return profile.cardBlocked || profile.card?.blocked;
}

function requireActiveCard(profile) {
  if (isCardBlocked(profile)) {
    alert("Carte bloquée. Opération refusée.");
    return false;
  }

  return true;
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
    addTransaction(profile, "Admin : ajout d'argent", amount, "admin");
  }

  if (mode === "remove") {
    if ((profile.accounts.courant || 0) < amount) {
      alert("Solde courant insuffisant.");
      return;
    }

    profile.accounts.courant -= amount;
    addTransaction(profile, "Admin : retrait d'argent", -amount, "admin");
  }

  await updateUserProfile(targetUid, {
    accounts: profile.accounts,
    transactions: profile.transactions,
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
    dailyFee: 0,
    savingBonus: 0,
    feeReduction: 0
  },
  green: {
    name: "Verte",
    price: 5,
    dailyFee: 5,
    savingBonus: 0.1,
    feeReduction: 0
  },
  gold: {
    name: "Gold",
    price: 15,
    dailyFee: 15,
    savingBonus: 0.25,
    feeReduction: 5
  },
  black: {
    name: "Black",
    price: 25,
    dailyFee: 25,
    savingBonus: 0.5,
    feeReduction: 10
  },
  premium: {
    name: "Premium",
    price: 1000,
    dailyFee: 1000,
    savingBonus: 1,
    feeReduction: 20
  }
};

const DAILY_BANK_FEE = 1.50; // frais bancaires de base / jour
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function applyDailyBankFees(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const now = Date.now();
  const last = profile.lastBankFeePayment || profile.createdAt || now;

  if (now - last < ONE_DAY_MS) return;

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.card = profile.card || { type: "classic" };
  profile.history = profile.history || [];
  profile.transactions = profile.transactions || [];

  const days = Math.floor((now - last) / ONE_DAY_MS);

  const cardType = profile.card.type || "classic";
  const card = BANK_CARDS[cardType] || BANK_CARDS.classic;

  const baseBankFees = DAILY_BANK_FEE * days;
  const cardFees = (card.dailyFee || 0) * days;

  const reduction = card.feeReduction || 0;
  const totalBeforeReduction = baseBankFees + cardFees;
  const totalFees = Math.round(totalBeforeReduction * (1 - reduction / 100) * 100) / 100;

  if (totalFees <= 0) {
    profile.lastBankFeePayment = now;
    await updateUserProfile(uid, {
      lastBankFeePayment: profile.lastBankFeePayment
    });
    return;
  }

  const currentBalance = profile.accounts.courant || 0;
  const paid = Math.min(currentBalance, totalFees);

  profile.accounts.courant = currentBalance - paid;
  profile.lastBankFeePayment = now;

  addTransaction(
    profile,
    `Frais bancaires journaliers (${days} jour${days > 1 ? "s" : ""})`,
    -paid,
    "bank_fees"
  );

  addNotification(
    profile,
    "Frais bancaires",
    `${formatMoney(paid)} ont été prélevés pour les frais bancaires.`,
    "warning"
  );

  if (paid < totalFees) {
    profile.history.unshift(`Frais impayés : ${formatMoney(totalFees - paid)}`);
  }

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    transactions: profile.transactions,
    notifications: profile.notifications,
    lastBankFeePayment: profile.lastBankFeePayment
  });
  if (now - last < ONE_DAY_MS) return null;
  return paid > 0
    ? `🏦 Frais bancaires prélevés : <strong>${formatMoney(paid)}</strong>`
    : null;
}

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
    addTransaction(profile, "Intérêts épargne", interest, "interest");
    addNotification(
      profile,
      "Intérêts reçus",
      `Tu as reçu ${formatMoney(interest)} d'intérêts sur ton compte épargne.`,
      "success"
    );
  }

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    transactions: profile.transactions,
    notifications: profile.notifications,
    lastInterestPayment: profile.lastInterestPayment
  });
  if (now - last < oneDayMs) return null;
  return interest > 0 ? `💰 Intérêts épargne reçus : <strong>${formatMoney(interest)}</strong>` : null;
  
}

async function renderHome(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  updateAdminNavVisibility(profile);
  updateBusinessNavVisibility(profile);

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
  const dailyFeesText = document.getElementById("dailyFeesText");

  if (totalBalance) totalBalance.innerText = formatMoney(getTotalBalance(profile));
  if (currentBalance) currentBalance.innerText = formatMoney(accounts.courant || 0);
  if (savingBalance) savingBalance.innerText = formatMoney(accounts.epargne || 0);
  if (welcomeText) welcomeText.innerText = `Bienvenue ${profile.displayName || profile.username || ""}`;
  if (ibanText) ibanText.innerText = `IBAN : ${profile.iban || "Non défini"}`;
  if (savingRateText) savingRateText.innerText = `Taux épargne : ${getSavingRate(profile).toFixed(2)}% / jour`;

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

  if (dailyFeesText) {
    const card = BANK_CARDS[profile.card?.type || "classic"] || BANK_CARDS.classic;
    const totalFees = (DAILY_BANK_FEE + (card.dailyFee || 0)) * (1 - (card.feeReduction || 0) / 100);

    dailyFeesText.innerText = `Frais journaliers estimés : ${formatMoney(totalFees)} / jour`;
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
    addTransaction(profile, "Transfert vers épargne", -amount, "saving");
    addXp(profile, 5, "Épargne");
  }

  if (direction === "withdraw") {
    if ((profile.accounts.epargne || 0) < amount) return alert("Solde épargne insuffisant.");

    profile.accounts.epargne -= amount;
    profile.accounts.courant += amount;
    addTransaction(profile, "Retrait depuis épargne", amount, "saving");
    addXp(profile, 5, "Épargne");
  }

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    transactions: profile.transactions,
    history: profile.history,
    xp: profile.xp
  });

  document.getElementById("savingAmount").value = "";
  await renderHome(uid);
}

async function initHome(user) {
  bindLogout();
  bindNotifications(user.uid);

  const summaryLines = [];

  const interestMsg = await applySavingInterest(user.uid);
  if (interestMsg) summaryLines.push(interestMsg);

  const realEstateMsg = await applyRealEstateIncome(user.uid);
  if (realEstateMsg) summaryLines.push(realEstateMsg);

  const bankFeesMsg = await applyDailyBankFees(user.uid);
  if (bankFeesMsg) summaryLines.push(bankFeesMsg);

  const loanMsg = await applyLoanPayments(user.uid);
  if (loanMsg) summaryLines.push(loanMsg);

  await renderHome(user.uid);

  const profile = await getUserProfile(user.uid);
  renderNotificationDot(profile);

  const insuranceMsg = await applyInsuranceFees(user.uid);
  if (insuranceMsg) summaryLines.push(insuranceMsg);

  await showDailySummaryPopup(summaryLines);

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
  updateBusinessNavVisibility(profile);

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

  addTransaction(
    sender,
    `Virement envoyé à ${receiverName} • ${reason}`,
    -amount,
    "transfer"
  );

  addNotification(
    sender,
    "Virement envoyé",
    `Tu as envoyé ${formatMoney(amount)} à ${receiverName}.`,
    "info"
  );

  addTransaction(
    receiverProfile,
    `Virement reçu de ${senderName} • ${reason}`,
    amount,
    "transfer"
  );

  addNotification(
    receiverProfile,
    "Virement reçu",
    `Tu as reçu ${formatMoney(amount)} de ${senderName}.`,
    "success"
  );

  addXp(sender, 10, "Virement");

  await updateUserProfile(uid, {
    accounts: sender.accounts,
    transactions: sender.transactions,
    history: sender.history,
    notifications: sender.notifications,
    xp: sender.xp
  });

  await updateUserProfile(receiver.uid, {
    accounts: receiverProfile.accounts,
    transactions: receiverProfile.transactions,
    transactions: receiverProfile.transactions,
    notifications: receiverProfile.notifications,
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
  bindNotifications(user.uid);

  const profile = await getUserProfile(user.uid);
  updateAdminNavVisibility(profile);
  renderNotificationDot(profile);

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
  updateBusinessNavVisibility(profile);

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

  document.getElementById("cardStatus").innerHTML =
    profile.cardBlocked
      ? "🔒 Carte bloquée"
      : "🟢 Carte active";

  if (cardsList) {
    cardsList.innerHTML = Object.entries(BANK_CARDS).map(([key, item]) => {
      const active = key === cardType;
      const canBuy = (profile.accounts?.courant || 0) >= item.price;

      return `
        <div class="card-option ${active ? "active" : ""}">
          <h3>${item.name}</h3>
          <p>Prix : <strong>${formatMoney(item.price)}</strong></p>
          <p class="small">Frais carte : ${formatMoney(item.dailyFee || 0)} / jour</p>
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

  const toggleCardBtn =
    document.getElementById("toggleCardBtn");

  if (toggleCardBtn) {

    toggleCardBtn.innerText =
      profile.cardBlocked
        ? "Réactiver la carte"
        : "Désactiver la carte";

    toggleCardBtn.classList.toggle(
      "danger",
      !profile.cardBlocked
    );

    toggleCardBtn.onclick = async () => {
      await toggleCard(uid);
    };
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


async function toggleCard(uid) {

  const profile = await getUserProfile(uid);
  if (!profile) return;

  const blocked = !profile.cardBlocked;

  profile.cardBlocked = blocked;
  addNotification(
    profile,
    "Carte bloquée",
    "Votre carte bancaire a été désactivée.",
    "warning"
  );

  addTransaction(
    profile,
    blocked
      ? "Carte désactivée"
      : "Carte réactivée",
    0,
    "card_security"
  );

  addNotification(
    profile,
    "Carte réactivée",
    "Votre carte bancaire est de nouveau active.",
    "success"
  );

  await updateUserProfile(uid, {
    cardBlocked: profile.cardBlocked,
    history: profile.history,
    notifications: profile.notifications,
    transactions: profile.transactions
  });

  await renderCards(uid);
}

async function buyBankCard(uid, cardType) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  if (!requireActiveCard(profile)) return;

  const card = BANK_CARDS[cardType];
  if (!card) return;

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.card = profile.card || { type: "classic", pin: null, blocked: false };
  profile.history = profile.history || [];

  if (!canPayWithOverdraft(profile, card.price)) {
    alert("Solde insuffisant, même avec le découvert autorisé.");
    return;
  }

  profile.accounts.courant -= card.price;
  profile.card.type = cardType;

  addTransaction(profile, `Carte ${card.name} activée`, -card.price, "card");
  addXp(profile, 15, "Carte bancaire");

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    card: profile.card,
    transactions: profile.transactions,
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
  profile.card.pinAttempts = 0;
  profile.card.revealed = false;

  profile.history = profile.history || [];
  profile.history.unshift("Code PIN de carte créé");

  await updateUserProfile(uid, {
    card: profile.card,
    transactions: profile.transactions,
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
    profile.card.pinAttempts = (profile.card.pinAttempts || 0) + 1;

    if (profile.card.pinAttempts >= 3) {
      profile.cardBlocked = true;
      profile.card.blocked = true;

      addTransaction(profile, "Carte bloquée après 3 mauvais PIN", 0, "security");
      addNotification(profile, "Carte bloquée", "Votre carte a été bloquée après 3 mauvais PIN.", "error");

      await updateUserProfile(uid, {
        card: profile.card,
        cardBlocked: profile.cardBlocked,
        history: profile.history,
        transactions: profile.transactions,
        notifications: profile.notifications
      });

      alert("Carte bloquée après 3 mauvais PIN.");
      await renderCards(uid);
      return;
    }

    await updateUserProfile(uid, {
      card: profile.card
    });

    alert(`PIN incorrect. Tentative ${profile.card.pinAttempts}/3.`);
    return;
  }
  profile.card.pinAttempts = 0;
  profile.card.revealed = !profile.card.revealed;

  await updateUserProfile(uid, {
    card: profile.card
  });

  await renderCards(uid);
}

async function initCards(user) {
  bindLogout();
  bindNotifications(user.uid);

  await renderCards(user.uid);
  const profile = await getUserProfile(user.uid);
  renderNotificationDot(profile);

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
  updateBusinessNavVisibility(currentProfile);

  const adminUsersList = document.getElementById("adminUsersList");
  if (!adminUsersList) return;

  const users = await getAllUsers();
  renderAdminAdvisorMessages(users, currentUid);

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

function renderAdminAdvisorMessages(users, currentUid) {
  const box = document.getElementById("adminAdvisorMessages");
  if (!box) return;

  const messages = [];

  users.forEach(user => {
    (user.advisorMessages || []).forEach((msg, index) => {
      if (msg.from === "user") {
        messages.push({
          user,
          msg,
          index
        });
      }
    });
  });

  messages.sort((a, b) => b.msg.createdAt - a.msg.createdAt);

  box.innerHTML = messages.length
    ? messages.map(item => `
      <div class="admin-user-card">
        <h3>${escapeHtml(item.user.displayName || item.user.username || "Utilisateur")}</h3>
        <p class="small">${escapeHtml(item.user.email || "")}</p>
        <p><strong>Type :</strong> ${escapeHtml(item.msg.topic || "Autre")}</p><br>
        <p>${escapeHtml(item.msg.text)}</p> <br>
        <p class="small">${formatNotificationDate(item.msg.createdAt)}</p><br>

        <textarea
          class="admin-advisor-reply"
          data-uid="${item.user.uid}"
          placeholder="Répondre au client..."
        ></textarea>

        <button class="send-admin-advisor-reply-btn" data-uid="${item.user.uid}">
          Envoyer la réponse
        </button>
      </div>
    `).join("")
    : `<div class="list-item">Aucun message conseiller.</div>`;

  document.querySelectorAll(".send-admin-advisor-reply-btn").forEach(btn => {
    btn.onclick = async () => {
      const uid = btn.dataset.uid;
      const textarea = document.querySelector(`.admin-advisor-reply[data-uid="${uid}"]`);
      const text = textarea.value.trim();

      if (!text) {
        alert("Écris une réponse.");
        return;
      }

      await sendAdminAdvisorReply(uid, text);
      await renderAdmin(currentUid);
    };
  });
}

async function sendAdminAdvisorReply(targetUid, text) {
  const profile = await getUserProfile(targetUid);
  if (!profile) return;

  profile.advisorMessages = profile.advisorMessages || [];
  profile.notifications = profile.notifications || [];

  profile.advisorMessages.unshift({
    from: "bank",
    topic: "admin_reply",
    text,
    createdAt: Date.now()
  });

  profile.advisorMessages = profile.advisorMessages.slice(0, 30);

  addNotification(
    profile,
    "Réponse conseiller",
    "Votre conseiller a répondu à votre message.",
    "info"
  );

  await updateUserProfile(targetUid, {
    advisorMessages: profile.advisorMessages,
    notifications: profile.notifications
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
  updateBusinessNavVisibility(profile);

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
    `${getSavingRate(profile).toFixed(2)}% / jour`;

  document.getElementById("profileAdvisor").textContent =
    `Conseiller : ${profile.advisor || "Rafaël Granero"}`;

  const agency = profile.agency || {
    advisor: profile.advisor || "Camille Martin",
    phone: "05 56 00 00 00",
    email: "conseiller@cryptex-bank.fr",
    name: "Cryptex Bank Bordeaux",
    address: "10 cours de l’Intendance, 33000 Bordeaux",
    hours: "Lun - Ven : 9h00 - 18h00"
  };

  document.getElementById("agencyAdvisor").innerText = agency.advisor;
  document.getElementById("agencyPhone").innerText = agency.phone;
  document.getElementById("agencyEmail").innerText = agency.email;
  document.getElementById("agencyName").innerText = agency.name;
  document.getElementById("agencyAddress").innerText = agency.address;
  document.getElementById("agencyHours").innerText = agency.hours;
}

async function initProfile(user) {
  bindLogout();
  bindNotifications(user.uid);
  await renderProfile(user.uid);
  const profile = await getUserProfile(user.uid);
  renderNotificationDot(profile);
}


/////////////////////////////////////////////////////////////////////////
                             /// MARKET ///
/////////////////////////////////////////////////////////////////////////

const MARKET_ASSETS = {
  crypto: [
    { id: "BTC", name: "Bitcoin", basePrice: 65000, volatility: 0.06 },
    { id: "ETH", name: "Ethereum", basePrice: 3200, volatility: 0.07 },
    { id: "SOL", name: "Solana", basePrice: 140, volatility: 0.1 },
    { id: "XRP", name: "XRP", basePrice: 0.55, volatility: 0.12 }
  ],

  stocks: [
    { id: "RACORP", name: "Rafael Compagny", basePrice: 450, volatility: 0.045 },
    { id: "AAPL", name: "Apple", basePrice: 180, volatility: 0.025 },
    { id: "MSFT", name: "Microsoft", basePrice: 420, volatility: 0.02 },
    { id: "NVDA", name: "Nvidia", basePrice: 900, volatility: 0.045 },
    { id: "TSLA", name: "Tesla", basePrice: 250, volatility: 0.05 },
    { id: "AMZN", name: "Amazon", basePrice: 180, volatility: 0.03 }
  ]
};

const CRYPTOS = MARKET_ASSETS.crypto;
const STOCKS = MARKET_ASSETS.stocks;

function getAllMarketAssets() {
  return [...MARKET_ASSETS.crypto, ...MARKET_ASSETS.stocks];
}

function ensureMarketData(profile) {
  profile.marketPrices = profile.marketPrices || {};
  profile.priceHistory = profile.priceHistory || {};

  getAllMarketAssets().forEach(asset => {
    if (!profile.marketPrices[asset.id]) {
      profile.marketPrices[asset.id] = asset.basePrice;
    }

    if (!profile.priceHistory[asset.id]) {
      profile.priceHistory[asset.id] = [
        {
          t: Date.now(),
          price: asset.basePrice
        }
      ];
    }
  });
}

function updateMarketPrices(profile) {
  ensureMarketData(profile);

  getAllMarketAssets().forEach(asset => {
    const oldPrice = profile.marketPrices[asset.id] || asset.basePrice;

    const randomVariation = (Math.random() * 2 - 1) * asset.volatility;
    const trend = 0.002;

    let newPrice = oldPrice * (1 + randomVariation + trend);

    newPrice = Math.max(asset.basePrice * 0.2, newPrice);
    newPrice = Math.min(asset.basePrice * 5, newPrice);

    profile.marketPrices[asset.id] = newPrice;

    profile.priceHistory[asset.id].push({
      t: Date.now(),
      price: newPrice
    });

    profile.priceHistory[asset.id] = profile.priceHistory[asset.id].slice(-30);
  });
}

function getAssetCurrentPrice(profile, asset) {
  ensureMarketData(profile);
  return profile.marketPrices[asset.id] || asset.basePrice;
}

const REAL_ESTATE = [
  { id: "studio", name: "Studio", price: 90000, incomePerDay: 35 },
  { id: "apartment", name: "Appartement", price: 220000, incomePerDay: 95 },
  { id: "house", name: "Maison", price: 380000, incomePerDay: 160 },
  { id: "building", name: "Immeuble", price: 1500000, incomePerDay: 850 },
  { id: "hotel", name: "Hôtel", price: 5000000, incomePerDay: 3200 }
];

function bindMarketTabs() {
  const tabs = document.querySelectorAll(".market-tab");

  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      document.querySelectorAll(".market-section").forEach(section => {
        section.classList.remove("active");
      });

      document.getElementById(`${tab.dataset.tab}Section`)?.classList.add("active");
    };
  });
}

async function renderMarkets(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  updateAdminNavVisibility(profile);
  updateBusinessNavVisibility(profile);

  profile.crypto = profile.crypto || {};
  profile.stocks = profile.stocks || {};
  profile.realEstate = profile.realEstate || {};

  ensureMarketData(profile);

  const now = Date.now();
  const lastUpdate = profile.lastMarketUpdate || 0;

  if (now - lastUpdate > 5 * 1000) {
    updateMarketPrices(profile);
    profile.lastMarketUpdate = now;

    await updateUserProfile(uid, {
      marketPrices: profile.marketPrices,
      priceHistory: profile.priceHistory,
      lastMarketUpdate: profile.lastMarketUpdate
    });
  }

  await renderMarketAssets(uid, "cryptoList", CRYPTOS, "crypto");
  await renderMarketAssets(uid, "stocksList", STOCKS, "stocks");
  await renderRealEstateMarket(uid);

  setTimeout(() => {
    renderMiniMarketCharts(profile);
  }, 50);

  renderPaginatedHistory("marketHistory", profile.history || [], "marketHistory");
}



async function renderMarketAssets(uid, containerId, assets, type) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const container = document.getElementById(containerId);
  if (!container) return;

  const wallet = profile[type] || {};
  const balance = profile.accounts?.courant || 0;

  container.innerHTML = assets.map(asset => {
    const owned = wallet[asset.id]?.owned || 0;
    ensureMarketData(profile);
    const currentPrice = getAssetCurrentPrice(profile, asset);
    const value = owned * currentPrice;
    const history = profile.priceHistory?.[asset.id] || [];
    const oldPrice = history.length > 1 ? history[history.length - 2].price : currentPrice;
    const changePercent = ((currentPrice - oldPrice) / oldPrice) * 100;

    return `
      <div class="market-item">
        <h3>${asset.name}</h3>
        <p class="market-price">
          ${formatMoney(currentPrice)}
          <span class="${changePercent >= 0 ? "income-text" : "expense-text"}">
            ${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%
          </span>
        </p>

        <canvas class="mini-market-chart" data-asset-id="${asset.id}"></canvas>
        
        <p class="market-owned">Possédé : ${owned.toFixed(6)}</p>
        <p class="small">Valeur : ${formatMoney(value)}</p>

        <input class="market-buy-input" data-type="${type}" data-id="${asset.id}" type="number" placeholder="Montant à investir">

        <div class="row" style="margin-top:8px;">
          <button class="market-buy-btn" data-type="${type}" data-id="${asset.id}">Acheter</button>
          <button class="market-sell-btn secondary" data-type="${type}" data-id="${asset.id}" ${owned <= 0 ? "disabled" : ""}>Vendre tout</button>
        </div>
      </div>
    `;
  }).join("");

  document.querySelectorAll(".market-buy-btn").forEach(btn => {
    btn.onclick = async () => {
      await buyMarketAsset(uid, btn.dataset.type, btn.dataset.id);
    };
  });

  document.querySelectorAll(".market-sell-btn").forEach(btn => {
    btn.onclick = async () => {
      await sellMarketAsset(uid, btn.dataset.type, btn.dataset.id);
    };
  });
}

async function buyMarketAsset(uid, type, assetId) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  if (!requireActiveCard(profile)) return;

  const assets = type === "crypto" ? CRYPTOS : STOCKS;
  const asset = assets.find(a => a.id === assetId);
  if (!asset) return;

  const input = document.querySelector(`.market-buy-input[data-type="${type}"][data-id="${assetId}"]`);
  const amount = Number(input?.value || 0);

  if (!amount || amount <= 0) return alert("Montant invalide.");

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile[type] = profile[type] || {};
  profile.history = profile.history || [];

  if (!canPayWithOverdraft(profile, amount)) {
    return alert("Solde insuffisant, même avec le découvert autorisé.");
  }

  ensureMarketData(profile);
  const currentPrice = getAssetCurrentPrice(profile, asset);
  const quantity = amount / currentPrice;

  profile.accounts.courant -= amount;

  profile[type][asset.id] = profile[type][asset.id] || {
    owned: 0,
    avgBuyPrice: 0
  };

  const oldOwned = profile[type][asset.id].owned || 0;
  const oldCost = oldOwned * (profile[type][asset.id].avgBuyPrice || 0);

  profile[type][asset.id].owned = oldOwned + quantity;
  profile[type][asset.id].avgBuyPrice = (oldCost + amount) / profile[type][asset.id].owned;

  addTransaction(
    profile,
    `Achat ${asset.name} (${quantity.toFixed(6)})`,
    -amount,
    type
  );
  addNotification(
    profile,
    "Investissement réalisé",
    `Achat de ${asset.name} pour ${formatMoney(amount)}.`,
    "success"
  );
  addXp(profile, type === "crypto" ? 10 : 12, type === "crypto" ? "Crypto" : "Action");

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    [type]: profile[type],
    transactions: profile.transactions,
    history: profile.history,
    notifications: profile.notifications,
    xp: profile.xp
  });

  await renderMarkets(uid);
}

async function sellMarketAsset(uid, type, assetId) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const assets = type === "crypto" ? CRYPTOS : STOCKS;
  const asset = assets.find(a => a.id === assetId);
  if (!asset) return;

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile[type] = profile[type] || {};
  profile.history = profile.history || [];

  const owned = profile[type][asset.id]?.owned || 0;
  if (owned <= 0) return alert("Tu ne possèdes rien à vendre.");

  ensureMarketData(profile);
  const currentPrice = getAssetCurrentPrice(profile, asset);

  const value = owned * currentPrice;
  const cost = owned * (profile[type][asset.id].avgBuyPrice || currentPrice);
  const pnl = value - cost;

  profile.accounts.courant += value;
  profile[type][asset.id].owned = 0;
  profile[type][asset.id].avgBuyPrice = 0;

  addTransaction(
    profile,
    `Vente ${asset.name} • ${pnl >= 0 ? "Gain" : "Perte"} ${formatMoney(pnl)}`,
    value,
    type
  );
  addNotification(
    profile,
    "Vente réalisée",
    `Vente de ${asset.name} pour ${formatMoney(value)}.`,
    "info"
  );
  addXp(profile, 8, "Vente marché");

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    [type]: profile[type],
    transactions: profile.transactions,
    notifications: profile.notifications,
    history: profile.history,
    xp: profile.xp
  });

  await renderMarkets(uid);
}

function renderMiniMarketCharts(profile) {
  document.querySelectorAll(".mini-market-chart").forEach(canvas => {
    const assetId = canvas.dataset.assetId;
    const history = profile.priceHistory?.[assetId] || [];

    if (!history.length) return;

    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const width = canvas.width = rect.width || 220;
    const height = canvas.height = 80;

    ctx.clearRect(0, 0, width, height);

    const prices = history.map(p => p.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);

    ctx.beginPath();

    prices.forEach((price, index) => {
      const x = (index / Math.max(1, prices.length - 1)) * width;
      const y = height - ((price - min) / Math.max(1, max - min)) * height;

      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.lineWidth = 3;
    ctx.strokeStyle = prices[prices.length - 1] >= prices[0] ? "#43e97b" : "#ff4d6d";
    ctx.stroke();
  });
}

async function renderRealEstateMarket(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const container = document.getElementById("realEstateList");
  if (!container) return;

  profile.realEstate = profile.realEstate || {};
  const balance = profile.accounts?.courant || 0;

  container.innerHTML = REAL_ESTATE.map(property => {
    const owned = profile.realEstate[property.id] || 0;
    const maxOwned = 2;
    const canBuy = balance >= property.price && owned < maxOwned;

    return `
      <div class="market-item">
        <h3>${property.name}</h3>
        <p class="market-price">${formatMoney(property.price)}</p>
        <p class="market-owned">Possédé : ${owned}</p>
        <p class="small">Revenu estimé : ${formatMoney(property.incomePerDay)} / jour</p>
        <p class="small">Revenu total : ${formatMoney(owned * property.incomePerDay)} / jour</p>

        <button class="realestate-buy-btn" data-id="${property.id}" ${canBuy ? "" : "disabled"}>
          ${
            owned >= maxOwned
              ? "Maximum atteint"
              : balance >= property.price
                ? "Acheter"
                : "Solde insuffisant"
          }
        </button>
        <button class="realestate-sell-btn secondary" data-id="${property.id}" ${owned <= 0 ? "disabled" : ""}>
          Vendre 1 bien (${formatMoney(property.price * 0.9)})
        </button>
      </div>
    `;
  }).join("");

  document.querySelectorAll(".realestate-buy-btn").forEach(btn => {
    btn.onclick = async () => {
      await buyRealEstate(uid, btn.dataset.id);
    };
  });
  document.querySelectorAll(".realestate-sell-btn").forEach(btn => {
    btn.onclick = async () => {
      await sellRealEstate(uid, btn.dataset.id);
    };
  });
}

async function buyRealEstate(uid, propertyId) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  if (!requireActiveCard(profile)) return;

  const property = REAL_ESTATE.find(p => p.id === propertyId);
  if (!property) return;

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.realEstate = profile.realEstate || {};
  profile.history = profile.history || [];

  const owned = profile.realEstate[property.id] || 0;

  if (owned >= 2) {
    alert("Tu possèdes déjà le maximum pour ce type de bien.");
    return;
  }

  if (!canPayWithOverdraft(profile, property.price)) {
    return alert("Solde insuffisant, même avec le découvert autorisé.");
  }

  profile.accounts.courant -= property.price;
  profile.realEstate[property.id] = (profile.realEstate[property.id] || 0) + 1;

  addTransaction(
    profile,
    `Achat immobilier : ${property.name}`,
    -property.price,
    "realestate"
  );
  addXp(profile, 25, "Immobilier");

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    realEstate: profile.realEstate,
    transactions: profile.transactions,
    history: profile.history,
    xp: profile.xp
  });

  await renderMarkets(uid);
}

async function sellRealEstate(uid, propertyId) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const property = REAL_ESTATE.find(p => p.id === propertyId);
  if (!property) return;

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.realEstate = profile.realEstate || {};
  profile.history = profile.history || [];

  const owned = profile.realEstate[property.id] || 0;

  if (owned <= 0) {
    alert("Tu ne possèdes pas ce bien.");
    return;
  }

  const sellPrice = Math.round(property.price * 0.9);

  profile.realEstate[property.id] = owned - 1;
  profile.accounts.courant += sellPrice;

  addTransaction(
    profile,
    `Vente immobilier : ${property.name}`,
    sellPrice,
    "realestate"
  );

  addXp(profile, 10, "Vente immobilier");

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    realEstate: profile.realEstate,
    history: profile.history,
    transactions: profile.transactions,
    xp: profile.xp
  });

  await renderMarkets(uid);
}

async function applyRealEstateIncome(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const now = Date.now();
  const last = profile.lastRealEstateIncome || now;
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (now - last < oneDayMs) return;

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.realEstate = profile.realEstate || {};

  let dailyIncome = 0;

  REAL_ESTATE.forEach(property => {
    const owned = profile.realEstate[property.id] || 0;
    dailyIncome += owned * property.incomePerDay;
  });

  profile.lastRealEstateIncome = now;

  if (dailyIncome > 0) {
    profile.accounts.courant += dailyIncome;
    addTransaction(profile, "Revenus immobiliers journaliers", dailyIncome, "realestate_income");
    addNotification(
      profile,
      "Revenus immobiliers",
      `Tes biens ont généré ${formatMoney(dailyIncome)} aujourd'hui.`,
      "success"
    );
  }

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    transactions: profile.transactions,
    notifications: profile.notifications,
    lastRealEstateIncome: profile.lastRealEstateIncome
  });

  if (now - last < oneDayMs) return null;
  return dailyIncome > 0
  ? `🏠 Revenus immobiliers reçus : <strong>${formatMoney(dailyIncome)}</strong>`
  : null;

}

/////////////////////////////////////////////////////////////////////////
                             /// ENTREPRISE ///
/////////////////////////////////////////////////////////////////////////

let businessChart = null;

function getMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthLabel(monthKey) {
  const [year, month] = monthKey.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);

  return date.toLocaleDateString("fr-FR", {
    month: "short",
    year: "numeric"
  });
}

function getLastMonths(count = 6) {
  const months = [];
  const now = new Date();

  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(getMonthKey(date));
  }

  return months;
}

function detectTransactionAmount(line) {
  const match = String(line).match(/([+-])\s?([\d\s.,]+)\s?€/);
  if (!match) return 0;

  const sign = match[1];
  const value = Number(match[2].replace(/\s/g, "").replace(",", "."));

  return sign === "+" ? value : -value;
}

function buildBusinessStats(profile) {
  const months = getLastMonths(6);

  const stats = {};
  months.forEach(month => {
    stats[month] = {
      income: 0,
      expense: 0
    };
  });

  const transactions = profile.transactions || [];

  transactions.forEach(tx => {
    const month = tx.monthKey || getMonthKey(new Date(tx.createdAt || Date.now()));
    if (!stats[month]) return;

    const amount = Number(tx.amount || 0);

    if (amount > 0) stats[month].income += amount;
    if (amount < 0) stats[month].expense += Math.abs(amount);
  });

  return months.map(month => ({
    month,
    label: getMonthLabel(month),
    income: stats[month].income,
    expense: stats[month].expense
  }));
}

function renderBusinessChart(data) {
  const canvas = document.getElementById("businessChart");
  if (!canvas || typeof Chart === "undefined") return;

  if (businessChart) {
    businessChart.destroy();
  }

  businessChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: data.map(row => row.label),
      datasets: [
        {
          label: "Revenus",
          data: data.map(row => row.income),
          borderWidth: 3,
          tension: 0.35
        },
        {
          label: "Dépenses",
          data: data.map(row => row.expense),
          borderWidth: 3,
          tension: 0.35
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          display: true
        }
      },
      scales: {
        y: {
          beginAtZero: true
        }
      }
    }
  });
}

async function renderBusiness(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  if (!profile.isBusiness) {
    alert("Cette page est réservée aux comptes entreprise.");
    window.location.href = "home.html";
    return;
  }

updateBusinessNavVisibility(profile);

  updateAdminNavVisibility(profile);
  updateBusinessNavVisibility(profile);

  const data = buildBusinessStats(profile);
  const currentMonth = data[data.length - 1];

  const monthlyIncome = document.getElementById("monthlyIncome");
  const monthlyExpense = document.getElementById("monthlyExpense");
  const businessMonthlyList = document.getElementById("businessMonthlyList");

  if (monthlyIncome) monthlyIncome.innerText = formatMoney(currentMonth.income);
  if (monthlyExpense) monthlyExpense.innerText = formatMoney(currentMonth.expense);

  if (businessMonthlyList) {
    businessMonthlyList.innerHTML = data.map(row => `
      <div class="list-item business-month-row">
        <strong>${row.label}</strong>
        <span class="income-text">+${formatMoney(row.income)}</span>
        <span class="expense-text">-${formatMoney(row.expense)}</span>
      </div>
    `).join("");
  }

  //renderBusinessChart(data);
}

async function initBusiness(user) {
  bindLogout();
  bindNotifications(user.uid);
  await renderBusiness(user.uid);
  const profile = await getUserProfile(user.uid);
  renderNotificationDot(profile);
}

function updateBusinessNavVisibility(profile) {
  const businessNavLink = document.getElementById("businessNavLink");
  if (businessNavLink) {
    businessNavLink.style.display = profile?.isBusiness ? "flex" : "none";
  }
}


/////////////////////////////////////////////////////////////////////////
                             /// BANK ///
/////////////////////////////////////////////////////////////////////////


const LOAN_TYPES = {
  student: {
    name: "Prêt étudiant",
    rate: 1.5,
    max: 15000
  },

  auto: {
    name: "Prêt auto",
    rate: 3,
    max: 50000
  },

  realestate: {
    name: "Prêt immobilier",
    rate: 2,
    max: 500000
  },

  consumer: {
    name: "Crédit consommation",
    rate: 6,
    max: 10000
  },

  business: {
    name: "Prêt professionnel",
    rate: 1.8,
    max: 2000000,
    businessOnly: true
  }
};

function calculateMonthlyPayment(amount, rate, durationMonths) {

  const monthlyRate = rate / 100 / 12;

  if (monthlyRate === 0) {
    return amount / durationMonths;
  }

  return (
    amount *
    monthlyRate *
    Math.pow(1 + monthlyRate, durationMonths)
  ) /
  (
    Math.pow(1 + monthlyRate, durationMonths) - 1
  );
}

async function takeLoan(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  if (!requireActiveCard(profile)) return;

  const type = document.getElementById("selectedLoanType").value;
  const amount = Number(document.getElementById("loanAmount").value);
  const duration = Number(document.getElementById("loanDuration").value);
  const insurance = document.getElementById("loanInsurance")?.checked || false;

  const config = LOAN_TYPES[type];

  if (config.businessOnly && !profile.isBusiness) {
    alert("Ce prêt est réservé aux comptes entreprise.");
    return;
  }

  if (!config) return;

  if (!amount || amount <= 0 || amount > config.max) {
    alert(`Montant invalide. Maximum : ${formatMoney(config.max)}`);
    return;
  }

  if (!duration || duration < 6) {
    alert("Durée invalide. Minimum : 6 mois.");
    return;
  }

  profile.creditScore = Number(profile.creditScore || 500);

  if (profile.creditScore < 300) {
    alert("Demande refusée : score bancaire trop faible.");
    addTransaction(profile, `Demande refusée : ${config.name}`, 0, "loan_refused");
    updateCreditScore(profile, -5);

    await updateUserProfile(uid, {
      creditScore: profile.creditScore,
      history: profile.history,
      transactions: profile.transactions
    });

    await renderBank(uid);
    addNotification(
      profile,
      "Prêt refusé",
      "Votre score bancaire est insuffisant.",
      "error"
    );
    return;
  }

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.loans = profile.loans || [];

  const finalRate = config.rate + (insurance ? 0.3 : 0);
  const monthlyPayment = calculateMonthlyPayment(amount, finalRate, duration);

  const loan = {
    id: crypto.randomUUID(),
    type,
    amount,
    remainingAmount: amount,
    durationMonths: duration,
    monthlyPayment,
    rate: finalRate,
    insurance,
    createdAt: Date.now(),
    lastPayment: Date.now()
  };

  profile.loans.push(loan);
  profile.accounts.courant += amount;
    addNotification(
    profile,
    "Prêt accepté",
    `${config.name} de ${formatMoney(amount)} accordé.`,
    "success"
  );

  addTransaction(
    profile,
    `${config.name}${insurance ? " avec assurance" : ""}`,
    amount,
    "loan"
  );

  addXp(profile, 15, "Prêt bancaire");
  updateCreditScore(profile, 5);

  await updateUserProfile(uid, {
    loans: profile.loans,
    accounts: profile.accounts,
    history: profile.history,
    transactions: profile.transactions,
    xp: profile.xp,
    notifications: profile.notifications,
    creditScore: profile.creditScore
  });

  alert("Prêt accepté et versé sur le compte courant.");
  await renderBank(uid);
}

function updateLoanSimulation() {
  const type = document.getElementById("selectedLoanType")?.value || "student";
  const amount = Number(document.getElementById("loanAmount")?.value || 0);
  const duration = Number(document.getElementById("loanDuration")?.value || 0);
  const insurance = document.getElementById("loanInsurance")?.checked || false;
  const simulation = document.getElementById("loanSimulation");

  if (!simulation) return;

  const config = LOAN_TYPES[type];
  if (!config || !amount || !duration) {
    simulation.innerHTML = "Simulation en attente...";
    return;
  }

  const rate = config.rate + (insurance ? 0.3 : 0);
  const monthly = calculateMonthlyPayment(amount, rate, duration);
  const totalCost = monthly * duration;
  const interests = totalCost - amount;
  const insuranceText = insurance
    ? "🛡️ Assurance active"
    : "⚠️ Sans assurance";

  simulation.innerHTML = `
    <strong>Simulation</strong><br>
    Type : ${config.name}<br>
    Montant : ${formatMoney(amount)}<br>
    Taux : ${rate.toFixed(2)}%<br>
    Durée : ${duration} mois<br>
    Assurance : ${insuranceText} <br>
    Mensualité estimée : <strong>${formatMoney(monthly)}</strong><br>
    Coût total : ${formatMoney(totalCost)}<br>
    Intérêts estimés : ${formatMoney(interests)}
  `;
}

async function applyLoanPayments(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.loans = profile.loans || [];
  profile.history = profile.history || [];
  profile.transactions = profile.transactions || [];

  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  let changed = false;

  for (const loan of profile.loans) {
    if (loan.remainingAmount <= 0) continue;
    if (now - (loan.lastPayment || now) < oneDay) continue;

    const days = Math.floor((now - loan.lastPayment) / oneDay);
    const dailyPayment = loan.monthlyPayment / 30;
    const amountToPay = Math.min(dailyPayment * days, loan.remainingAmount);

    if (!canPayWithOverdraft(profile, amountToPay)) {
      addTransaction(profile, `Crédit impayé : ${LOAN_TYPES[loan.type]?.name || "Prêt"}`, 0, "loan_unpaid");
      const protection = getLoanInsuranceProtection(profile, loan.type);
      const penalty = Math.round(-15 * (1 - protection));
      updateCreditScore(profile, penalty);
      loan.lastPayment = now;
      changed = true;
      continue;
    }

    profile.accounts.courant -= amountToPay;
    loan.remainingAmount -= amountToPay;
    loan.lastPayment = now;

    addTransaction(
      profile,
      `Remboursement prêt : ${LOAN_TYPES[loan.type]?.name || "Prêt"}`,
      -amountToPay,
      "loan_payment"
    );

    updateCreditScore(profile, 2);
    changed = true;
  }

  profile.loans = profile.loans.filter(loan => loan.remainingAmount > 0);

  if (changed) {
    await updateUserProfile(uid, {
      accounts: profile.accounts,
      loans: profile.loans,
      history: profile.history,
      transactions: profile.transactions,
      creditScore: profile.creditScore
    });
  }
  return changed
    ? "💳 Remboursements de prêts mis à jour."
    : null;
}

async function renderBank(uid) {

  const profile = await getUserProfile(uid);

  updateAdminNavVisibility(profile);
  updateBusinessNavVisibility(profile);

  const creditScoreText = document.getElementById("creditScoreText");
  const creditScoreLabel = document.getElementById("creditScoreLabel");
  const overdraftText = document.getElementById("overdraftText");

  if (creditScoreText) creditScoreText.innerText = `${profile.creditScore || 500} / 1000`;
  if (creditScoreLabel) creditScoreLabel.innerText = getCreditScoreLabel(profile.creditScore || 500);
  if (overdraftText) overdraftText.innerText = `Découvert autorisé : ${formatMoney(getOverdraftLimit(profile))}`;

  profile.loans = profile.loans || [];

  const loansList =
    document.getElementById("loansList");

  loansList.innerHTML =
    profile.loans.map(loan => {

      const percent =
        ((loan.amount - loan.remainingAmount)
          / loan.amount) * 100;

      return `
      <div class="loan-card">

        <h3>
          ${LOAN_TYPES[loan.type].name}
        </h3>

        <p>
          Assurance : 
          ${loan.insurance ? "Oui" : "Non"}
        </p>

        <p>
          Montant :
          ${formatMoney(loan.amount)}
        </p>

        <p>
          Reste :
          ${formatMoney(loan.remainingAmount)}
        </p>

        <p>
          Taux :
          ${loan.rate}%
        </p>

        <p>
          Mensualité :
          ${formatMoney(loan.monthlyPayment)}
        </p>

        <div class="loan-progress">
          <div
            class="loan-progress-bar"
            style="width:${percent}%">
          </div>
        </div>

        <div class="row" style="margin-top:10px;">
          <input class="repay-loan-input" data-id="${loan.id}" type="number" placeholder="Montant à rembourser">

          <button class="repay-part-loan-btn" data-id="${loan.id}">
            Rembourser une partie
          </button>

          <button class="repay-full-loan-btn secondary" data-id="${loan.id}">
            Rembourser tout
          </button>
        </div>

      </div>
      `;
    }).join("");

    document.querySelectorAll(".repay-part-loan-btn").forEach(btn => {
      btn.onclick = async () => {
        const input = document.querySelector(`.repay-loan-input[data-id="${btn.dataset.id}"]`);
        const amount = Number(input?.value || 0);
        await repayLoan(uid, btn.dataset.id, amount);
      };
    });

    document.querySelectorAll(".repay-full-loan-btn").forEach(btn => {
      btn.onclick = async () => {
        await repayLoan(uid, btn.dataset.id, "full");
      };
    });

    document.querySelectorAll(".business-loan-only").forEach(el => {
      el.style.display = profile.isBusiness ? "block" : "none";
    });

  document.querySelectorAll(".loan-type-card").forEach(card => {

    card.onclick = () => {

      document
        .querySelectorAll(".loan-type-card")
        .forEach(c => c.classList.remove("active"));

      card.classList.add("active");

      document.getElementById("selectedLoanType").value =
        card.dataset.loan;
    };
  });

  document
    .getElementById("takeLoanBtn")
    .onclick = () => takeLoan(uid);
}

async function repayLoan(uid, loanId, amountMode) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.loans = profile.loans || [];

  const loan = profile.loans.find(l => l.id === loanId);
  if (!loan) return alert("Prêt introuvable.");

  const amount =
    amountMode === "full"
      ? loan.remainingAmount
      : Number(amountMode || 0);

  if (!amount || amount <= 0) {
    return alert("Montant invalide.");
  }

  if (amount > loan.remainingAmount) {
    return alert("Tu ne peux pas rembourser plus que le montant restant.");
  }

  if (!canPayWithOverdraft(profile, amount)) {
    return alert("Solde insuffisant, même avec le découvert autorisé.");
  }

  profile.accounts.courant -= amount;
  loan.remainingAmount -= amount;

  addTransaction(
    profile,
    `Remboursement anticipé : ${LOAN_TYPES[loan.type]?.name || "Prêt"}`,
    -amount,
    "loan_repayment"
  );
  addNotification(
    profile,
    "Prêt remboursé",
    `Remboursement de ${formatMoney(amount)} effectué.`,
    "success"
  );

  updateCreditScore(profile, amountMode === "full" ? 10 : 3);
  addXp(profile, amountMode === "full" ? 20 : 8, "Remboursement prêt");

  profile.loans = profile.loans.filter(l => l.remainingAmount > 0.01);

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    loans: profile.loans,
    history: profile.history,
    transactions: profile.transactions,
    notifications: profile.notifications,
    creditScore: profile.creditScore,
    xp: profile.xp
  });

  alert(amountMode === "full" ? "Prêt remboursé entièrement." : "Remboursement effectué.");
  await renderBank(uid);
}

async function initBank(user) {
  bindLogout();
  bindNotifications(user.uid);

  await applyLoanPayments(user.uid);
  await renderBank(user.uid);

  document.querySelectorAll(".loan-type-card").forEach(card => {
    card.onclick = () => {
      document.querySelectorAll(".loan-type-card").forEach(c => c.classList.remove("active"));
      card.classList.add("active");

      document.getElementById("selectedLoanType").value = card.dataset.loan;
      updateLoanSimulation();
    };
  });

  ["loanAmount", "loanDuration", "loanInsurance"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.oninput = updateLoanSimulation;
      el.onchange = updateLoanSimulation;
    }
  });

  const takeLoanBtn = document.getElementById("takeLoanBtn");
  if (takeLoanBtn) {
    takeLoanBtn.onclick = async () => {
      await takeLoan(user.uid);
    };
  }

  const profile = await getUserProfile(user.uid);
  renderNotificationDot(profile);

  const insuranceCheckbox =
    document.getElementById("loanInsurance");

  const insuranceCard =
    document.getElementById("insuranceCard");

  if(insuranceCheckbox && insuranceCard){

    insuranceCheckbox.addEventListener("change", () => {

      insuranceCard.classList.toggle(
        "active",
        insuranceCheckbox.checked
      );

      updateLoanSimulation();
    });

  }

  updateLoanSimulation();
}

/// Assurance ///

const INSURANCE_TYPES = {
  student: {
    name: "Assurance étudiante",
    emoji: "🎓",
    dailyFee: 1,
    protectsLoanType: "student",
    scoreProtection: 0.5
  },
  auto: {
    name: "Assurance auto",
    emoji: "🚗",
    dailyFee: 2,
    protectsLoanType: "auto",
    scoreProtection: 0.5
  },
  realestate: {
    name: "Assurance habitation / immo",
    emoji: "🏠",
    dailyFee: 5,
    protectsLoanType: "realestate",
    scoreProtection: 0.5
  },
  consumer: {
    name: "Protection crédit conso",
    emoji: "💳",
    dailyFee: 1.5,
    protectsLoanType: "consumer",
    scoreProtection: 0.5
  },
  business: {
    name: "Assurance professionnelle",
    emoji: "🏢",
    dailyFee: 15,
    protectsLoanType: "business",
    scoreProtection: 0.7,
    businessOnly: true
  },
  premiumPack: {
    name: "Pack protection Premium",
    emoji: "🛡️",
    dailyFee: 10,
    protectsLoanType: "all",
    scoreProtection: 0.75
  }
};

async function renderInsurance(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  updateAdminNavVisibility(profile);
  updateBusinessNavVisibility(profile);
  renderNotificationDot(profile);

  profile.insurances = profile.insurances || {};

  const list = document.getElementById("insuranceList");
  const mine = document.getElementById("myInsurances");

  if (list) {
    list.innerHTML = Object.entries(INSURANCE_TYPES).map(([id, item]) => {
      if (item.businessOnly && !profile.isBusiness) return "";

      const active = profile.insurances[id]?.active === true;

      return `
        <div class="card-option ${active ? "active" : ""}">
          <h3>${item.emoji} ${item.name}</h3>
          <p>Prix : <strong>${formatMoney(item.dailyFee)} / jour</strong></p>
          <p class="small">Protège : ${item.protectsLoanType === "all" ? "Tous les prêts" : item.protectsLoanType}</p>
          <p class="small">Réduction impact score : ${Math.round(item.scoreProtection * 100)}%</p>

          <button class="toggle-insurance-btn ${active ? "secondary" : ""}" data-id="${id}">
            ${active ? "Résilier" : "Souscrire"}
          </button>
        </div>
      `;
    }).join("");
  }

  if (mine) {
    const activeItems = Object.entries(profile.insurances)
      .filter(([, value]) => value.active);

    mine.innerHTML = activeItems.length
      ? activeItems.map(([id]) => {
          const item = INSURANCE_TYPES[id];
          return `<div class="list-item">${item.emoji} ${item.name} — ${formatMoney(item.dailyFee)} / jour</div>`;
        }).join("")
      : `<div class="list-item">Aucune assurance active.</div>`;
  }

  document.querySelectorAll(".toggle-insurance-btn").forEach(btn => {
    btn.onclick = async () => {
      await toggleInsurance(uid, btn.dataset.id);
    };
  });
}

async function toggleInsurance(uid, insuranceId) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  profile.insurances = profile.insurances || {};
  profile.history = profile.history || [];
  profile.transactions = profile.transactions || [];
  profile.notifications = profile.notifications || [];

  const item = INSURANCE_TYPES[insuranceId];
  if (!item) return;

  if (item.businessOnly && !profile.isBusiness) {
    alert("Cette assurance est réservée aux comptes entreprise.");
    return;
  }

  const active = !!profile.insurances[insuranceId]?.active;

  if (active) {
    profile.insurances[insuranceId].active = false;

    addTransaction(profile, `Résiliation ${item.name}`, 0, "insurance");
    addNotification(profile, "Assurance résiliée", `${item.name} a été résiliée.`, "info");
  } else {
    profile.insurances[insuranceId] = {
      active: true,
      startedAt: Date.now(),
      lastPayment: Date.now()
    };

    addTransaction(profile, `Souscription ${item.name}`, 0, "insurance");
    addNotification(profile, "Assurance activée", `${item.name} est maintenant active.`, "success");
  }

  await updateUserProfile(uid, {
    insurances: profile.insurances,
    history: profile.history,
    transactions: profile.transactions,
    notifications: profile.notifications
  });

  await renderInsurance(uid);
}

async function applyInsuranceFees(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return null;

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile.insurances = profile.insurances || {};

  let total = 0;
  const now = Date.now();

  Object.entries(profile.insurances).forEach(([id, insurance]) => {
    if (!insurance.active) return;

    const item = INSURANCE_TYPES[id];
    if (!item) return;

    const last = insurance.lastPayment || now;
    const days = Math.floor((now - last) / ONE_DAY_MS);

    if (days <= 0) return;

    const cost = item.dailyFee * days;
    total += cost;
    insurance.lastPayment = now;
  });

  if (total <= 0) return null;

  const paid = Math.min(profile.accounts.courant || 0, total);
  profile.accounts.courant -= paid;

  addTransaction(profile, "Frais assurances journaliers", -paid, "insurance_fee");

  if (paid < total) {
    updateCreditScore(profile, -10);
    addNotification(profile, "Assurance impayée", "Une partie des frais d’assurance n’a pas pu être prélevée.", "warning");
  } else {
    addNotification(profile, "Assurances prélevées", `${formatMoney(paid)} prélevés pour vos assurances.`, "info");
  }

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    insurances: profile.insurances,
    history: profile.history,
    transactions: profile.transactions,
    notifications: profile.notifications,
    creditScore: profile.creditScore
  });

  return `🛡️ Assurances prélevées : <strong>${formatMoney(paid)}</strong>`;
}

function getLoanInsuranceProtection(profile, loanType) {
  profile.insurances = profile.insurances || {};

  const specific = Object.values(INSURANCE_TYPES).find(item =>
    item.protectsLoanType === loanType
  );

  const hasPremium = profile.insurances.premiumPack?.active;

  if (hasPremium) return INSURANCE_TYPES.premiumPack.scoreProtection;

  if (specific) {
    const id = Object.keys(INSURANCE_TYPES).find(key => INSURANCE_TYPES[key] === specific);
    if (profile.insurances[id]?.active) return specific.scoreProtection;
  }

  return 0;
}



/////////////////////////////////////////////////////////////////////////
                             /// NOTIFICATION ET POPUP ///
/////////////////////////////////////////////////////////////////////////

function showDailySummaryPopup(lines) {
  return new Promise(resolve => {
    const popup = document.getElementById("dailySummaryPopup");
    const content = document.getElementById("dailySummaryContent");
    const okBtn = document.getElementById("dailySummaryOkBtn");

    if (!popup || !content || !okBtn || !lines.length) {
      resolve();
      return;
    }

    content.innerHTML = lines
      .map(line => `<div class="daily-summary-line">${line}</div>`)
      .join("");

    popup.style.display = "grid";

    okBtn.onclick = () => {
      popup.style.display = "none";
      resolve();
    };
  });
}


function addNotification(profile, title, message, type = "info") {
  profile.notifications = profile.notifications || [];

  profile.notifications.unshift({
    id: crypto.randomUUID(),
    title,
    message,
    type,
    read: false,
    createdAt: Date.now()
  });

  profile.notifications = profile.notifications.slice(0, 15);
}

function hasUnreadNotifications(profile) {
  return (profile.notifications || []).some(n => !n.read);
}

function renderNotificationDot(profile) {
  const dot = document.getElementById("notificationDot");
  if (!dot) return;

  dot.style.display = hasUnreadNotifications(profile) ? "block" : "none";
}

function formatNotificationDate(timestamp) {
  if (!timestamp) return "";

  return new Date(timestamp).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function openNotificationsPopup(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const popup = document.getElementById("notificationsPopup");
  const list = document.getElementById("notificationsList");

  if (!popup || !list) return;

  const notifications = profile.notifications || [];

  list.innerHTML = notifications.length
    ? notifications.map(n => `
      <div class="notification-item ${n.read ? "" : "unread"}">
        <div class="notification-title">${escapeHtml(n.title)}</div>
        <p class="small">${escapeHtml(n.message)}</p>
        <div class="notification-date">${formatNotificationDate(n.createdAt)}</div>
      </div>
    `).join("")
    : `<div class="list-item">Aucune notification.</div>`;

  profile.notifications = notifications.map(n => ({
    ...n,
    read: true
  }));

  await updateUserProfile(uid, {
    notifications: profile.notifications
  });

  renderNotificationDot(profile);

  popup.style.display = "grid";
}

function bindNotifications(uid) {
  const bell = document.getElementById("notificationBellBtn");
  const closeBtn = document.getElementById("closeNotificationsBtn");
  const popup = document.getElementById("notificationsPopup");

  if (bell) {
    bell.onclick = async () => {
      await openNotificationsPopup(uid);
    };
  }

  if (closeBtn) {
    closeBtn.onclick = () => {
      if (popup) popup.style.display = "none";
    };
  }

  if (popup) {
    popup.onclick = e => {
      if (e.target === popup) popup.style.display = "none";
    };
  }
}


/////////////////////////////////////////////////////////////////////////
                             /// CONSEILLER ///
/////////////////////////////////////////////////////////////////////////


let selectedAdvisorTopic = "pin";

function getAdvisorAutoReply(topic, profile) {
  const advisor = profile.agency?.advisor || profile.advisor || "votre conseiller";

  const replies = {
    pin: `Bonjour, ${advisor} a bien reçu votre demande de changement de PIN. Pour des raisons de sécurité, une vérification sera nécessaire.`,
    overdraft: `Votre demande d’augmentation de découvert a été reçue. Elle sera étudiée selon votre score bancaire actuel.`,
    lost_card: `Votre déclaration de carte perdue/volée a été prise en compte. Nous vous recommandons de bloquer immédiatement votre carte depuis l’onglet Cartes.`,
    loan: `Votre demande de prêt a été transmise au service bancaire. Une réponse dépendra de votre score bancaire et de vos prêts en cours.`,
    other: `Votre message a bien été transmis à votre conseiller. Une réponse sera disponible prochainement.`
  };

  return replies[topic] || replies.other;
}

async function renderAdvisor(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  updateAdminNavVisibility(profile);
  updateBusinessNavVisibility(profile);
  renderNotificationDot(profile);

  const agency = profile.agency || {
    advisor: profile.advisor || "Camille Martin",
    phone: "05 56 00 00 00",
    email: "conseiller@cryptex-bank.fr"
  };

  document.getElementById("advisorName").innerText = agency.advisor;
  document.getElementById("advisorInfo").innerText =
    `${agency.email} • ${agency.phone}`;

  const messages = profile.advisorMessages || [];
  const list = document.getElementById("advisorMessagesList");

  if (list) {
    list.innerHTML = messages.length
      ? messages.map(msg => `
        <div class="advisor-message ${msg.from}">
          <strong>${msg.from === "user" ? "Vous" : agency.advisor}</strong>
          <p>${escapeHtml(msg.text)}</p>
          <p class="small">${formatNotificationDate(msg.createdAt)}</p>
        </div>
      `).join("")
      : `<div class="list-item">Aucun message pour le moment.</div>`;
  }
}

async function sendAdvisorMessage(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const textarea = document.getElementById("advisorMessage");
  const text = textarea.value.trim();

  if (!text) {
    alert("Écris un message avant d’envoyer.");
    return;
  }

  profile.advisorMessages = profile.advisorMessages || [];
  profile.notifications = profile.notifications || [];

  profile.advisorMessages.unshift({
    from: "user",
    topic: selectedAdvisorTopic,
    text,
    createdAt: Date.now()
  });

  profile.advisorMessages.unshift({
    from: "bank",
    topic: selectedAdvisorTopic,
    text: getAdvisorAutoReply(selectedAdvisorTopic, profile),
    createdAt: Date.now()
  });

  profile.advisorMessages = profile.advisorMessages.slice(0, 30);

  addNotification(
    profile,
    "Message conseiller",
    "Votre conseiller a répondu à votre demande.",
    "info"
  );

  await updateUserProfile(uid, {
    advisorMessages: profile.advisorMessages,
    notifications: profile.notifications
  });

  textarea.value = "";
  await renderAdvisor(uid);
}

async function initAdvisor(user) {
  bindLogout();
  bindNotifications(user.uid);

  document.querySelectorAll(".advisor-topic").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".advisor-topic").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      selectedAdvisorTopic = btn.dataset.topic;
    };
  });

  document.getElementById("sendAdvisorMessageBtn").onclick = async () => {
    await sendAdvisorMessage(user.uid);
  };

  await renderAdvisor(user.uid);
}



/////////////////////////////////////////////////////////////////////////
                             /// BOOT ///
/////////////////////////////////////////////////////////////////////////

let marketRefreshInterval = null;

async function initMarkets(user) {
  bindLogout();
  bindMarketTabs();
  bindNotifications(user.uid);

  await renderMarkets(user.uid);

  if (marketRefreshInterval) {
    clearInterval(marketRefreshInterval);
  }

  marketRefreshInterval = setInterval(async () => {

    const profile = await getUserProfile(user.uid);
    renderNotificationDot(profile);
    if (!profile) return;

    const now = Date.now();
    const lastUpdate = profile.lastMarketUpdate || 0;

    if (now - lastUpdate < 2000) return;

    updateMarketPrices(profile);

    profile.lastMarketUpdate = now;

    await updateUserProfile(user.uid, {
      marketPrices: profile.marketPrices,
      priceHistory: profile.priceHistory,
      lastMarketUpdate: profile.lastMarketUpdate
    });

    updateMarketDisplay(profile);

  }, 2000);
}

async function initInsurance(user) {
  bindLogout();
  bindNotifications(user.uid);
  await renderInsurance(user.uid);
}

function updateMarketDisplay(profile) {

  document.querySelectorAll(".market-item").forEach(card => {

    const assetId = card.querySelector(".mini-market-chart")?.dataset.assetId;
    if (!assetId) return;

    const priceElement = card.querySelector(".market-price");

    const currentPrice = profile.marketPrices[assetId];

    if (priceElement) {
      priceElement.firstChild.textContent =
        formatMoney(currentPrice) + " ";
    }
  });

  renderMiniMarketCharts(profile);
}

watchAuth(async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  if (page === "home") await initHome(user);
  if (page === "payments") await initPayments(user);
  if (page === "cards") await initCards(user);
  if (page === "admin") await initAdmin(user);
  if (page === "business") await initBusiness(user);
  if (page === "profile") await initProfile(user);
  if (page === "markets") await initMarkets(user);
  if (page === "bank") await initBank(user);
  if (page === "insurance") await initInsurance(user);
  if (page === "advisor") await initAdvisor(user);

});