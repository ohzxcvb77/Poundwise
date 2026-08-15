"use strict";

const STORAGE_KEY = "poundwise_state_v1";
const RATE_CACHE_KEY = "poundwise_rate_cache_v1";
const EXCHANGE_API_URL = "https://api.frankfurter.dev/v2/rate/GBP/KRW";
const RATE_REFRESH_INTERVAL = 30 * 60 * 1000;
const DEFAULT_ESTIMATE_RATE = 1800;

const CATEGORY_META = {
  Rent: { label: "Rent", emoji: "🏠", color: "#7188c8", background: "#edf0fa" },
  Groceries: { label: "Groceries", emoji: "🛒", color: "#3fa181", background: "#e8f7f1" },
  Transport: { label: "Transport", emoji: "🚇", color: "#4a95c7", background: "#e9f4fb" },
  "Eating Out": { label: "Eating Out", emoji: "🍽️", color: "#dc846b", background: "#fdf0ec" },
  Shopping: { label: "Shopping", emoji: "🛍️", color: "#b273ac", background: "#f7edf6" },
  Travel: { label: "Travel", emoji: "✈️", color: "#4b9da6", background: "#e8f6f7" },
  Bills: { label: "Bills", emoji: "💡", color: "#d19a36", background: "#fff6e2" },
  Study: { label: "Study", emoji: "📚", color: "#7d78c5", background: "#efeef9" },
  Health: { label: "Health", emoji: "♥", color: "#d26874", background: "#fcedef" },
  Other: { label: "Other", emoji: "•••", color: "#7b8b88", background: "#eef2f1" },
};

const CATEGORY_NAMES = Object.keys(CATEGORY_META);
const CHART_COLORS = ["#3b9b7b", "#7089ca", "#e28a72", "#b276ad", "#d4a13d", "#4c98a4"];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

let state = loadState();
let currentRate = loadInitialRate();
let rateRequestInProgress = false;
let settingsFormDirty = false;
let settingsSavingsMode = state.settings.savingsMode;

function createDefaultState() {
  return {
    version: 2,
    onboardingComplete: false,
    settings: {
      initialBalance: 0,
      initialBalanceCurrency: "GBP",
      cycleType: "allowance",
      cycleBudget: 1000,
      nextAllowanceDate: toISODate(addDays(startOfToday(), 30)),
      savingsMode: "amount",
      savingsValue: 200,
      savedAmount: 0,
      rateMode: "auto",
      manualRate: null,
      updatedAt: new Date().toISOString(),
    },
    transactions: [],
    deletedTransactions: [],
    cloud: {
      householdId: null,
      householdName: null,
      inviteCode: null,
      role: null,
      displayName: null,
      userId: null,
      lastSyncedAt: null,
      lastError: null,
    },
  };
}

function loadState() {
  const defaults = createDefaultState();

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || typeof saved !== "object") return defaults;

    return {
      ...defaults,
      ...saved,
      settings: { ...defaults.settings, ...(saved.settings || {}) },
      transactions: Array.isArray(saved.transactions) ? saved.transactions : [],
      deletedTransactions: Array.isArray(saved.deletedTransactions) ? saved.deletedTransactions : [],
      cloud: { ...defaults.cloud, ...(saved.cloud || {}) },
    };
  } catch (error) {
    console.warn("저장 데이터를 불러오지 못했습니다.", error);
    return defaults;
  }
}

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    console.error("데이터 저장에 실패했습니다.", error);
    showToast("브라우저 저장 공간이 부족해 변경 사항을 저장하지 못했어요.", "error");
    return false;
  }
}

function queueCloudSync() {
  window.PoundwiseCloud?.queueSync();
}

function readRateCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(RATE_CACHE_KEY));
    if (!cached || !Number.isFinite(Number(cached.rate)) || Number(cached.rate) <= 0) return null;
    return {
      rate: Number(cached.rate),
      fetchedAt: cached.fetchedAt || null,
      effectiveDate: cached.effectiveDate || null,
    };
  } catch {
    return null;
  }
}

function loadInitialRate() {
  if (state.settings.rateMode === "manual" && Number(state.settings.manualRate) > 0) {
    return {
      value: Number(state.settings.manualRate),
      source: "manual",
      fetchedAt: null,
      effectiveDate: null,
      hasError: false,
    };
  }

  const cached = readRateCache();
  if (cached) {
    return {
      value: cached.rate,
      source: "cache",
      fetchedAt: cached.fetchedAt,
      effectiveDate: cached.effectiveDate,
      hasError: false,
    };
  }

  return {
    value: DEFAULT_ESTIMATE_RATE,
    source: "estimate",
    fetchedAt: null,
    effectiveDate: null,
    hasError: false,
  };
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(date, days) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() + days);
  return result;
}

function addMonthsSafe(date, months) {
  const targetMonth = date.getMonth() + months;
  const targetYear = date.getFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  return new Date(targetYear, normalizedMonth, Math.min(date.getDate(), lastDay));
}

function parseISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function differenceInDays(later, earlier) {
  const laterUtc = Date.UTC(later.getFullYear(), later.getMonth(), later.getDate());
  const earlierUtc = Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
  return Math.round((laterUtc - earlierUtc) / 86400000);
}

function formatDate(value, options = {}) {
  const date = typeof value === "string" ? parseISODate(value) : value;
  if (!date) return "날짜 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    month: options.long ? "long" : "short",
    day: "numeric",
    weekday: options.weekday ? "short" : undefined,
    year: options.year ? "numeric" : undefined,
  }).format(date);
}

function formatGBP(value, maximumFractionDigits = 2) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
  }).format(amount);
}

function formatKRW(value) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0,
  }).format(Math.round(amount));
}

function formatRate(value) {
  return `₩${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(Number(value) || 0)}`;
}

function formatNativeAmount(amount, currency) {
  return currency === "KRW" ? formatKRW(amount) : formatGBP(amount);
}

