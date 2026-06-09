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

  if (paid < totalFees) {
    profile.history.unshift(`Frais impayés : ${formatMoney(totalFees - paid)}`);
  }

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    transactions: profile.transactions,
    lastBankFeePayment: profile.lastBankFeePayment
  });
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
  }

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    transactions: profile.transactions,
    lastInterestPayment: profile.lastInterestPayment
  });
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

  await applySavingInterest(user.uid);
  await applyRealEstateIncome(user.uid);
  await applyDailyBankFees(user.uid);
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

  addTransaction(
    receiverProfile,
    `Virement reçu de ${senderName} • ${reason}`,
    amount,
    "transfer"
  );

  addXp(sender, 10, "Virement");

  await updateUserProfile(uid, {
    accounts: sender.accounts,
    transactions: sender.transactions,
    history: sender.history,
    xp: sender.xp
  });

  await updateUserProfile(receiver.uid, {
    accounts: receiverProfile.accounts,
    transactions: receiverProfile.transactions,
    transactions: receiverProfile.transactions,
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
  updateBusinessNavVisibility(currentProfile);

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
  await renderProfile(user.uid);
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

  const assets = type === "crypto" ? CRYPTOS : STOCKS;
  const asset = assets.find(a => a.id === assetId);
  if (!asset) return;

  const input = document.querySelector(`.market-buy-input[data-type="${type}"][data-id="${assetId}"]`);
  const amount = Number(input?.value || 0);

  if (!amount || amount <= 0) return alert("Montant invalide.");

  profile.accounts = profile.accounts || { courant: 0, epargne: 0 };
  profile[type] = profile[type] || {};
  profile.history = profile.history || [];

  if ((profile.accounts.courant || 0) < amount) {
    return alert("Solde courant insuffisant.");
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
  addXp(profile, type === "crypto" ? 10 : 12, type === "crypto" ? "Crypto" : "Action");

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    [type]: profile[type],
    transactions: profile.transactions,
    history: profile.history,
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
  addXp(profile, 8, "Vente marché");

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    [type]: profile[type],
    transactions: profile.transactions,
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

  if ((profile.accounts.courant || 0) < property.price) {
    return alert("Solde courant insuffisant.");
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
  }

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    transactions: profile.transactions,
    lastRealEstateIncome: profile.lastRealEstateIncome
  });
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
  await renderBusiness(user.uid);
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

  const type = document.getElementById("selectedLoanType").value;
  const amount = Number(document.getElementById("loanAmount").value);
  const duration = Number(document.getElementById("loanDuration").value);

  const config = LOAN_TYPES[type];

  if (!config) return;

  if (amount <= 0 || amount > config.max) {
    alert(`Montant max : ${formatMoney(config.max)}`);
    return;
  }

  profile.loans = profile.loans || [];

  const monthlyPayment =
    calculateMonthlyPayment(
      amount,
      config.rate,
      duration
    );

  const loan = {
    id: crypto.randomUUID(),
    type,
    amount,
    remainingAmount: amount,
    durationMonths: duration,
    monthlyPayment,
    rate: config.rate,
    createdAt: Date.now(),
    lastPayment: Date.now()
  };

  profile.loans.push(loan);

  profile.accounts.courant += amount;

  addTransaction(
    profile,
    config.name,
    amount,
    "loan"
  );

  await updateUserProfile(uid,{
    loans: profile.loans,
    accounts: profile.accounts,
    history: profile.history,
    transactions: profile.transactions
  });

  renderBank(uid);
}

async function renderBank(uid) {

  const profile = await getUserProfile(uid);

  updateAdminNavVisibility(profile);
  updateBusinessNavVisibility(profile);

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

        <button
          class="repay-loan-btn"
          data-id="${loan.id}">
          Rembourser
        </button>

      </div>
      `;
    }).join("");

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

async function initBank(user) {

  bindLogout();

  await renderBank(user.uid);
}

/////////////////////////////////////////////////////////////////////////
                             /// BOOT ///
/////////////////////////////////////////////////////////////////////////

let marketRefreshInterval = null;

async function initMarkets(user) {
  bindLogout();
  bindMarketTabs();

  await renderMarkets(user.uid);

  if (marketRefreshInterval) {
    clearInterval(marketRefreshInterval);
  }

  marketRefreshInterval = setInterval(async () => {

    const profile = await getUserProfile(user.uid);
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

});