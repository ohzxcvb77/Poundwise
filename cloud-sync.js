"use strict";

(() => {
  const CLOUD_CONFIG_KEY = "poundwise_cloud_config_v1";
  const SUPABASE_MODULE_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
  const SYNC_INTERVAL = 20 * 1000;
  const SYNC_DEBOUNCE = 900;
  const SHARED_SETTING_KEYS = [
    "initialBalance",
    "initialBalanceCurrency",
    "cycleType",
    "cycleBudget",
    "nextAllowanceDate",
    "savingsMode",
    "savingsValue",
    "savedAmount",
  ];

  let cloudClient = null;
  let cloudSession = null;
  let cloudMembers = [];
  let cloudStatus = "local";
  let cloudStatusMessage = "";
  let cloudAuthMode = "signin";
  let cloudSyncInProgress = false;
  let cloudSyncTimer = null;
  let cloudChannel = null;
  let cloudAuthSubscription = null;
  let deferredInstallPrompt = null;
  let ignoreRealtimeUntil = 0;

  function readCloudConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(CLOUD_CONFIG_KEY));
      if (saved?.supabaseUrl && saved?.supabasePublishableKey) return saved;
    } catch {
      // Fall through to deployment configuration.
    }

    const deployed = window.POUNDWISE_CLOUD_CONFIG || {};
    return {
      supabaseUrl: String(deployed.supabaseUrl || "").trim().replace(/\/$/, ""),
      supabasePublishableKey: String(deployed.supabasePublishableKey || "").trim(),
    };
  }

  function hasCloudConfig() {
    const config = readCloudConfig();
    return Boolean(config.supabaseUrl && config.supabasePublishableKey);
  }

  function isUnsafeBrowserKey(key) {
    if (/^sb_secret_/i.test(key) || /service_role/i.test(key)) return true;
    const payload = key.split(".")[1];
    if (!payload) return false;
    try {
      const normalized = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
      return JSON.parse(atob(normalized)).role === "service_role";
    } catch {
      return false;
    }
  }

  function setCloudStatus(status, message = "") {
    cloudStatus = status;
    cloudStatusMessage = message;
    renderCloudUI();
  }

  function getDefaultCloudState() {
    return {
      householdId: null,
      householdName: null,
      inviteCode: null,
      role: null,
      displayName: null,
      userId: null,
      lastSyncedAt: null,
      lastError: null,
    };
  }

  function normalizeCloudError(error) {
    const message = String(error?.message || error || "알 수 없는 오류");
    if (/invalid login credentials/i.test(message)) return "이메일 또는 비밀번호가 올바르지 않아요.";
    if (/email not confirmed/i.test(message)) return "이메일 인증을 먼저 완료해 주세요.";
    if (/user already registered/i.test(message)) return "이미 가입된 이메일이에요.";
    if (/invalid.*invite|invite.*not found|초대/i.test(message)) return "초대 코드를 확인해 주세요.";
    if (/failed to fetch|network|load failed/i.test(message)) return "인터넷 연결 또는 Supabase 설정을 확인해 주세요.";
    if (/row-level security|permission|policy/i.test(message)) return "공유 권한 설정을 확인해 주세요. 제공된 SQL을 먼저 실행해야 합니다.";
    return message;
  }

  function setButtonBusy(button, busy, busyText = "처리 중…") {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
    }
  }

  function setCloudView(selector, visible) {
    const element = $(selector);
    if (element) element.hidden = !visible;
  }

  function renderCloudUI() {
    const configured = hasCloudConfig();
    const signedIn = Boolean(cloudSession?.user);
    const connected = Boolean(signedIn && state.cloud?.householdId);
    const offline = !navigator.onLine;
    const config = readCloudConfig();

    setCloudView("#cloud-config-required-view", !configured);
    setCloudView("#cloud-auth-view", configured && !signedIn);
    setCloudView("#cloud-household-view", configured && signedIn && !connected);
    setCloudView("#cloud-connected-view", configured && signedIn && connected);

    const urlInput = $("#supabase-url-input");
    const keyInput = $("#supabase-key-input");
    if (urlInput && document.activeElement !== urlInput) urlInput.value = config.supabaseUrl || "";
    if (keyInput && document.activeElement !== keyInput) keyInput.value = config.supabasePublishableKey || "";

    let title = "로컬 모드";
    let copy = "현재 기기에만 저장되고 있어요.";
    let pillLabel = "이 기기에만 저장";
    let pillStatus = "동기화 꺼짐";
    let visualStatus = "local";

    if (configured && cloudStatus === "loading") {
      title = "클라우드 연결 중";
      copy = "계정과 가족 공간을 확인하고 있어요.";
      pillLabel = "클라우드 확인 중";
      pillStatus = "연결 중";
      visualStatus = "syncing";
    } else if (configured && !signedIn) {
      title = "클라우드 준비됨";
      copy = "로그인하면 여러 기기에서 이어서 사용할 수 있어요.";
      pillLabel = "계정 필요";
      pillStatus = "로그인하기";
    } else if (configured && signedIn && !connected) {
      title = "계정 연결됨";
      copy = "가족 가계부를 만들거나 초대 코드로 참여하세요.";
      pillLabel = cloudSession.user.email || "계정 연결됨";
      pillStatus = "가족 선택 필요";
    } else if (connected) {
      title = offline ? "오프라인 저장 중" : cloudSyncInProgress ? "동기화 중" : "가족 공유 중";
      copy = offline
        ? "변경 사항은 연결이 돌아오면 자동으로 합쳐집니다."
        : cloudStatusMessage || `${state.cloud.householdName || "가족 가계부"}와 연결되어 있어요.`;
      pillLabel = state.cloud.householdName || "가족 가계부";
      pillStatus = offline ? "오프라인" : cloudSyncInProgress ? "동기화 중" : "동기화 켜짐";
      visualStatus = cloudSyncInProgress ? "syncing" : "connected";
    }

    if (cloudStatus === "error") {
      title = connected ? "동기화 확인 필요" : "클라우드 연결 실패";
      copy = cloudStatusMessage || state.cloud.lastError || "연결 설정을 확인해 주세요.";
      pillStatus = "확인 필요";
      visualStatus = "error";
    }

    setText("#cloud-state-title", title);
    setText("#cloud-state-copy", copy);
    setText("#cloud-pill-label", pillLabel);
    setText("#cloud-pill-status", pillStatus);

    const banner = $("#cloud-state-banner");
    const pill = $("#cloud-pill");
    [banner, pill].forEach((element) => {
      if (!element) return;
      element.classList.toggle("is-connected", visualStatus === "connected");
      element.classList.toggle("is-syncing", visualStatus === "syncing");
      element.classList.toggle("is-error", visualStatus === "error");
    });

    setText("#cloud-account-email", cloudSession?.user?.email || "—");
    setText("#cloud-household-name", state.cloud?.householdName || "가족 가계부");
    setText("#cloud-invite-code", state.cloud?.inviteCode || "--------");
    setText("#cloud-role-badge", state.cloud?.role === "owner" ? "관리자" : "멤버");
    renderMembers();
    renderSyncStatus();
    renderStorageStatus();
  }

  function renderMembers() {
    const list = $("#cloud-member-list");
    if (!list) return;
    setText("#cloud-member-count", `${cloudMembers.length}명`);
    if (!cloudMembers.length) {
      list.innerHTML = '<span class="member-chip"><i>?</i>멤버 확인 중</span>';
      return;
    }

    list.innerHTML = cloudMembers.map((member) => {
      const displayName = member.display_name || "가족";
      return `<span class="member-chip ${member.role === "owner" ? "owner" : ""}"><i>${escapeHTML(displayName.slice(0, 1))}</i>${escapeHTML(displayName)}</span>`;
    }).join("");
  }

  function renderSyncStatus() {
    const icon = $("#cloud-sync-icon");
    icon?.classList.toggle("is-syncing", cloudSyncInProgress);
    setText("#cloud-sync-title", !navigator.onLine ? "오프라인 변경 저장됨" : cloudSyncInProgress ? "가족 데이터 합치는 중" : cloudStatus === "error" ? "동기화 확인 필요" : "모든 기기와 동기화됨");
    let lastSync = "아직 동기화하지 않았어요.";
    if (state.cloud?.lastSyncedAt) {
      lastSync = `${new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(state.cloud.lastSyncedAt))} 마지막 동기화`;
    }
    setText("#cloud-last-sync", lastSync);
  }

  function updateAuthMode(mode) {
    cloudAuthMode = mode === "signup" ? "signup" : "signin";
    $$('[data-cloud-auth-mode]').forEach((button) => button.classList.toggle("is-active", button.dataset.cloudAuthMode === cloudAuthMode));
    $("#cloud-display-name-field").hidden = cloudAuthMode !== "signup";
    $("#cloud-display-name").required = cloudAuthMode === "signup";
    $("#cloud-password").autocomplete = cloudAuthMode === "signup" ? "new-password" : "current-password";
    setText("#cloud-auth-submit", cloudAuthMode === "signup" ? "계정 만들기" : "로그인");
  }

  async function createClientFromConfig() {
    const config = readCloudConfig();
    if (!config.supabaseUrl || !config.supabasePublishableKey) return null;
    const module = await import(SUPABASE_MODULE_URL);
    return module.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: `poundwise-cloud-auth-${btoa(config.supabaseUrl).replaceAll("=", "")}`,
      },
    });
  }

  async function initializeCloud() {
    clearTimeout(cloudSyncTimer);
    await removeCloudChannel();
    cloudAuthSubscription?.unsubscribe();
    cloudAuthSubscription = null;
    cloudClient = null;
    cloudSession = null;
    cloudMembers = [];

    if (!hasCloudConfig()) {
      setCloudStatus("local");
      return;
    }

    setCloudStatus("loading");
    try {
      cloudClient = await createClientFromConfig();
      const { data, error } = await cloudClient.auth.getSession();
      if (error) throw error;
      cloudSession = data.session;

      const { data: authListener } = cloudClient.auth.onAuthStateChange((_event, session) => {
        cloudSession = session;
        window.setTimeout(() => handleAuthState(), 0);
      });
      cloudAuthSubscription = authListener.subscription;

      await handleAuthState();
    } catch (error) {
      const message = normalizeCloudError(error);
      state.cloud.lastError = message;
      persistState();
      setCloudStatus("error", message);
    }
  }

  async function handleAuthState() {
    if (!cloudSession?.user) {
      await removeCloudChannel();
      cloudMembers = [];
      setCloudStatus("ready");
      return;
    }

    state.cloud.userId = cloudSession.user.id;
    persistState();
    const householdChange = await loadActiveHousehold();
    if (state.cloud.householdId) {
      await subscribeToHousehold();
      await syncNow({
        silent: true,
        preferRemoteSettings: householdChange.changed,
        preferRemoteTransactions: householdChange.switched,
      });
    } else {
      setCloudStatus("ready");
    }
  }

  async function loadActiveHousehold() {
    const previousHouseholdId = state.cloud.householdId;
    const { data, error } = await cloudClient.rpc("poundwise_get_my_households");
    if (error) throw error;
    const households = Array.isArray(data) ? data : [];
    const active = households.find((household) => household.household_id === state.cloud.householdId) || households[0];
    if (!active) {
      state.cloud = { ...state.cloud, householdId: null, householdName: null, inviteCode: null, role: null, displayName: null };
      cloudMembers = [];
      persistState();
      renderCloudUI();
      return { changed: false, switched: false };
    }

    applyHouseholdResult(active);
    await loadMembers();
    return {
      changed: previousHouseholdId !== active.household_id,
      switched: Boolean(previousHouseholdId && previousHouseholdId !== active.household_id),
    };
  }

  function applyHouseholdResult(result) {
    const household = Array.isArray(result) ? result[0] : result;
    if (!household) return;
    state.cloud = {
      ...state.cloud,
      householdId: household.household_id,
      householdName: household.household_name,
      inviteCode: household.invite_code,
      role: household.member_role,
      displayName: household.display_name,
      userId: cloudSession?.user?.id || state.cloud.userId,
      lastError: null,
    };
    persistState();
    renderAll();
  }

  async function loadMembers() {
    if (!cloudClient || !state.cloud.householdId) return;
    const { data, error } = await cloudClient
      .from("poundwise_household_members")
      .select("user_id,display_name,role,joined_at")
      .eq("household_id", state.cloud.householdId)
      .order("joined_at", { ascending: true });
    if (error) throw error;
    cloudMembers = data || [];
    renderCloudUI();
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    if (!cloudClient) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = $("#cloud-auth-submit");
    setButtonBusy(button, true, cloudAuthMode === "signup" ? "계정 만드는 중…" : "로그인 중…");

    try {
      const email = $("#cloud-email").value.trim();
      const password = $("#cloud-password").value;
      if (cloudAuthMode === "signup") {
        const displayName = $("#cloud-display-name").value.trim();
        const { data, error } = await cloudClient.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName } },
        });
        if (error) throw error;
        if (!data.session) showToast("가입 확인 메일을 보냈어요. 이메일 인증 후 로그인해 주세요.");
        else showToast("계정을 만들고 로그인했어요.");
      } else {
        const { error } = await cloudClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        showToast("클라우드 계정에 로그인했어요.");
      }
      $("#cloud-password").value = "";
    } catch (error) {
      showToast(normalizeCloudError(error), "error");
    } finally {
      setButtonBusy(button, false);
      updateAuthMode(cloudAuthMode);
    }
  }

  async function signOutCloud() {
    if (!cloudClient) return;
    try {
      const { error } = await cloudClient.auth.signOut();
      if (error) throw error;
      await removeCloudChannel();
      cloudSession = null;
      cloudMembers = [];
      showToast("로그아웃했어요. 이 기기의 로컬 데이터는 유지됩니다.");
      renderCloudUI();
    } catch (error) {
      showToast(normalizeCloudError(error), "error");
    }
  }

  async function handleCreateHousehold(event) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity() || !cloudClient) return;
    const button = event.currentTarget.querySelector('button[type="submit"]');
    setButtonBusy(button, true, "만드는 중…");
    try {
      const { data, error } = await cloudClient.rpc("poundwise_create_household", {
        p_name: $("#new-household-name").value.trim(),
        p_display_name: $("#new-household-display-name").value.trim(),
      });
      if (error) throw error;
      applyHouseholdResult(data);
      await loadMembers();
      await subscribeToHousehold();
      await syncNow();
      event.currentTarget.reset();
      showToast("가족 가계부를 만들고 현재 데이터를 동기화했어요.");
    } catch (error) {
      showToast(normalizeCloudError(error), "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function handleJoinHousehold(event) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity() || !cloudClient) return;
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const previousHouseholdId = state.cloud.householdId;
    setButtonBusy(button, true, "참여하는 중…");
    try {
      const { data, error } = await cloudClient.rpc("poundwise_join_household_by_code", {
        p_invite_code: $("#household-invite-code-input").value.trim().toUpperCase(),
        p_display_name: $("#join-household-display-name").value.trim(),
      });
      if (error) throw error;
      applyHouseholdResult(data);
      await loadMembers();
      await subscribeToHousehold();
      const householdChanged = previousHouseholdId !== state.cloud.householdId;
      await syncNow({
        preferRemoteSettings: householdChanged,
        preferRemoteTransactions: Boolean(previousHouseholdId && householdChanged),
      });
      event.currentTarget.reset();
      showToast("가족 가계부에 참여하고 데이터를 합쳤어요.");
    } catch (error) {
      showToast(normalizeCloudError(error), "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  function sharedSettingsPayload() {
    return Object.fromEntries(SHARED_SETTING_KEYS.map((key) => [key, state.settings[key]]));
  }

  function transactionToCloudRow(transaction, deletedAt = null) {
    return {
      id: String(transaction.id),
      household_id: state.cloud.householdId,
      type: transaction.type,
      amount: Number(transaction.amount),
      currency: transaction.currency,
      date: transaction.date,
      category: transaction.category || "Other",
      memo: transaction.memo || "",
      created_by: transaction.createdBy || cloudSession.user.id,
      updated_by: cloudSession.user.id,
      created_at: transaction.createdAt || transaction.updatedAt || new Date().toISOString(),
      updated_at: transaction.updatedAt || transaction.createdAt || new Date().toISOString(),
      deleted_at: deletedAt,
    };
  }

  function transactionFromCloudRow(row) {
    return {
      id: String(row.id),
      type: row.type,
      amount: Number(row.amount),
      currency: row.currency,
      date: row.date,
      category: row.category || "Other",
      memo: row.memo || "",
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function timestamp(value) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async function fetchRemoteState() {
    const [settingsResult, transactionsResult] = await Promise.all([
      cloudClient
        .from("poundwise_household_settings")
        .select("settings,updated_at")
        .eq("household_id", state.cloud.householdId)
        .maybeSingle(),
      cloudClient
        .from("poundwise_transactions")
        .select("id,type,amount,currency,date,category,memo,created_by,created_at,updated_at,deleted_at")
        .eq("household_id", state.cloud.householdId)
        .limit(10000),
    ]);
    if (settingsResult.error) throw settingsResult.error;
    if (transactionsResult.error) throw transactionsResult.error;
    return { settings: settingsResult.data, transactions: transactionsResult.data || [] };
  }

  async function pushNewerLocalChanges(remote, options = {}) {
    const localSettingsTime = timestamp(state.settings.updatedAt);
    const remoteSettingsTime = timestamp(remote.settings?.updated_at);
    if (!remote.settings || (!options.preferRemoteSettings && localSettingsTime > remoteSettingsTime)) {
      const { error } = await cloudClient.from("poundwise_household_settings").upsert({
        household_id: state.cloud.householdId,
        settings: sharedSettingsPayload(),
        updated_at: state.settings.updatedAt || new Date().toISOString(),
        updated_by: cloudSession.user.id,
      }, { onConflict: "household_id" });
      if (error) throw error;
    }

    const remoteMap = new Map(remote.transactions.map((transaction) => [String(transaction.id), transaction]));
    const rowsToPush = [];
    if (!options.preferRemoteTransactions) {
      state.transactions.forEach((transaction) => {
        const remoteTransaction = remoteMap.get(String(transaction.id));
        if (!remoteTransaction || timestamp(transaction.updatedAt) > timestamp(remoteTransaction.updated_at)) {
          rowsToPush.push(transactionToCloudRow(transaction));
        }
      });
      state.deletedTransactions.forEach((transaction) => {
        const remoteTransaction = remoteMap.get(String(transaction.id));
        const deletedAt = transaction.deletedAt || transaction.updatedAt;
        if (!remoteTransaction || timestamp(deletedAt) > timestamp(remoteTransaction.updated_at)) {
          rowsToPush.push(transactionToCloudRow(transaction, deletedAt));
        }
      });
    }

    if (rowsToPush.length) {
      const { error } = await cloudClient.from("poundwise_transactions").upsert(rowsToPush, { onConflict: "id" });
      if (error) throw error;
    }
  }

  function applyCanonicalRemoteState(remote) {
    if (remote.settings?.settings) {
      const shared = Object.fromEntries(
        SHARED_SETTING_KEYS
          .filter((key) => Object.hasOwn(remote.settings.settings, key))
          .map((key) => [key, remote.settings.settings[key]]),
      );
      state.settings = { ...state.settings, ...shared, updatedAt: remote.settings.updated_at };
    }

    state.transactions = remote.transactions
      .filter((transaction) => !transaction.deleted_at)
      .map(transactionFromCloudRow);
    state.deletedTransactions = [];
    state.cloud.lastSyncedAt = new Date().toISOString();
    state.cloud.lastError = null;
    persistState();
    settingsFormDirty = false;
    renderAll();
  }

  async function syncNow(options = {}) {
    if (cloudSyncInProgress || !cloudClient || !cloudSession?.user || !state.cloud?.householdId) return;
    if (!navigator.onLine) {
      setCloudStatus("ready", "오프라인 변경을 이 기기에 저장했어요.");
      return;
    }

    cloudSyncInProgress = true;
    setCloudStatus("syncing", "가족 데이터와 변경 사항을 합치고 있어요.");
    try {
      const remoteBefore = await fetchRemoteState();
      await pushNewerLocalChanges(remoteBefore, options);
      ignoreRealtimeUntil = Date.now() + 1800;
      const canonical = await fetchRemoteState();
      applyCanonicalRemoteState(canonical);
      await loadMembers();
      setCloudStatus("connected", "모든 변경 사항이 동기화됐어요.");
      if (!options.silent) showToast("가족 가계부와 동기화했어요.");
    } catch (error) {
      const message = normalizeCloudError(error);
      state.cloud.lastError = message;
      persistState();
      setCloudStatus("error", message);
      if (!options.silent) showToast(message, "error");
    } finally {
      cloudSyncInProgress = false;
      renderCloudUI();
    }
  }

  function queueSync(delay = SYNC_DEBOUNCE) {
    if (!cloudClient || !cloudSession?.user || !state.cloud?.householdId) return;
    window.clearTimeout(cloudSyncTimer);
    cloudSyncTimer = window.setTimeout(() => syncNow({ silent: true }), delay);
  }

  async function subscribeToHousehold() {
    await removeCloudChannel();
    if (!cloudClient || !state.cloud.householdId) return;
    const scheduleRemotePull = () => {
      if (Date.now() < ignoreRealtimeUntil) return;
      queueSync(350);
    };
    cloudChannel = cloudClient
      .channel(`poundwise-household-${state.cloud.householdId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "poundwise_transactions", filter: `household_id=eq.${state.cloud.householdId}` }, scheduleRemotePull)
      .on("postgres_changes", { event: "*", schema: "public", table: "poundwise_household_settings", filter: `household_id=eq.${state.cloud.householdId}` }, scheduleRemotePull)
      .on("postgres_changes", { event: "*", schema: "public", table: "poundwise_household_members", filter: `household_id=eq.${state.cloud.householdId}` }, () => {
        loadMembers().catch(() => {});
      })
      .subscribe();
  }

  async function removeCloudChannel() {
    if (cloudClient && cloudChannel) {
      await cloudClient.removeChannel(cloudChannel);
    }
    cloudChannel = null;
  }

  async function saveCloudConfiguration(event) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const url = $("#supabase-url-input").value.trim().replace(/\/$/, "");
    const key = $("#supabase-key-input").value.trim();
    if (!/^https:\/\//i.test(url)) {
      showToast("Supabase 프로젝트 URL은 https://로 시작해야 해요.", "error");
      return;
    }
    if (isUnsafeBrowserKey(key)) {
      showToast("secret/service_role 키는 브라우저에 사용할 수 없어요. publishable 또는 anon 키를 입력하세요.", "error");
      return;
    }
    localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify({ supabaseUrl: url, supabasePublishableKey: key }));
    $("#cloud-config-details").open = false;
    showToast("클라우드 연결 정보를 저장했어요.");
    await initializeCloud();
  }

  async function clearCloudConfiguration() {
    cloudAuthSubscription?.unsubscribe();
    cloudAuthSubscription = null;
    try {
      if (cloudClient && cloudSession) await cloudClient.auth.signOut();
    } catch {
      // Local disconnection should still proceed.
    }
    await removeCloudChannel();
    localStorage.removeItem(CLOUD_CONFIG_KEY);
    state.cloud = getDefaultCloudState();
    persistState();
    cloudClient = null;
    cloudSession = null;
    cloudMembers = [];
    renderAll();
    setCloudStatus("local");
    showToast("클라우드 연결을 지웠어요. 로컬 데이터는 유지됩니다.");
  }

  async function copyInviteCode() {
    const code = state.cloud?.inviteCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast("가족 초대 코드를 복사했어요.");
    } catch {
      showToast(`초대 코드: ${code}`);
    }
  }

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function renderInstallState() {
    const card = $("#install-card");
    const button = $("#install-app-button");
    if (!card || !button) return;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isStandalone()) {
      card.classList.add("is-installed");
      setText("#install-card-title", "앱으로 설치됨");
      setText("#install-status-copy", "홈 화면에서 Poundwise를 바로 실행할 수 있어요.");
      button.textContent = "완료";
      button.disabled = true;
    } else if (location.protocol === "file:") {
      setText("#install-status-copy", "설치하려면 README 안내대로 HTTPS 주소에 먼저 배포해 주세요.");
      button.textContent = "안내";
    } else if (ios) {
      setText("#install-status-copy", "Safari 공유 버튼에서 ‘홈 화면에 추가’를 선택하세요.");
      button.textContent = "방법 보기";
    } else {
      setText("#install-status-copy", deferredInstallPrompt ? "지금 홈 화면에 설치할 수 있어요." : "브라우저 메뉴에서 앱 설치를 선택할 수 있어요.");
      button.textContent = "설치";
      button.disabled = false;
    }
  }

  async function installApp() {
    if (isStandalone()) return;
    if (location.protocol === "file:") {
      showToast("핸드폰 설치는 HTTPS 배포 주소에서 가능합니다. README의 배포 단계를 확인해 주세요.");
      return;
    }
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      renderInstallState();
      return;
    }
    if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
      showToast("Safari 하단 공유 버튼 → ‘홈 화면에 추가’를 선택하세요.");
    } else {
      showToast("브라우저 메뉴에서 ‘앱 설치’ 또는 ‘홈 화면에 추가’를 선택하세요.");
    }
  }

  function registerPWA() {
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("./service-worker.js").catch((error) => {
        console.warn("오프라인 앱 등록에 실패했습니다.", error);
      });
    }
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      renderInstallState();
    });
    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      renderInstallState();
      showToast("Poundwise가 홈 화면에 설치됐어요.");
    });
    renderInstallState();
  }

  function bindCloudEvents() {
    $$('[data-cloud-auth-mode]').forEach((button) => button.addEventListener("click", () => updateAuthMode(button.dataset.cloudAuthMode)));
    $("#cloud-auth-form").addEventListener("submit", handleAuthSubmit);
    $("#create-household-form").addEventListener("submit", handleCreateHousehold);
    $("#join-household-form").addEventListener("submit", handleJoinHousehold);
    $("#cloud-config-form").addEventListener("submit", saveCloudConfiguration);
    $("#clear-cloud-config-button").addEventListener("click", clearCloudConfiguration);
    $("#open-cloud-config-button").addEventListener("click", () => {
      $("#cloud-config-details").open = true;
      $("#supabase-url-input").focus();
    });
    $("#cloud-signout-button").addEventListener("click", signOutCloud);
    $("#cloud-signout-before-family").addEventListener("click", signOutCloud);
    $("#sync-now-button").addEventListener("click", () => syncNow());
    $("#copy-invite-code-button").addEventListener("click", copyInviteCode);
    $("#install-app-button").addEventListener("click", installApp);
    $("#household-invite-code-input").addEventListener("input", (event) => {
      event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
    window.addEventListener("online", () => {
      renderCloudUI();
      queueSync(150);
    });
    window.addEventListener("offline", renderCloudUI);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) queueSync(150);
    });
  }

  function initialize() {
    bindCloudEvents();
    updateAuthMode("signin");
    registerPWA();
    renderCloudUI();
    initializeCloud();
    window.setInterval(() => {
      if (!document.hidden && navigator.onLine) queueSync(0);
    }, SYNC_INTERVAL);
  }

  window.PoundwiseCloud = {
    isConnected: () => Boolean(cloudSession?.user && state.cloud?.householdId),
    queueSync,
    syncNow,
  };
  initialize();
})();