function toGBP(amount, currency, rate = currentRate.value) {
  const numericAmount = Number(amount) || 0;
  return currency === "KRW" ? numericAmount / rate : numericAmount;
}

function toKRW(amount, currency, rate = currentRate.value) {
  const numericAmount = Number(amount) || 0;
  return currency === "GBP" ? numericAmount * rate : numericAmount;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `txn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getPeriodBounds(settings = state.settings) {
  const today = startOfToday();

  if (settings.cycleType === "monthly") {
    return {
      start: new Date(today.getFullYear(), today.getMonth(), 1),
      end: new Date(today.getFullYear(), today.getMonth() + 1, 1),
    };
  }

  const parsedNextDate = parseISODate(settings.nextAllowanceDate) || addDays(today, 30);
  let start = addMonthsSafe(parsedNextDate, -1);
  let guard = 0;
  while (start > today && guard < 12) {
    start = addMonthsSafe(start, -1);
    guard += 1;
  }

  return { start, end: parsedNextDate };
}

function calculateFinances(settingsOverrides = null) {
  const settings = settingsOverrides ? { ...state.settings, ...settingsOverrides } : state.settings;
  const today = startOfToday();
  const todayString = toISODate(today);
  const period = getPeriodBounds(settings);
  const periodStart = toISODate(period.start);
  const periodEnd = toISODate(period.end);
  const applicableTransactions = state.transactions.filter((transaction) => transaction.date <= todayString);
  const periodTransactions = applicableTransactions.filter(
    (transaction) => transaction.date >= periodStart && transaction.date < periodEnd,
  );

  const initialBalanceGBP = toGBP(settings.initialBalance, settings.initialBalanceCurrency);
  const transactionBalanceGBP = applicableTransactions.reduce((total, transaction) => {
    const amountGBP = toGBP(transaction.amount, transaction.currency);
    return total + (transaction.type === "income" ? amountGBP : -amountGBP);
  }, 0);
  const balanceGBP = initialBalanceGBP + transactionBalanceGBP;

  const periodIncomeGBP = periodTransactions
    .filter((transaction) => transaction.type === "income")
    .reduce((total, transaction) => total + toGBP(transaction.amount, transaction.currency), 0);
  const periodExpensesGBP = periodTransactions
    .filter((transaction) => transaction.type === "expense")
    .reduce((total, transaction) => total + toGBP(transaction.amount, transaction.currency), 0);

  const cycleBudget = Math.max(0, Number(settings.cycleBudget) || 0);
  const savingsValue = Math.max(0, Number(settings.savingsValue) || 0);
  const savingsGoal = settings.savingsMode === "rate" ? cycleBudget * (savingsValue / 100) : savingsValue;
  const savedAmount = Math.max(0, Number(settings.savedAmount) || 0);
  const remainingSavings = Math.max(0, savingsGoal - savedAmount);
  const nextAllowanceDate = parseISODate(settings.nextAllowanceDate) || addDays(today, 30);
  const rawDaysRemaining = differenceInDays(nextAllowanceDate, today);
  const isOverdue = rawDaysRemaining < 0;
  const daysRemaining = isOverdue ? 0 : Math.max(1, rawDaysRemaining);
  const spendableBalance = Math.max(0, balanceGBP - remainingSavings);
  const dailyBudget = daysRemaining > 0 ? spendableBalance / daysRemaining : 0;
  const weekDays = Math.min(7, daysRemaining);
  const weeklyBudget = dailyBudget * weekDays;
  const spendingRate = cycleBudget > 0 ? (periodExpensesGBP / cycleBudget) * 100 : 0;
  const savingsProgress = savingsGoal > 0 ? (savedAmount / savingsGoal) * 100 : 0;

  const categoryTotals = periodTransactions
    .filter((transaction) => transaction.type === "expense")
    .reduce((totals, transaction) => {
      const category = CATEGORY_META[transaction.category] ? transaction.category : "Other";
      totals[category] = (totals[category] || 0) + toGBP(transaction.amount, transaction.currency);
      return totals;
    }, {});

  return {
    today,
    todayString,
    period,
    periodTransactions,
    balanceGBP,
    balanceKRW: balanceGBP * currentRate.value,
    periodIncomeGBP,
    periodExpensesGBP,
    periodNetGBP: periodIncomeGBP - periodExpensesGBP,
    cycleBudget,
    budgetRemaining: cycleBudget - periodExpensesGBP,
    savingsGoal,
    savedAmount,
    remainingSavings,
    nextAllowanceDate,
    rawDaysRemaining,
    daysRemaining,
    isOverdue,
    spendableBalance,
    dailyBudget,
    weekDays,
    weeklyBudget,
    spendingRate,
    savingsProgress,
    categoryTotals,
  };
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function setProgress(selector, value, warningAt = 100) {
  const element = $(selector);
  if (!element) return;
  element.style.width = `${clamp(value, 0, 100)}%`;
  element.classList.toggle("is-warning", value > warningAt);
}

function renderAll() {
  renderRate();
  renderDashboard();
  renderTransactions();
  renderStorageStatus();
  if (!settingsFormDirty) syncSettingsForm();
  updateSettingsRateCard();
  updateTransactionConversionPreview();
}

function renderRate() {
  const sourceLabels = {
    live: "자동 환율 · 최신",
    cache: currentRate.hasError ? "연결 실패 · 캐시" : "저장된 환율",
    manual: "수동 환율",
    estimate: currentRate.hasError ? "연결 실패 · 임시값" : "임시 환율",
  };
  setText("#rate-source-label", sourceLabels[currentRate.source] || "환율");
  setText("#header-rate", formatRate(currentRate.value));

  const dot = $("#rate-status-dot");
  dot?.classList.toggle("is-live", currentRate.source === "live");
  dot?.classList.toggle("is-error", currentRate.hasError || currentRate.source === "estimate");
}

function renderDashboard() {
  const finances = calculateFinances();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "좋은 아침이에요" : hour < 18 ? "좋은 오후예요" : "좋은 저녁이에요";

  setText("#greeting-text", greeting);
  setText("#today-label", new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(finances.today));
  setText("#total-balance-gbp", formatGBP(finances.balanceGBP));
  setText("#total-balance-krw", formatKRW(finances.balanceKRW));
  setText("#cycle-spent-inline", formatGBP(finances.periodExpensesGBP));
  setText("#spendable-inline", formatGBP(finances.spendableBalance));
  setText("#next-allowance-label", formatDate(finances.nextAllowanceDate, { long: true, weekday: true }));
  setText("#countdown-badge", finances.isOverdue ? "날짜 지남" : finances.rawDaysRemaining === 0 ? "D-DAY" : `D-${finances.rawDaysRemaining}`);
  setText(
    "#countdown-copy",
    finances.isOverdue
      ? "다음 용돈일을 새 날짜로 업데이트해 주세요."
      : finances.rawDaysRemaining === 0
        ? "오늘이 용돈일이에요. 새 주기 설정을 확인해 주세요."
        : `${finances.rawDaysRemaining}일 동안 하루 ${formatGBP(finances.dailyBudget)}씩 사용할 수 있어요.`,
  );

  setText("#daily-budget-gbp", formatGBP(finances.dailyBudget));
  setText("#daily-budget-krw", `약 ${formatKRW(finances.dailyBudget * currentRate.value)}`);
  setText("#weekly-budget-gbp", formatGBP(finances.weeklyBudget));
  setText("#weekly-budget-krw", `약 ${formatKRW(finances.weeklyBudget * currentRate.value)}`);
  setText("#week-days-badge", `${finances.weekDays}일`);
  setText("#daily-status-badge", finances.balanceGBP < finances.remainingSavings ? "저축 우선" : "오늘");

  const roundedSpendingRate = Math.round(finances.spendingRate);
  setText("#spending-rate-value", `${roundedSpendingRate}%`);
  setText("#spending-rate-copy", `주기 예산의 ${roundedSpendingRate}%를 사용했어요`);
  setText("#spending-status-badge", roundedSpendingRate > 100 ? "초과" : roundedSpendingRate > 80 ? "주의" : "안정적");
  setProgress("#spending-rate-bar", finances.spendingRate, 100);

  const roundedSavingsProgress = Math.round(finances.savingsProgress);
  setText("#savings-rate-value", finances.savingsGoal > 0 ? `${roundedSavingsProgress}%` : "0%");
  setText(
    "#savings-rate-copy",
    finances.savingsGoal > 0
      ? finances.remainingSavings > 0
        ? `목표까지 ${formatGBP(finances.remainingSavings)} 남았어요`
        : "이번 주기 저축 목표를 달성했어요"
      : "저축 목표를 설정해 보세요",
  );
  setText("#savings-status-badge", finances.remainingSavings <= 0 && finances.savingsGoal > 0 ? "달성" : "진행 중");
  setProgress("#savings-rate-bar", finances.savingsProgress);

  setText("#budget-spent-value", formatGBP(finances.periodExpensesGBP));
  setText("#budget-total-value", formatGBP(finances.cycleBudget));
  setText(
    "#budget-remaining-value",
    finances.budgetRemaining >= 0 ? `${formatGBP(finances.budgetRemaining)} 남음` : `${formatGBP(Math.abs(finances.budgetRemaining))} 초과`,
  );
  setProgress("#budget-progress-bar", finances.spendingRate, 100);
  setText("#period-start-label", formatDate(finances.period.start));
  setText("#period-end-label", formatDate(addDays(finances.period.end, -1)));
  setText("#remaining-savings-gbp", formatGBP(finances.remainingSavings));
  setText("#remaining-savings-krw", `약 ${formatKRW(finances.remainingSavings * currentRate.value)}`);

  setText("#sidebar-daily-gbp", formatGBP(finances.dailyBudget));
  setText("#sidebar-daily-krw", formatKRW(finances.dailyBudget * currentRate.value));
  setText(
    "#sidebar-days-left",
    finances.isOverdue ? "용돈일을 업데이트해 주세요" : `다음 용돈일까지 ${finances.rawDaysRemaining}일`,
  );

  renderCategorySummary(finances);
  renderRecentTransactions();
}

function renderCategorySummary(finances) {
  const entries = Object.entries(finances.categoryTotals)
    .map(([name, amount]) => ({ name, amount }))
    .sort((left, right) => right.amount - left.amount);
  const content = $(".category-content");
  const empty = $("#category-empty-state");

  setText("#category-period-chip", state.settings.cycleType === "monthly" ? "이번 달" : "이번 용돈 주기");

  if (entries.length === 0 || finances.periodExpensesGBP <= 0) {
    if (content) content.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }

  if (content) content.hidden = false;
  if (empty) empty.hidden = true;

  let chartEntries = entries.slice(0, 5);
  if (entries.length > 5) {
    chartEntries.push({
      name: "Other",
      amount: entries.slice(5).reduce((total, entry) => total + entry.amount, 0),
    });
  }

  let cumulative = 0;
  const segments = chartEntries.map((entry, index) => {
    const start = cumulative;
    cumulative += (entry.amount / finances.periodExpensesGBP) * 100;
    return `${CHART_COLORS[index % CHART_COLORS.length]} ${start.toFixed(2)}% ${cumulative.toFixed(2)}%`;
  });

  const donut = $("#category-donut");
  if (donut) {
    donut.style.background = `conic-gradient(${segments.join(", ")})`;
    donut.setAttribute(
      "aria-label",
      chartEntries.map((entry) => `${CATEGORY_META[entry.name]?.label || entry.name} ${Math.round((entry.amount / finances.periodExpensesGBP) * 100)}%`).join(", "),
    );
  }
  setText("#donut-total", formatGBP(finances.periodExpensesGBP, 0));

  $("#category-summary-list").innerHTML = chartEntries
    .map((entry, index) => {
      const percentage = (entry.amount / finances.periodExpensesGBP) * 100;
      const color = CHART_COLORS[index % CHART_COLORS.length];
      return `
        <div class="category-row">
          <i class="category-dot" style="background:${color}"></i>
          <div class="category-row-label">
            <span>${escapeHTML(CATEGORY_META[entry.name]?.label || entry.name)}</span>
            <small>${Math.round(percentage)}%</small>
          </div>
          <strong>${formatGBP(entry.amount)}</strong>
          <span class="category-bar"><i style="width:${clamp(percentage, 0, 100)}%;background:${color}"></i></span>
        </div>`;
    })
    .join("");
}

function sortedTransactions(transactions = state.transactions) {
  return [...transactions].sort((left, right) => {
    const byDate = String(right.date).localeCompare(String(left.date));
    if (byDate !== 0) return byDate;
    return String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || ""));
  });
}

function getCategoryMeta(category) {
  return CATEGORY_META[category] || CATEGORY_META.Other;
}

function getTransactionDisplay(transaction) {
  const isIncome = transaction.type === "income";
  const sign = isIncome ? "+" : "−";
  const native = `${sign}${formatNativeAmount(transaction.amount, transaction.currency)}`;
  const converted = transaction.currency === "GBP"
    ? formatKRW(toKRW(transaction.amount, "GBP"))
    : formatGBP(toGBP(transaction.amount, "KRW"));
  return { isIncome, native, converted };
}

function renderRecentTransactions() {
  const transactions = sortedTransactions().slice(0, 5);
  const list = $("#recent-transaction-list");
  const empty = $("#recent-empty-state");

  if (!transactions.length) {
    list.hidden = true;
    empty.hidden = false;
    return;
  }

  list.hidden = false;
  empty.hidden = true;
  list.innerHTML = transactions.map(transactionListItemTemplate).join("");
}

function transactionListItemTemplate(transaction) {
  const meta = getCategoryMeta(transaction.category);
  const display = getTransactionDisplay(transaction);
  const title = transaction.memo?.trim() || meta.label;
  return `
    <div class="transaction-list-item">
      <span class="category-icon" style="--category-color:${meta.color};--category-background:${meta.background}" aria-hidden="true">${meta.emoji}</span>
      <div class="transaction-main">
        <strong>${escapeHTML(title)}</strong>
        <small>${escapeHTML(meta.label)} · ${formatDate(transaction.date, { weekday: true })}</small>
      </div>
      <div class="transaction-amount-display">
        <strong class="${display.isIncome ? "income" : "expense"}">${display.native}</strong>
        <small>${display.converted}</small>
      </div>
    </div>`;
}

function getFilteredTransactions() {
  const search = $("#transaction-search")?.value.trim().toLocaleLowerCase() || "";
  const type = $("#transaction-type-filter")?.value || "all";
  const category = $("#transaction-category-filter")?.value || "all";

  return sortedTransactions().filter((transaction) => {
    const searchText = `${transaction.memo || ""} ${transaction.category || ""}`.toLocaleLowerCase();
    return (!search || searchText.includes(search))
      && (type === "all" || transaction.type === type)
      && (category === "all" || transaction.category === category);
  });
}

function renderTransactions() {
  const finances = calculateFinances();
  setText("#transaction-income-total", formatGBP(finances.periodIncomeGBP));
  setText("#transaction-income-krw", formatKRW(finances.periodIncomeGBP * currentRate.value));
  setText("#transaction-expense-total", formatGBP(finances.periodExpensesGBP));
  setText("#transaction-expense-krw", formatKRW(finances.periodExpensesGBP * currentRate.value));
  setText("#transaction-net-total", formatGBP(finances.periodNetGBP));
  setText("#transaction-net-krw", formatKRW(finances.periodNetGBP * currentRate.value));

  const filtered = getFilteredTransactions();
  const tableBody = $("#transaction-table-body");
  const mobileList = $("#mobile-transaction-list");
  const empty = $("#transaction-empty-state");

  if (!filtered.length) {
    tableBody.innerHTML = "";
    mobileList.innerHTML = "";
    empty.hidden = false;
    const hasFilters = Boolean($("#transaction-search")?.value || $("#transaction-type-filter")?.value !== "all" || $("#transaction-category-filter")?.value !== "all");
    setText("#transaction-empty-title", hasFilters ? "조건에 맞는 거래가 없어요" : "아직 거래가 없어요");
    setText("#transaction-empty-copy", hasFilters ? "검색어나 필터를 바꿔보세요." : "새 수입이나 지출을 기록해 보세요.");
    return;
  }

  empty.hidden = true;
  tableBody.innerHTML = filtered.map(transactionTableRowTemplate).join("");
  mobileList.innerHTML = filtered.map(transactionMobileCardTemplate).join("");
}

function transactionTableRowTemplate(transaction) {
  const meta = getCategoryMeta(transaction.category);
  const display = getTransactionDisplay(transaction);
  const title = transaction.memo?.trim() || meta.label;
  return `
    <tr>
      <td>
        <div class="table-transaction">
          <span class="category-icon" style="--category-color:${meta.color};--category-background:${meta.background}" aria-hidden="true">${meta.emoji}</span>
          <div><strong>${escapeHTML(title)}</strong><small>${transaction.type === "income" ? "수입" : "지출"} · ${escapeHTML(transaction.currency)}</small></div>
        </div>
      </td>
      <td><span class="table-date"><strong>${formatDate(transaction.date, { weekday: true })}</strong><small>${escapeHTML(transaction.date)}</small></span></td>
      <td><span class="category-tag" style="--category-color:${meta.color};--category-background:${meta.background}">${escapeHTML(meta.label)}</span></td>
      <td><span class="table-amount"><strong class="${display.isIncome ? "income" : "expense"}">${display.native}</strong><small>${display.converted}</small></span></td>
      <td>
        <div class="row-actions">
          <button type="button" data-edit-id="${escapeHTML(transaction.id)}" aria-label="거래 수정" title="수정"><svg aria-hidden="true"><use href="#icon-edit"></use></svg></button>
          <button class="delete-action" type="button" data-delete-id="${escapeHTML(transaction.id)}" aria-label="거래 삭제" title="삭제"><svg aria-hidden="true"><use href="#icon-trash"></use></svg></button>
        </div>
      </td>
    </tr>`;
}

function transactionMobileCardTemplate(transaction) {
  const meta = getCategoryMeta(transaction.category);
  const display = getTransactionDisplay(transaction);
  const title = transaction.memo?.trim() || meta.label;
  return `
    <div class="mobile-transaction-card">
      <span class="category-icon" style="--category-color:${meta.color};--category-background:${meta.background}" aria-hidden="true">${meta.emoji}</span>
      <div class="transaction-main">
        <strong>${escapeHTML(title)}</strong>
        <small>${escapeHTML(meta.label)} · ${formatDate(transaction.date, { weekday: true })}</small>
      </div>
      <div class="transaction-amount-display"><strong class="${display.isIncome ? "income" : "expense"}">${display.native}</strong><small>${display.converted}</small></div>
      <div class="mobile-row-actions">
        <button type="button" data-edit-id="${escapeHTML(transaction.id)}">수정</button>
        <button type="button" data-delete-id="${escapeHTML(transaction.id)}">삭제</button>
      </div>
    </div>`;
}

function syncSettingsForm() {
  const settings = state.settings;
  settingsSavingsMode = settings.savingsMode;
  $("#settings-cycle-type").value = settings.cycleType;
  $("#settings-cycle-budget").value = settings.cycleBudget;
  $("#settings-next-date").value = settings.nextAllowanceDate;
  $("#settings-initial-balance").value = settings.initialBalance;
  $("#settings-initial-currency").value = settings.initialBalanceCurrency;
  $("#settings-savings-value").value = settings.savingsValue;
  $("#settings-saved-amount").value = settings.savedAmount;
  $("#manual-rate-input").value = settings.manualRate || "";
  updateSavingsModeUI();
  updateSettingsPreview();
}

function updateSavingsModeUI() {
  $$("[data-savings-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.savingsMode === settingsSavingsMode);
  });
  const rateMode = settingsSavingsMode === "rate";
  setText("#savings-value-label", rateMode ? "목표 저축률" : "목표 저축액");
  setText("#savings-value-prefix", rateMode ? "" : "£");
  $("#savings-value-suffix").hidden = !rateMode;
  $("#settings-savings-value").max = rateMode ? "100" : "";
  $("#settings-savings-value").step = rateMode ? "1" : "0.01";
}

function readSettingsFormValues() {
  return {
    cycleType: $("#settings-cycle-type").value,
    cycleBudget: Number($("#settings-cycle-budget").value) || 0,
    nextAllowanceDate: $("#settings-next-date").value,
    initialBalance: Number($("#settings-initial-balance").value) || 0,
    initialBalanceCurrency: $("#settings-initial-currency").value,
    savingsMode: settingsSavingsMode,
    savingsValue: Number($("#settings-savings-value").value) || 0,
    savedAmount: Number($("#settings-saved-amount").value) || 0,
  };
}

function updateSettingsPreview() {
  const overrides = readSettingsFormValues();
  const finances = calculateFinances(overrides);
  setText("#settings-goal-preview", formatGBP(finances.savingsGoal));
  setText("#settings-remaining-preview", formatGBP(finances.remainingSavings));
  setText("#settings-daily-preview", formatGBP(finances.dailyBudget));
}

function updateSettingsRateCard() {
  const labels = {
    live: "자동 환율",
    cache: "마지막 성공 환율",
    manual: "수동 환율",
    estimate: "임시 환율",
  };
  setText("#settings-rate-value", formatRate(currentRate.value));
  setText("#settings-rate-indicator span", labels[currentRate.source] || "환율");

  let updatedText = "기본 임시값 · 수동 입력 가능";
  if (currentRate.source === "manual") {
    updatedText = "사용자가 직접 입력한 환율";
  } else if (currentRate.fetchedAt) {
    const fetchedDate = new Date(currentRate.fetchedAt);
    updatedText = `${new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(fetchedDate)} 확인`;
    if (currentRate.effectiveDate) updatedText += ` · 기준 ${currentRate.effectiveDate}`;
  }
  if (currentRate.hasError && currentRate.source === "cache") updatedText += " · 현재 연결 실패";
  setText("#settings-rate-updated", updatedText);

  const indicator = $("#settings-rate-indicator");
  indicator?.classList.toggle("is-manual", currentRate.source === "manual" || currentRate.source === "estimate" || currentRate.hasError);
  setText("#restore-auto-rate", state.settings.rateMode === "manual" ? "자동으로 복귀" : "자동 환율 사용 중");
}

function renderStorageStatus() {
  const cloudConnected = Boolean(window.PoundwiseCloud?.isConnected?.());
  setText("#storage-status-copy", `거래 ${state.transactions.length}건 · ${cloudConnected ? "가족 클라우드 연결됨" : "자동 저장됨"}`);
  setText("#sidebar-storage-note", cloudConnected ? "가족 가계부와 안전하게 동기화됩니다." : "데이터는 이 브라우저에만 저장됩니다.");
}

function showView(view, options = {}) {
  const target = ["dashboard", "transactions", "settings"].includes(view) ? view : "dashboard";
  $$("[data-view]").forEach((section) => {
    const active = section.dataset.view === target;
    section.hidden = !active;
    section.classList.toggle("is-active", active);
  });

  $$(".side-nav [data-view-target], .mobile-nav [data-view-target]").forEach((button) => {
    const mobileSection = options.focusSection || "budget";
    const active = button.dataset.viewTarget === target
      && (target !== "settings" || !button.closest(".mobile-nav") || button.dataset.focusSection === mobileSection);
    button.classList.toggle("is-active", active);
  });

  if (target === "settings" && !settingsFormDirty) syncSettingsForm();
  history.replaceState(null, "", `#${target}`);
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (options.focusSection === "data" || options.focusSection === "cloud") {
    const selector = options.focusSection === "cloud" ? "#cloud-card" : ".data-card";
    requestAnimationFrame(() => $(selector)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
}

function populateCategorySelects() {
  const options = CATEGORY_NAMES.map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(CATEGORY_META[name].label)}</option>`).join("");
  $("#transaction-category").innerHTML = options;
  $("#transaction-category-filter").insertAdjacentHTML("beforeend", options);
}

function setTransactionType(type) {
  const normalized = type === "income" ? "income" : "expense";
  $("#transaction-type").value = normalized;
  $$("[data-transaction-type]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.transactionType === normalized);
  });
}

function openTransactionDialog(transaction = null) {
  const dialog = $("#transaction-dialog");
  const form = $("#transaction-form");
  form.reset();
  $("#transaction-id").value = transaction?.id || "";
  $("#transaction-date").value = transaction?.date || toISODate(startOfToday());
  $("#transaction-amount").value = transaction?.amount ?? "";
  $("#transaction-currency").value = transaction?.currency || "GBP";
  $("#transaction-category").value = CATEGORY_META[transaction?.category] ? transaction.category : "Other";
  $("#transaction-memo").value = transaction?.memo || "";
  setTransactionType(transaction?.type || "expense");
  setText("#transaction-modal-eyebrow", transaction ? "EDIT TRANSACTION" : "NEW TRANSACTION");
  setText("#transaction-modal-title", transaction ? "거래 수정" : "거래 추가");
  setText("#transaction-submit-button", transaction ? "변경 저장" : "거래 저장");
  updateTransactionCurrencyUI();
  updateTransactionConversionPreview();
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $("#transaction-amount").focus());
}

function updateTransactionCurrencyUI() {
  const currency = $("#transaction-currency").value;
  setText("#transaction-amount-prefix", currency === "GBP" ? "£" : "₩");
  $("#transaction-amount").min = currency === "GBP" ? "0.01" : "1";
  $("#transaction-amount").step = currency === "GBP" ? "0.01" : "1";
}

function updateTransactionConversionPreview() {
  const amount = Number($("#transaction-amount")?.value) || 0;
  const currency = $("#transaction-currency")?.value || "GBP";
  const converted = currency === "GBP" ? formatKRW(toKRW(amount, "GBP")) : formatGBP(toGBP(amount, "KRW"));
  const rateNote = currentRate.source === "manual" ? "수동 환율" : currentRate.source === "live" ? "최신 환율" : "저장된/임시 환율";
  setText("#transaction-conversion-preview", `환산 금액 ${converted} · ${rateNote}`);
}

function handleTransactionSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;

  const id = $("#transaction-id").value;
  const amount = Number($("#transaction-amount").value);
  const date = $("#transaction-date").value;
  if (!Number.isFinite(amount) || amount <= 0 || !parseISODate(date)) {
    showToast("금액과 날짜를 다시 확인해 주세요.", "error");
    return;
  }

  const existing = state.transactions.find((transaction) => transaction.id === id);
  const transaction = {
    id: id || createId(),
    type: $("#transaction-type").value === "income" ? "income" : "expense",
    amount,
    currency: $("#transaction-currency").value === "KRW" ? "KRW" : "GBP",
    date,
    category: CATEGORY_META[$("#transaction-category").value] ? $("#transaction-category").value : "Other",
    memo: $("#transaction-memo").value.trim(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    state.transactions = state.transactions.map((item) => (item.id === id ? transaction : item));
  } else {
    state.transactions.push(transaction);
  }

  persistState();
  $("#transaction-dialog").close();
  renderAll();
  queueCloudSync();
  showToast(existing ? "거래를 수정했어요." : "새 거래를 저장했어요.");
}

function requestDeleteTransaction(id) {
  const transaction = state.transactions.find((item) => item.id === id);
  if (!transaction) return;
  $("#delete-transaction-id").value = id;
  const dialog = $("#delete-dialog");
  if (!dialog.open) dialog.showModal();
}

function handleDeleteSubmit(event) {
  event.preventDefault();
  const id = $("#delete-transaction-id").value;
  const deletedTransaction = state.transactions.find((transaction) => transaction.id === id);
  if (deletedTransaction) {
    state.deletedTransactions = state.deletedTransactions.filter((transaction) => transaction.id !== id);
    state.deletedTransactions.push({
      ...deletedTransaction,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  state.transactions = state.transactions.filter((transaction) => transaction.id !== id);
  persistState();
  $("#delete-dialog").close();
  renderAll();
  queueCloudSync();
  showToast("거래를 삭제했어요.");
}

function handleBudgetSettingsSubmit(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;

  const values = readSettingsFormValues();
  const nextDate = parseISODate(values.nextAllowanceDate);
  if (!nextDate || differenceInDays(nextDate, startOfToday()) < 0) {
    showToast("다음 용돈일은 오늘 이후로 설정해 주세요.", "error");
    return;
  }
  if (values.savingsMode === "rate" && values.savingsValue > 100) {
    showToast("저축률은 100% 이하로 설정해 주세요.", "error");
    return;
  }

  state.settings = { ...state.settings, ...values, updatedAt: new Date().toISOString() };
  settingsFormDirty = false;
  persistState();
  renderAll();
  queueCloudSync();
  setText("#budget-save-hint", "방금 저장됨");
  showToast("예산과 저축 목표를 저장했어요.");
}

function prepareOnboarding() {
  const nextDate = state.settings.nextAllowanceDate || toISODate(addDays(startOfToday(), 30));
  $("#onboarding-next-date").value = nextDate;
  $("#onboarding-budget").value = state.settings.cycleBudget || 1000;
  $("#onboarding-savings-value").value = state.settings.savingsValue || 200;
  $("#onboarding-savings-mode").value = state.settings.savingsMode || "amount";
  updateOnboardingBalancePreview();
}

function updateOnboardingBalancePreview() {
  const amount = Number($("#onboarding-balance")?.value) || 0;
  const currency = $("#onboarding-balance-currency")?.value || "GBP";
  const converted = currency === "GBP" ? formatKRW(toKRW(amount, "GBP")) : formatGBP(toGBP(amount, "KRW"));
  setText("#onboarding-balance-preview", amount > 0 ? `현재 환율 기준 약 ${converted}` : "두 통화로 자동 환산해 드려요.");
}

function handleOnboardingSubmit(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;

  const nextAllowanceDate = $("#onboarding-next-date").value;
  const nextDate = parseISODate(nextAllowanceDate);
  if (!nextDate || differenceInDays(nextDate, startOfToday()) < 0) {
    showToast("다음 용돈일은 오늘 이후로 설정해 주세요.", "error");
    return;
  }

  const savingsMode = $("#onboarding-savings-mode").value === "rate" ? "rate" : "amount";
  const savingsValue = Number($("#onboarding-savings-value").value) || 0;
  if (savingsMode === "rate" && savingsValue > 100) {
    showToast("저축률은 100% 이하로 설정해 주세요.", "error");
    return;
  }

  state.settings = {
    ...state.settings,
    initialBalance: Number($("#onboarding-balance").value) || 0,
    initialBalanceCurrency: $("#onboarding-balance-currency").value === "KRW" ? "KRW" : "GBP",
    cycleType: "allowance",
    cycleBudget: Number($("#onboarding-budget").value) || 0,
    nextAllowanceDate,
    savingsMode,
    savingsValue,
    savedAmount: 0,
    updatedAt: new Date().toISOString(),
  };
  state.onboardingComplete = true;
  settingsSavingsMode = savingsMode;
  persistState();
  $("#onboarding-dialog").close();
  renderAll();
  queueCloudSync();
  showToast("첫 예산 설정이 완료됐어요. 이제 거래를 기록해 보세요!");
}

async function fetchExchangeRate({ force = false, notify = false } = {}) {
  if (rateRequestInProgress) return;
  if (state.settings.rateMode === "manual" && !force) return;
  rateRequestInProgress = true;
  $$("#refresh-rate-button, #settings-refresh-rate").forEach((button) => button.classList.add("is-loading"));

  try {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 9000);
    const response = await fetch(EXCHANGE_API_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    window.clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`환율 API 오류: ${response.status}`);

    const data = await response.json();
    const rate = Number(data.rate);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("환율 응답 형식이 올바르지 않습니다.");

    const fetchedAt = new Date().toISOString();
    currentRate = {
      value: rate,
      source: "live",
      fetchedAt,
      effectiveDate: data.date || null,
      hasError: false,
    };
    localStorage.setItem(RATE_CACHE_KEY, JSON.stringify({ rate, fetchedAt, effectiveDate: data.date || null }));
    renderAll();
    if (notify) showToast("최신 GBP/KRW 환율을 적용했어요.");
  } catch (error) {
    console.warn("실시간 환율을 가져오지 못했습니다.", error);
    const cached = readRateCache();
    currentRate = cached
      ? {
          value: cached.rate,
          source: "cache",
          fetchedAt: cached.fetchedAt,
          effectiveDate: cached.effectiveDate,
          hasError: true,
        }
      : {
          value: Number(state.settings.manualRate) > 0 ? Number(state.settings.manualRate) : DEFAULT_ESTIMATE_RATE,
          source: Number(state.settings.manualRate) > 0 ? "manual" : "estimate",
          fetchedAt: null,
          effectiveDate: null,
          hasError: true,
        };
    renderAll();
    if (notify) {
      showToast(cached ? "환율 연결에 실패해 마지막 성공 환율을 사용합니다." : "환율 연결에 실패했습니다. 설정에서 수동 환율을 입력해 주세요.", "error");
    }
  } finally {
    rateRequestInProgress = false;
    $$("#refresh-rate-button, #settings-refresh-rate").forEach((button) => button.classList.remove("is-loading"));
  }
}

function restoreAutomaticRate(notify = true) {
  state.settings.rateMode = "auto";
  persistState();
  fetchExchangeRate({ force: true, notify });
}

function applyManualRate() {
  const rate = Number($("#manual-rate-input").value);
  if (!Number.isFinite(rate) || rate <= 0) {
    showToast("1 GBP당 원화 환율을 올바르게 입력해 주세요.", "error");
    return;
  }

  state.settings.rateMode = "manual";
  state.settings.manualRate = rate;
  currentRate = { value: rate, source: "manual", fetchedAt: null, effectiveDate: null, hasError: false };
  persistState();
  renderAll();
  showToast("수동 환율을 적용했어요.");
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportTransactionsCSV() {
  const header = ["id", "type", "amount", "currency", "date", "category", "memo"];
  const rows = sortedTransactions().map((transaction) =>
    header.map((key) => csvEscape(transaction[key])).join(","),
  );
  const csv = `\uFEFF${header.join(",")}\r\n${rows.join("\r\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `poundwise-transactions-${toISODate(startOfToday())}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`${state.transactions.length}건의 거래를 CSV로 내보냈어요.`);
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (character === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim() !== ""));
}

async function importTransactionsCSV(file) {
  try {
    const text = (await file.text()).replace(/^\uFEFF/, "");
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error("CSV에 거래 데이터가 없습니다.");

    const headers = rows[0].map((header) => header.trim().toLowerCase());
    const required = ["type", "amount", "currency", "date"];
    if (required.some((header) => !headers.includes(header))) {
      throw new Error("필수 열(type, amount, currency, date)이 없습니다.");
    }

    const imported = [];
    let skipped = 0;
    rows.slice(1).forEach((row) => {
      const record = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
      const normalizedType = record.type.trim().toLowerCase();
      const type = ["income", "수입"].includes(normalizedType) ? "income" : ["expense", "지출"].includes(normalizedType) ? "expense" : null;
      const amount = Number(record.amount);
      const currency = record.currency.trim().toUpperCase();
      const date = record.date.trim();

      if (!type || !Number.isFinite(amount) || amount <= 0 || !["GBP", "KRW"].includes(currency) || !parseISODate(date)) {
        skipped += 1;
        return;
      }

      imported.push({
        id: createId(),
        type,
        amount,
        currency,
        date,
        category: CATEGORY_META[record.category?.trim()] ? record.category.trim() : "Other",
        memo: String(record.memo || "").trim().slice(0, 100),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    if (!imported.length) throw new Error("가져올 수 있는 올바른 거래가 없습니다.");
    state.transactions.push(...imported);
    persistState();
    renderAll();
    queueCloudSync();
    showToast(`${imported.length}건을 불러왔어요${skipped ? ` · ${skipped}건 제외` : ""}.`);
  } catch (error) {
    showToast(error.message || "CSV 파일을 불러오지 못했어요.", "error");
  } finally {
    $("#csv-file-input").value = "";
  }
}

function showToast(message, type = "success") {
  const region = $("#toast-region");
  const toast = document.createElement("div");
  toast.className = `toast${type === "error" ? " is-error" : ""}`;
  toast.innerHTML = `<svg aria-hidden="true"><use href="#${type === "error" ? "icon-info" : "icon-shield-check"}"></use></svg><span>${escapeHTML(message)}</span>`;
  region.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 210);
  }, 3400);
}

function handleDelegatedTransactionAction(event) {
  const editButton = event.target.closest("[data-edit-id]");
  if (editButton) {
    const transaction = state.transactions.find((item) => item.id === editButton.dataset.editId);
    if (transaction) openTransactionDialog(transaction);
    return;
  }

  const deleteButton = event.target.closest("[data-delete-id]");
  if (deleteButton) requestDeleteTransaction(deleteButton.dataset.deleteId);
}

function bindEvents() {
  $$('[data-view-target]').forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.viewTarget, { focusSection: button.dataset.focusSection }));
  });
  $$('[data-nav]').forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      showView(link.dataset.nav);
    });
  });
  $$('[data-open-transaction]').forEach((button) => button.addEventListener("click", () => openTransactionDialog()));
  $$('[data-close-transaction]').forEach((button) => button.addEventListener("click", () => $("#transaction-dialog").close()));

  $$("[data-transaction-type]").forEach((button) => {
    button.addEventListener("click", () => setTransactionType(button.dataset.transactionType));
  });
  $("#transaction-currency").addEventListener("change", () => {
    updateTransactionCurrencyUI();
    updateTransactionConversionPreview();
  });
  $("#transaction-amount").addEventListener("input", updateTransactionConversionPreview);
  $("#transaction-form").addEventListener("submit", handleTransactionSubmit);
  $("#transaction-table-body").addEventListener("click", handleDelegatedTransactionAction);
  $("#mobile-transaction-list").addEventListener("click", handleDelegatedTransactionAction);
  $("#delete-form").addEventListener("submit", handleDeleteSubmit);
  $("#cancel-delete-button").addEventListener("click", () => $("#delete-dialog").close());

  ["#transaction-search", "#transaction-type-filter", "#transaction-category-filter"].forEach((selector) => {
    $(selector).addEventListener(selector === "#transaction-search" ? "input" : "change", renderTransactions);
  });

  $("#budget-settings-form").addEventListener("input", () => {
    settingsFormDirty = true;
    setText("#budget-save-hint", "저장하지 않은 변경 사항이 있어요.");
    updateSettingsPreview();
  });
  $("#budget-settings-form").addEventListener("change", updateSettingsPreview);
  $("#budget-settings-form").addEventListener("submit", handleBudgetSettingsSubmit);
  $$("[data-savings-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      settingsSavingsMode = button.dataset.savingsMode;
      settingsFormDirty = true;
      updateSavingsModeUI();
      updateSettingsPreview();
      setText("#budget-save-hint", "저장하지 않은 변경 사항이 있어요.");
    });
  });

  $("#onboarding-form").addEventListener("submit", handleOnboardingSubmit);
  $("#onboarding-dialog").addEventListener("cancel", (event) => {
    if (!state.onboardingComplete) event.preventDefault();
  });
  $("#onboarding-balance").addEventListener("input", updateOnboardingBalancePreview);
  $("#onboarding-balance-currency").addEventListener("change", updateOnboardingBalancePreview);

  $("#refresh-rate-button").addEventListener("click", () => restoreAutomaticRate(true));
  $("#settings-refresh-rate").addEventListener("click", () => restoreAutomaticRate(true));
  $("#restore-auto-rate").addEventListener("click", () => restoreAutomaticRate(true));
  $("#apply-manual-rate").addEventListener("click", applyManualRate);

  $("#export-csv-button").addEventListener("click", exportTransactionsCSV);
  $("#export-shortcut-button").addEventListener("click", exportTransactionsCSV);
  $("#import-csv-button").addEventListener("click", () => $("#csv-file-input").click());
  $("#csv-file-input").addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) importTransactionsCSV(file);
  });

  window.addEventListener("online", () => {
    if (state.settings.rateMode === "auto") fetchExchangeRate();
  });
}

function initialize() {
  populateCategorySelects();
  bindEvents();
  prepareOnboarding();
  renderAll();

  const initialView = location.hash.replace("#", "");
  showView(["dashboard", "transactions", "settings"].includes(initialView) ? initialView : "dashboard");

  if (!state.onboardingComplete) {
    $("#onboarding-dialog").showModal();
  }

  if (state.settings.rateMode === "auto") fetchExchangeRate();
  window.setInterval(() => {
    if (!document.hidden && state.settings.rateMode === "auto") fetchExchangeRate();
  }, RATE_REFRESH_INTERVAL);
}

initialize();
