/* LibraMail — Contrôleur principal */
'use strict';
const App = (() => {
  const ENGINE = 'ws://127.0.0.1:47800';
  let ws;
  let reqId = 0;
  let shuttingDown = false;
  const pending = new Map();

  let config = {};
  let accounts = [];
  let view = { type: 'unified' };
  let list;
  let currentConversation = null;
  let currentReadTimer = null;
  let currentMessageToken = 0;
  let currentLabels = [];
  let editingAccountId = null;
  let editingLabelId = null;
  let pendingLabelDeleteId = null;
  let activitySequence = 0;
  let activityEntries = [];
  let unseenActivityCount = 0;
  const activeSyncActivities = new Map();
  const activeMaintenanceActivities = new Map();
  let pendingConfirmAction = null;
  let backupBusy = false;
  let bulkSelection = [];
  let bulkSelectionMeta = { total: 0, allSelected: false };
  let quickLabelContext = null;
  let quickLabelRequestToken = 0;
  let statisticsState = { period: '30d', accountId: '', tab: 'overview' };
  let statisticsData = null;
  let statisticsRequestToken = 0;
  let readerTabs = [];
  let activeReaderTabKey = 'preview';
  let previewReaderRow = null;
  let contactsCache = [];
  let contactGroups = [];
  let contactDirectory = new Map();
  let editingContactId = null;
  let contactAvatarData = '';
  let contactPendingNewGroups = new Set();
  let contactsSearchTimer = null;
  const contactSuggestionState = new Map();
  let externalLinkOpening = false;

  const LABEL_COLORS = [
    '#8b7dd8', '#4f8bd6', '#36a3a0', '#49a86b', '#a8a33a',
    '#d39a3f', '#d66f4f', '#cf5b78', '#9a6cc2', '#687386',
  ];
  const DEFAULT_ACCENTS = { dark: '#A879DA', light: '#4782D6' };
  const ACCENT_PRESETS = [
    { id: 'libra', color: '#A879DA' },
    { id: 'blue', color: '#4F8BD6' },
    { id: 'green', color: '#49A86B' },
    { id: 'purple', color: '#8B7DD8' },
    { id: 'rose', color: '#CF5B78' },
    { id: 'red', color: '#D66F4F' },
  ];

  // ---------- RPC ----------
  function connect() {
    if (shuttingDown) return;
    ws = new WebSocket(ENGINE);
    ws.onopen = async () => {
      setEngine(true);
      try { await boot(); }
      catch (error) { status(`${t('error')} : ${error.message}`); }
    };
    ws.onclose = () => {
      setEngine(false);
      for (const request of pending.values()) request.reject(new Error(t('status.disconnected')));
      pending.clear();
      if (!shuttingDown) setTimeout(connect, 1500);
    };
    ws.onerror = () => setEngine(false);
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.event) return onEvent(message.event, message.data || {});
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      message.ok ? request.resolve(message.result) : request.reject(new Error(message.error));
    };
  }

  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error(t('status.disconnected')));
        return;
      }
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // ---------- Activité et redimensionnement ----------
  function accountLabel(accountId) {
    const account = accounts.find(item => item.id === accountId);
    return account?.displayName || account?.email || t('activity.unknownAccount');
  }

  function syncSourceLabel(source) {
    const key = ['manual', 'timer', 'idle', 'startup'].includes(source) ? source : 'manual';
    return t(`activity.source.${key}`);
  }

  function activityIcon(entry) {
    if (entry.kind === 'mail') return 'fa-solid fa-envelope-circle-check';
    if (entry.state === 'running') return 'fa-solid fa-rotate fa-spin';
    if (entry.state === 'error') return 'fa-solid fa-triangle-exclamation';
    if (entry.state === 'cancelled') return 'fa-solid fa-ban';
    return 'fa-solid fa-check';
  }

  function activityTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString(I18N.locale || 'fr', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function renderActivity() {
    const listElement = document.getElementById('activity-list');
    const emptyElement = document.getElementById('activity-empty');
    if (!listElement || !emptyElement) return;
    listElement.innerHTML = activityEntries.map(entry => `
      <div class="activity-entry ${esc(entry.state || 'info')}">
        <span class="activity-entry-icon"><i class="${activityIcon(entry)}"></i></span>
        <span class="activity-entry-main">
          <span class="activity-entry-title">${esc(entry.title)}</span>
          ${entry.detail ? `<span class="activity-entry-detail">${esc(entry.detail)}</span>` : ''}
        </span>
        ${entry.kind === 'sync' && entry.state === 'running' && entry.accountId ? `
          <button class="activity-stop-entry" type="button"
                  data-stop-sync="${esc(entry.accountId)}" title="${esc(t('activity.stopAccount'))}">
            <i class="fa-solid fa-stop"></i>
          </button>` : ''}
        <time class="activity-entry-time">${esc(activityTime(entry.updatedAt || entry.createdAt))}</time>
      </div>`).join('');
    listElement.querySelectorAll('[data-stop-sync]').forEach(button => {
      button.onclick = event => {
        event.stopPropagation();
        stopSync(button.dataset.stopSync || null);
      };
    });
    emptyElement.classList.toggle('hidden', activityEntries.length > 0);
    listElement.classList.toggle('hidden', activityEntries.length === 0);

    const stopAllButton = document.getElementById('btn-stop-sync');
    if (stopAllButton) stopAllButton.classList.toggle('hidden', activeSyncActivities.size === 0);

    const counter = document.getElementById('activity-count');
    if (counter) {
      counter.textContent = String(Math.min(99, unseenActivityCount));
      counter.classList.toggle('hidden', unseenActivityCount === 0);
    }
  }

  function addActivity({ kind = 'sync', state = 'info', title, detail = '', key = null, accountId = null }) {
    const entry = {
      id: ++activitySequence,
      kind,
      state,
      title,
      detail,
      accountId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    activityEntries.unshift(entry);
    activityEntries = activityEntries.slice(0, 80);
    if (key) activeSyncActivities.set(key, entry.id);
    if (document.getElementById('activity-panel')?.classList.contains('hidden')) unseenActivityCount++;
    renderActivity();
    return entry;
  }

  function updateActivity(id, patch) {
    const entry = activityEntries.find(item => item.id === id);
    if (!entry) return null;
    Object.assign(entry, patch, { updatedAt: Date.now() });
    renderActivity();
    return entry;
  }

  function beginSyncActivity(data) {
    const key = data.accountId || `batch-${Date.now()}`;
    const currentId = activeSyncActivities.get(key);
    const title = t('activity.syncStarted', { account: accountLabel(data.accountId) });
    const detail = t('activity.syncSource', { source: syncSourceLabel(data.source) });
    if (currentId) return updateActivity(currentId, { state: 'running', title, detail, accountId: data.accountId });
    return addActivity({ kind: 'sync', state: 'running', title, detail, key, accountId: data.accountId });
  }

  function updateSyncActivity(data) {
    const key = data.accountId;
    let id = activeSyncActivities.get(key);
    if (!id) id = beginSyncActivity(data)?.id;
    if (!id) return;
    const folder = data.folder || 'INBOX';
    const count = Number(data.count) || 0;
    const total = Number(data.total) || 0;
    let detailKey = 'activity.syncProgress';
    if (data.phase === 'up-to-date') detailKey = 'activity.syncUpToDate';
    else if (data.phase === 'changes') detailKey = 'activity.syncChanges';
    else if (data.phase === 'checking') detailKey = 'activity.syncChecking';
    else if (data.phase === 'download' && total > 0) detailKey = 'activity.syncDownload';
    updateActivity(id, {
      state: 'running',
      detail: t(detailKey, {
        folder,
        count,
        total,
        source: syncSourceLabel(data.source),
      }),
    });
  }

  function finishSyncActivity(data, failed = false) {
    const key = data.accountId;
    let id = activeSyncActivities.get(key);
    if (!id) id = beginSyncActivity(data)?.id;
    if (!id) return;
    const account = accountLabel(data.accountId);
    updateActivity(id, failed ? {
      state: 'error',
      title: t('activity.syncFailed', { account }),
      detail: data.error || t('error'),
    } : {
      state: 'success',
      title: t('activity.syncDone', { account }),
      detail: t('activity.syncResult', {
        added: Number(data.added) || 0,
        changed: Number(data.changed) || 0,
        removed: Number(data.removed) || 0,
        source: syncSourceLabel(data.source),
      }),
    });
    activeSyncActivities.delete(key);
    renderActivity();
  }

  function cancelSyncActivity(data) {
    const key = data.accountId;
    let id = activeSyncActivities.get(key);
    if (!id) id = beginSyncActivity(data)?.id;
    if (!id) return;
    const account = accountLabel(data.accountId);
    updateActivity(id, {
      state: 'cancelled',
      title: t('activity.syncCancelled', { account }),
      detail: t('activity.syncCancelledDetail', { source: syncSourceLabel(data.source) }),
    });
    activeSyncActivities.delete(key);
    renderActivity();
  }

  async function stopSync(accountId = null) {
    try {
      const result = await rpc('sync.cancel', accountId ? { accountId } : {});
      status(t(Number(result?.cancelled) > 0 ? 'status.syncStopping' : 'status.noSyncToStop'),
             Number(result?.cancelled) > 0 ? 'busy' : 'info');
    } catch (error) {
      status(error.message, 'error');
    }
  }

  function maintenanceLabel(kind) {
    return t(kind === 'trash' ? 'trash.folder' : 'spam.folder');
  }

  function beginMaintenanceActivity(data) {
    const key = `maintenance:${data.kind || 'folder'}`;
    const entry = addActivity({
      kind: 'maintenance',
      state: 'running',
      title: t('activity.emptyStarted', { folder: maintenanceLabel(data.kind) }),
      detail: t('activity.emptyCount', { count: Number(data.count) || 0 }),
    });
    activeMaintenanceActivities.set(key, entry.id);
    return entry;
  }

  function finishMaintenanceActivity(data, failed = false) {
    const key = `maintenance:${data.kind || 'folder'}`;
    const id = activeMaintenanceActivities.get(key);
    if (!id) return;
    updateActivity(id, failed ? {
      state: 'error',
      title: t('activity.emptyFailed', { folder: maintenanceLabel(data.kind) }),
      detail: data.error || t('error'),
    } : {
      state: 'success',
      title: t('activity.emptyDone', { folder: maintenanceLabel(data.kind) }),
      detail: t('activity.emptyResult', { count: Number(data.count) || 0 }),
    });
    activeMaintenanceActivities.delete(key);
  }

  function addRetentionActivity(data, failed = false) {
    addActivity({
      kind: 'maintenance',
      state: failed ? 'error' : 'success',
      title: failed
        ? t('activity.retentionFailed', { account: accountLabel(data.accountId) })
        : t('activity.retentionDone', { account: accountLabel(data.accountId) }),
      detail: failed
        ? (data.error || t('error'))
        : t('activity.retentionResult', {
            count: Number(data.count) || 0,
            days: Number(data.days) || 0,
          }),
    });
  }

  function toggleActivityPanel(forceOpen = null) {
    const panel = document.getElementById('activity-panel');
    const button = document.getElementById('btn-activity');
    if (!panel || !button) return;
    const open = forceOpen === null ? panel.classList.contains('hidden') : Boolean(forceOpen);
    panel.classList.toggle('hidden', !open);
    button.classList.toggle('active', open);
    if (open) {
      unseenActivityCount = 0;
      renderActivity();
    }
  }

  function clearCompletedActivity() {
    activityEntries = activityEntries.filter(entry => entry.state === 'running');
    unseenActivityCount = 0;
    renderActivity();
  }

  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value) || minimum));

  function applyPaneDimensions() {
    const app = document.getElementById('app');
    if (!app) return;
    const width = Math.max(1000, app.clientWidth || 1000);
    const sidebarMax = Math.max(180, Math.min(430, width - 680));
    const sidebarWidth = clamp(config.sidebarWidth || 240, 180, sidebarMax);
    app.style.setProperty('--sidebar-width', `${Math.round(sidebarWidth)}px`);

    if (app.dataset.layout === 'horizontal') {
      const availableHeight = Math.max(420, app.clientHeight - 76);
      const listHeight = clamp(config.listPaneHeight || Math.round(availableHeight * .42), 180, Math.max(180, availableHeight - 220));
      app.style.setProperty('--list-height', `${Math.round(listHeight)}px`);
      document.getElementById('resize-list')?.setAttribute('aria-orientation', 'horizontal');
    } else {
      const listMax = Math.max(280, width - sidebarWidth - 350);
      const listWidth = clamp(config.listWidth || 380, 280, Math.min(680, listMax));
      app.style.setProperty('--list-width', `${Math.round(listWidth)}px`);
      document.getElementById('resize-list')?.setAttribute('aria-orientation', 'vertical');
    }
  }

  function persistPaneDimension(key, value) {
    const rounded = Math.round(value);
    config = { ...config, [key]: rounded };
    rpc('config.set', { [key]: rounded }).then(updated => { config = updated; }).catch(() => {});
  }

  function paneDimension(type) {
    const app = document.getElementById('app');
    if (type === 'sidebar') return Number(config.sidebarWidth) || 240;
    if (app.dataset.layout === 'horizontal') return Number(config.listPaneHeight) || 330;
    return Number(config.listWidth) || 380;
  }

  function setPaneDimension(type, value, persist = false) {
    const app = document.getElementById('app');
    const width = Math.max(1000, app.clientWidth || 1000);
    let key;
    let normalized;
    if (type === 'sidebar') {
      key = 'sidebarWidth';
      normalized = clamp(value, 180, Math.max(180, Math.min(430, width - 680)));
    } else if (app.dataset.layout === 'horizontal') {
      key = 'listPaneHeight';
      const availableHeight = Math.max(420, app.clientHeight - 76);
      normalized = clamp(value, 180, Math.max(180, availableHeight - 220));
    } else {
      key = 'listWidth';
      const sidebarWidth = clamp(config.sidebarWidth || 240, 180, Math.max(180, Math.min(430, width - 680)));
      normalized = clamp(value, 280, Math.min(680, Math.max(280, width - sidebarWidth - 350)));
    }
    config = { ...config, [key]: Math.round(normalized) };
    applyPaneDimensions();
    if (persist) persistPaneDimension(key, config[key]);
  }

  function wirePaneResizer(element, type) {
    if (!element) return;
    const start = event => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      const app = document.getElementById('app');
      const horizontalRows = type === 'list' && app.dataset.layout === 'horizontal';
      const startPosition = horizontalRows ? event.clientY : event.clientX;
      const startValue = paneDimension(type);
      element.classList.add('active');
      document.body.classList.add('resizing-panes');
      document.body.classList.toggle('resize-rows', horizontalRows);
      element.setPointerCapture?.(event.pointerId);

      const move = moveEvent => {
        const currentPosition = horizontalRows ? moveEvent.clientY : moveEvent.clientX;
        setPaneDimension(type, startValue + currentPosition - startPosition, false);
      };
      const stop = stopEvent => {
        element.releasePointerCapture?.(stopEvent.pointerId);
        element.removeEventListener('pointermove', move);
        element.removeEventListener('pointerup', stop);
        element.removeEventListener('pointercancel', stop);
        element.classList.remove('active');
        document.body.classList.remove('resizing-panes', 'resize-rows');
        setPaneDimension(type, paneDimension(type), true);
      };
      element.addEventListener('pointermove', move);
      element.addEventListener('pointerup', stop);
      element.addEventListener('pointercancel', stop);
    };
    element.addEventListener('pointerdown', start);
    element.addEventListener('dblclick', () => {
      const horizontalRows = type === 'list' && document.getElementById('app').dataset.layout === 'horizontal';
      setPaneDimension(type, type === 'sidebar' ? 240 : horizontalRows ? 330 : 380, true);
    });
    element.addEventListener('keydown', event => {
      const app = document.getElementById('app');
      const horizontalRows = type === 'list' && app.dataset.layout === 'horizontal';
      const negativeKey = horizontalRows ? 'ArrowUp' : 'ArrowLeft';
      const positiveKey = horizontalRows ? 'ArrowDown' : 'ArrowRight';
      if (![negativeKey, positiveKey, 'Home'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home'
        ? (type === 'sidebar' ? 240 : horizontalRows ? 330 : 380)
        : paneDimension(type) + (event.key === negativeKey ? -20 : 20);
      setPaneDimension(type, next, true);
    });
  }

  function onEvent(event, data) {
    if (event === 'sync.started') {
      beginSyncActivity(data);
      status(t('status.syncStarting', { account: accountLabel(data.accountId) }), 'busy');
    } else if (event === 'sync.progress') {
      updateSyncActivity(data);
      status(t('status.syncingAccount', {
        account: accountLabel(data.accountId),
        folder: data.folder || 'INBOX',
        count: Number(data.count) || 0,
      }), 'busy');
    } else if (event === 'sync.done') {
      finishSyncActivity(data, false);
      status(t('status.syncDone', {
        account: accountLabel(data.accountId),
        added: Number(data.added) || 0,
      }), 'success');
      refresh();
    } else if (event === 'mail.new') {
      addActivity({
        kind: 'mail', state: 'success',
        title: t('activity.newMail', { account: accountLabel(data.accountId) }),
        detail: t('activity.newMailCount', { count: Number(data.added) || 0 }),
      });
      status(t('status.newmailAccount', {
        account: accountLabel(data.accountId),
        count: Number(data.added) || 0,
      }), 'success');
      refresh();
    } else if (event === 'sync.cancelled') {
      cancelSyncActivity(data);
      status(t('status.syncCancelled', { account: accountLabel(data.accountId) }), 'info');
    } else if (event === 'sync.error') {
      finishSyncActivity(data, true);
      status(t('status.syncError', {
        account: accountLabel(data.accountId),
        error: data.error || t('error'),
      }), 'error');
    } else if (event === 'folder.empty.started') {
      beginMaintenanceActivity(data);
      status(t('status.emptyStarting', { folder: maintenanceLabel(data.kind) }), 'busy');
    } else if (event === 'folder.empty.done') {
      finishMaintenanceActivity(data, false);
      status(t('status.emptyDone', {
        folder: maintenanceLabel(data.kind),
        count: Number(data.count) || 0,
      }), 'success');
      refresh();
    } else if (event === 'folder.empty.error') {
      finishMaintenanceActivity(data, true);
      status(t('status.emptyFailed', {
        folder: maintenanceLabel(data.kind),
        error: data.error || t('error'),
      }), 'error');
    } else if (event === 'retention.done') {
      if (Number(data.count) > 0) addRetentionActivity(data, false);
      refresh();
    } else if (event === 'retention.error') {
      addRetentionActivity(data, true);
    } else if (event === 'sent.copy.error') {
      addActivity({
        kind: 'maintenance', state: 'error',
        title: t('activity.sentCopyFailed', { account: accountLabel(data.accountId) }),
        detail: data.error || t('error'),
      });
    } else if (event === 'backup.started') {
      setBackupBusy(true);
      const label = t(data.kind === 'import' ? 'backup.importing' : 'backup.exporting');
      setBackupOperationStatus(label, 'busy');
      setBackupProgress({ label, percent: 0, indeterminate: true, state: 'busy' });
    } else if (event === 'backup.progress') {
      updateBackupProgress(data);
    } else if (event === 'backup.done') {
      const label = t(data.kind === 'import' ? 'backup.importComplete' : 'backup.exportComplete');
      setBackupProgress({ label, percent: 100, detail: '', state: 'success' });
    } else if (event === 'backup.error') {
      setBackupBusy(false);
      setBackupProgress({
        label: t('backup.failed'),
        percent: null,
        detail: data.error || t('error'),
        state: 'error',
      });
      setBackupOperationStatus(`${t('error')} : ${data.error || t('error')}`, 'error');
    } else if (event === 'contacts.changed') {
      refreshContactsCount().catch(() => {});
      refreshContactDirectory().then(() => refresh()).catch(() => refresh());
      if (document.getElementById('contacts-modal')?.classList.contains('open')) {
        loadContacts({ preserveSelection: true }).catch(() => {});
      }
      if (Viewer.current) refreshCurrentCorrespondentContact().catch(() => {});
      if (Number(data.clearedSpam) > 0) {
        status(t('contacts.spamCleared', { count: Number(data.clearedSpam) }), 'success');
        refresh().catch(() => {});
        refreshSpamStats().catch(() => {});
      }
    }
  }

  // ---------- Démarrage ----------
  async function boot() {
    const state = await rpc('config.get');
    config = state.config;
    accounts = state.accounts;

    document.documentElement.dataset.theme = config.theme || 'dark';
    document.getElementById('app').dataset.layout = config.layout || 'vertical';
    applyAccentScheme();
    await I18N.load(config.locale || 'fr');
    applyPaneDimensions();
    applyAppVersion();
    applySidebarSectionStates();
    renderActivity();
    renderReaderTabs();

    await refreshContactDirectory();
    renderSidebar();
    syncListControls();
    await refresh();
    await refreshSpamStats();
    await refreshContactsCount();
    status(t('status.connected'), 'success');

    // Une seule relève est demandée lorsque l'interface est réellement prête.
    // Le moteur protège cette action contre les reconnexions WebSocket.
    rpc('app.ready').catch(error => {
      console.error('[LibraMail] Relève au démarrage :', error);
      status(`${t('error')} : ${error.message}`, 'error');
    });
  }

  // ---------- Panneau latéral ----------
  const SIDEBAR_SECTIONS = {
    accounts: {
      configKey: 'sidebarAccountsCollapsed',
      headerId: 'accounts-section-header',
      buttonId: 'btn-toggle-accounts',
      contentId: 'account-list',
      labelKey: 'accounts',
    },
    labels: {
      configKey: 'sidebarLabelsCollapsed',
      headerId: 'labels-section-header',
      buttonId: 'btn-toggle-labels',
      contentId: 'label-list',
      labelKey: 'labels',
    },
  };

  function applyAppVersion() {
    const rawVersion = String(window.NL_APPVERSION || '0.2.18').replace(/^v/i, '');
    const badge = document.getElementById('app-version');
    if (badge) {
      badge.textContent = `v${rawVersion}`;
      badge.title = t('app.version', { version: rawVersion });
    }
    document.title = `LibraMail ${rawVersion}`;
  }

  function applySidebarSectionState(name) {
    const section = SIDEBAR_SECTIONS[name];
    if (!section) return;
    const collapsed = config[section.configKey] === true;
    const header = document.getElementById(section.headerId);
    const button = document.getElementById(section.buttonId);
    const content = document.getElementById(section.contentId);
    header?.classList.toggle('collapsed', collapsed);
    content?.classList.toggle('collapsed', collapsed);
    button?.setAttribute('aria-expanded', String(!collapsed));
    if (button) {
      const sectionLabel = t(section.labelKey);
      button.title = t(collapsed ? 'sidebar.expand' : 'sidebar.collapse', { section: sectionLabel });
    }
  }

  function applySidebarSectionStates() {
    applySidebarSectionState('accounts');
    applySidebarSectionState('labels');
  }

  async function toggleSidebarSection(name) {
    const section = SIDEBAR_SECTIONS[name];
    if (!section) return;
    const nextCollapsed = config[section.configKey] !== true;
    config[section.configKey] = nextCollapsed;
    applySidebarSectionState(name);
    try {
      config = await rpc('config.set', { [section.configKey]: nextCollapsed });
    } catch (error) {
      config[section.configKey] = !nextCollapsed;
      applySidebarSectionState(name);
      status(`${t('error')} : ${error.message}`, 'error');
    }
  }

  function renderSidebar() {
    const element = document.getElementById('account-list');
    element.innerHTML = '';
    for (const account of accounts) {
      const row = document.createElement('div');
      row.className = 'account-sidebar-row';
      if (view.type === 'account' && String(view.accountId) === String(account.id)) row.classList.add('active');

      const button = document.createElement('button');
      button.className = 'side-item';
      if (view.type === 'account' && String(view.accountId) === String(account.id)) button.classList.add('active');
      button.dataset.view = 'account:' + account.id;
      button.innerHTML = `<span class="account-dot" style="background:${safeColor(account.color)}"></span>
        <span class="account-sidebar-name">${esc(account.displayName || account.email)}</span>
        ${account.id === config.defaultAccountId
          ? `<i class="fa-solid fa-star default-star" title="${esc(t('account.default'))}"></i>`
          : ''}
        <span class="count account-mail-count" data-count="${esc(account.id)}" aria-live="polite">…</span>`;

      const editButton = document.createElement('button');
      editButton.className = 'iconbtn account-edit-btn';
      editButton.type = 'button';
      editButton.dataset.editAccount = account.id;
      editButton.title = t('account.edit');
      editButton.setAttribute('aria-label', t('account.edit'));
      editButton.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>';
      editButton.onclick = event => {
        event.stopPropagation();
        openAccountEditor(account.id);
      };

      row.append(button, editButton);
      element.appendChild(row);
    }
    rpc('labels.list').then(renderLabels).catch(() => {});
  }

  function renderLabels(labels) {
    currentLabels = Array.isArray(labels) ? labels : [];
    const element = document.getElementById('label-list');
    element.innerHTML = '';
    for (const label of currentLabels) {
      const button = document.createElement('button');
      button.className = 'side-item';
      button.dataset.labelId = String(label.id);
      if (view.type === 'label' && String(view.labelId) === String(label.id)) {
        button.classList.add('active');
      }
      const messageCount = Number(label.message_count || 0);
      button.innerHTML = `<span class="account-dot" style="background:${safeColor(label.color)}"></span>
        <span class="label-sidebar-name">${esc(label.name)}</span>
        ${messageCount ? `<span class="count" title="${esc(t('label.messageCount', { count: messageCount }))}">${messageCount}</span>` : ''}`;
      button.onclick = () => {
        closeQuickLabelMenu();
        document.querySelectorAll('.side-item').forEach(item => item.classList.remove('active'));
        button.classList.add('active');
        view = { type: 'label', labelId: label.id };
        document.getElementById('list-title').textContent = label.name;
        clearReader();
        refresh();
      };
      element.appendChild(button);
    }
  }

  // ---------- Liste ----------
  function listParams() {
    const params = {
      folderRole: 'inbox', spam: 0, limit: 500,
      sortBy: config.sortBy || 'date',
      sortDirection: config.sortDirection || 'desc',
    };
    if (view.type === 'spam') {
      delete params.folderRole;
      params.folderRoles = ['inbox', 'junk'];
      params.spam = 1;
    } else if (view.type === 'sent') {
      params.folderRole = 'sent';
      params.spam = null;
    } else if (view.type === 'trash') {
      params.folderRole = 'trash';
      params.spam = null;
    } else if (view.type === 'label') {
      // Une étiquette est transversale : elle peut être appliquée à un message
      // reçu, envoyé, indésirable ou placé dans la corbeille. Ne pas conserver
      // ici le filtre par défaut sur la seule boîte de réception.
      delete params.folderRole;
      params.spam = null;
      params.labelId = view.labelId;
    } else if (view.type === 'account') {
      params.accountId = view.accountId;
    }
    return params;
  }

  function decorateRows(rows) {
    return (rows || []).map(row => ({
      ...row,
      display_mode: row.folder_role === 'sent' ? 'sent' : 'received',
    }));
  }

  function updateFolderActionButton() {
    const button = document.getElementById('btn-empty-folder');
    if (!button) return;
    const supported = view.type === 'spam' || view.type === 'trash';
    button.classList.toggle('hidden', !supported);
    if (!supported) return;
    const trash = view.type === 'trash';
    button.dataset.kind = trash ? 'trash' : 'spam';
    button.querySelector('i').className = trash
      ? 'fa-solid fa-trash-can-arrow-up'
      : 'fa-solid fa-broom';
    button.querySelector('span').textContent = t(trash ? 'trash.empty' : 'spam.empty');
    button.title = t(trash ? 'trash.empty' : 'spam.empty');
  }

  function mailListOptions(preserveListState = false) {
    return {
      groupByDate: config.groupByDate !== false && (config.sortBy || 'date') === 'date',
      preserveExpansion: preserveListState,
      preservePosition: preserveListState,
      preserveActive: preserveListState,
      preserveSelection: preserveListState,
    };
  }

  async function refresh({ preserveListState = false } = {}) {
    if (!preserveListState) closeQuickLabelMenu();
    if (!list || !ws || ws.readyState !== WebSocket.OPEN) return;
    const params = listParams();
    const conversationMode = config.conversationView !== false;
    const result = await rpc(conversationMode ? 'conversations.list' : 'messages.list', params);
    result.rows = decorateRows(result.rows);
    updateFolderActionButton();
    list.setData(result.rows, mailListOptions(preserveListState));

    const counts = result.counts || {};
    document.getElementById('list-sub').textContent = conversationMode
      ? (counts.messages
          ? t('list.conversationCount', {
              conversations: counts.n || 0,
              messages: counts.messages || 0,
              unread: counts.unread || 0,
            })
          : t('list.empty'))
      : (counts.n
          ? t('list.messageCount', { messages: counts.n, unread: counts.unread || 0 })
          : t('list.empty'));

    await refreshSidebarCounts();
  }

  function setCount(id, number) {
    const element = document.getElementById(id);
    if (element) element.textContent = number || '';
  }

  async function refreshSidebarCounts() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const [unified, spamBox, sentBox, trashBox, labels] = await Promise.all([
      rpc('messages.list', { folderRole: 'inbox', spam: 0, limit: 1 }),
      rpc('messages.list', { folderRoles: ['inbox', 'junk'], spam: 1, limit: 1 }),
      rpc('messages.list', { folderRole: 'sent', spam: null, limit: 1 }),
      rpc('messages.list', { folderRole: 'trash', spam: null, limit: 1 }),
      rpc('labels.list'),
    ]);
    // Les compteurs d'étiquettes font partie de l'état courant de la barre
    // latérale. Les laisser figés jusqu'au redémarrage était assez créatif,
    // mais peu pratique.
    renderLabels(labels);
    setCount('count-unified', unified.counts.unread);
    setCount('count-spam', spamBox.counts.n);
    setCount('count-sent', sentBox.counts.n);
    setCount('count-trash', trashBox.counts.n);
    const accountCounts = await Promise.all(accounts.map(async account => {
      try {
        const result = await rpc('messages.list', {
          folderRole: 'inbox', spam: 0, accountId: account.id, limit: 1,
        });
        return { account, counts: result.counts || {} };
      } catch (error) {
        return { account, counts: null, error };
      }
    }));

    for (const { account, counts } of accountCounts) {
      const counter = document.querySelector(`[data-count="${cssEscape(account.id)}"]`);
      if (!counter) continue;
      if (!counts) {
        counter.textContent = '—';
        counter.classList.remove('has-unread');
        counter.title = t('account.countUnavailable');
        continue;
      }
      const unread = Number(counts.unread) || 0;
      const total = Number(counts.n) || 0;
      counter.textContent = `${numberFormat(unread)} / ${numberFormat(total)}`;
      counter.classList.toggle('has-unread', unread > 0);
      counter.title = t('account.messageCounts', { unread: numberFormat(unread), total: numberFormat(total) });
      counter.setAttribute('aria-label', counter.title);
    }
  }

  function updateSearchClearButton() {
    const input = document.getElementById('search-input');
    const button = document.getElementById('btn-clear-search');
    if (!input || !button) return;
    const hasQuery = Boolean(input.value.trim());
    button.classList.toggle('hidden', !hasQuery);
    button.setAttribute('aria-hidden', hasQuery ? 'false' : 'true');
  }

  async function clearSearch({ focus = true } = {}) {
    const input = document.getElementById('search-input');
    if (!input) return;
    input.value = '';
    updateSearchClearButton();
    await refresh();
    if (focus) input.focus();
  }

  async function searchFor(query, { preserveListState = false } = {}) {
    if (!preserveListState) {
      closeQuickLabelMenu();
      clearConversationPanel();
    }
    if (!query.trim()) return refresh({ preserveListState });
    try {
      let rows = await rpc('messages.search', {
        query, limit: 300, sortBy: config.sortBy || 'date', sortDirection: config.sortDirection || 'desc',
      });
      rows = decorateRows(rows);
      list.setData(rows, mailListOptions(preserveListState));
      document.getElementById('list-sub').textContent = t('list.searchCount', { count: rows.length });
    } catch (error) {
      status(`${t('error')} : ${error.message}`);
    }
  }

  async function refreshVisibleList({ preserveListState = false } = {}) {
    const query = document.getElementById('search-input')?.value || '';
    if (query.trim()) return searchFor(query, { preserveListState });
    return refresh({ preserveListState });
  }

  // ---------- Onglets de lecture ----------
  function readerTabKeyForRow(row) {
    const isConversation = Boolean(
      row?.is_thread && !row?.is_thread_child &&
      config.conversationView !== false && Number(row.thread_count || 1) > 1
    );
    return isConversation ? `thread:${row.thread_key}` : `message:${row.id}`;
  }

  function readerTabTitle(row) {
    const subject = String(row?.subject || t('mail.noSubject'))
      .replace(/^\s*((re|fw|fwd|tr|aw|sv)\s*:\s*)+/gi, '')
      .trim();
    return subject || t('mail.noSubject');
  }

  function readerTabIsUnread(tab) {
    if (tab.kind === 'thread') return Number(tab.row?.thread_unread || 0) > 0;
    return !Boolean(tab.row?.seen);
  }

  function renderReaderTabs() {
    const previewButton = document.getElementById('reader-tab-preview');
    const tabList = document.getElementById('reader-tab-list');
    const closeAll = document.getElementById('btn-close-reader-tabs');
    if (!previewButton || !tabList || !closeAll) return;

    const previewActive = activeReaderTabKey === 'preview';
    previewButton.classList.toggle('active', previewActive);
    previewButton.setAttribute('aria-selected', previewActive ? 'true' : 'false');
    previewButton.onclick = () => activateReaderTab('preview');

    tabList.innerHTML = '';
    readerTabs.forEach((tab, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'reader-tab';
      button.classList.toggle('active', tab.key === activeReaderTabKey);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', tab.key === activeReaderTabKey ? 'true' : 'false');
      button.title = tab.title;
      button.innerHTML = `
        <i class="fa-${tab.kind === 'thread' ? 'solid fa-comments' : 'regular fa-envelope'}"></i>
        ${readerTabIsUnread(tab) ? '<span class="reader-tab-unread"></span>' : ''}
        <span class="reader-tab-title">${esc(tab.title)}</span>
        <span class="reader-tab-close" role="button" data-close-tab="${index}" title="${esc(t('tabs.close'))}">
          <i class="fa-solid fa-xmark"></i>
        </span>`;
      button.onclick = event => {
        const closeButton = event.target.closest('[data-close-tab]');
        if (closeButton) {
          event.stopPropagation();
          closeReaderTab(tab.key);
          return;
        }
        activateReaderTab(tab.key);
      };
      button.onauxclick = event => {
        if (event.button === 1) {
          event.preventDefault();
          closeReaderTab(tab.key);
        }
      };
      tabList.appendChild(button);
    });

    closeAll.classList.toggle('hidden', readerTabs.length === 0);
    closeAll.onclick = closeAllReaderTabs;
    const activeElement = tabList.querySelector('.reader-tab.active');
    activeElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function openItemInTab(row) {
    if (!row || row._type === 'group') return;
    const key = readerTabKeyForRow(row);
    let tab = readerTabs.find(item => item.key === key);
    if (!tab) {
      const isThread = key.startsWith('thread:');
      tab = {
        key,
        kind: isThread ? 'thread' : 'message',
        row: { ...row },
        title: readerTabTitle(row),
        activeMessageId: Number(row.id) || null,
      };
      readerTabs.push(tab);
    } else {
      tab.row = { ...tab.row, ...row };
      tab.title = readerTabTitle(row);
    }
    activeReaderTabKey = key;
    renderReaderTabs();
    try {
      await openListItem(tab.row, {
        fromTab: true,
        preferredMessageId: tab.activeMessageId,
      });
    } catch (error) {
      status(`${t('error')} : ${error.message}`, 'error');
    }
  }

  async function activateReaderTab(key) {
    if (key === activeReaderTabKey && key !== 'preview') return;
    activeReaderTabKey = key;
    renderReaderTabs();
    try {
      if (key === 'preview') {
        if (previewReaderRow) await openListItem(previewReaderRow, { fromTab: true });
        else clearReader();
        return;
      }
      const tab = readerTabs.find(item => item.key === key);
      if (!tab) {
        activeReaderTabKey = 'preview';
        renderReaderTabs();
        return;
      }
      await openListItem(tab.row, {
        fromTab: true,
        preferredMessageId: tab.activeMessageId,
      });
    } catch (error) {
      status(`${t('error')} : ${error.message}`, 'error');
      clearReader();
    }
  }

  async function closeReaderTab(key) {
    const index = readerTabs.findIndex(item => item.key === key);
    if (index < 0) return;
    const wasActive = activeReaderTabKey === key;
    readerTabs.splice(index, 1);
    if (!wasActive) {
      renderReaderTabs();
      return;
    }
    const next = readerTabs[Math.min(index, readerTabs.length - 1)] || readerTabs[index - 1] || null;
    activeReaderTabKey = next?.key || 'preview';
    renderReaderTabs();
    if (next) {
      await openListItem(next.row, {
        fromTab: true,
        preferredMessageId: next.activeMessageId,
      });
    } else if (previewReaderRow) await openListItem(previewReaderRow, { fromTab: true });
    else clearReader();
  }

  async function closeAllReaderTabs() {
    readerTabs = [];
    activeReaderTabKey = 'preview';
    renderReaderTabs();
    if (previewReaderRow) await openListItem(previewReaderRow, { fromTab: true });
    else clearReader();
  }

  function updateActiveReaderTab(message) {
    if (activeReaderTabKey === 'preview') return;
    const tab = readerTabs.find(item => item.key === activeReaderTabKey);
    if (!tab) return;
    tab.activeMessageId = Number(message.meta?.id) || tab.activeMessageId;
    tab.title = message.headers?.subject || tab.title || t('mail.noSubject');
    if (tab.kind === 'message') tab.row = { ...tab.row, ...message.meta };
    renderReaderTabs();
  }

  function updateReaderTabsFlag(row, patch) {
    readerTabs.forEach(tab => {
      const sameMessage = tab.kind === 'message' && Number(tab.row?.id) === Number(row?.id);
      const sameThread = tab.kind === 'thread' && tab.row?.thread_key === row?.thread_key;
      if (sameMessage || sameThread) Object.assign(tab.row, patch);
    });
    renderReaderTabs();
  }

  function closeReaderTabsForItems(items) {
    const selected = Array.isArray(items) ? items : [];
    const matchesRow = row => selected.some(item => {
      if (item.type === 'thread') {
        return row?.thread_key === item.threadKey || row?.parent_thread_key === item.threadKey;
      }
      return Number(row?.id) === Number(item.id);
    });
    const shouldClose = tab => matchesRow(tab.row);
    const activeRemoved = readerTabs.some(tab => tab.key === activeReaderTabKey && shouldClose(tab));
    readerTabs = readerTabs.filter(tab => !shouldClose(tab));
    if (previewReaderRow && matchesRow(previewReaderRow)) previewReaderRow = null;
    if (activeRemoved) activeReaderTabKey = 'preview';
    renderReaderTabs();
  }

  // ---------- Lecture / conversations ----------
  async function openListItem(row, { fromTab = false, preferredMessageId = null } = {}) {
    if (!fromTab) {
      previewReaderRow = { ...row };
      activeReaderTabKey = 'preview';
      renderReaderTabs();
    }
    if (row.is_thread_child) {
      await openConversationChild(row);
    } else if (row.is_thread && config.conversationView !== false) {
      // Une conversation d'un seul message ne doit pas se déplier :
      // la ligne de synthèse correspond déjà au message lui-même.
      if (Number(row.thread_count || 1) > 1) {
        await openConversation(row, preferredMessageId);
      } else {
        if (list.isThreadExpanded(row.thread_key)) list.collapseThread(row.thread_key);
        clearConversationPanel();
        await openMessage(row);
      }
    } else {
      clearConversationPanel();
      await openMessage(row);
    }
  }

  async function fetchConversation(threadKey) {
    const thread = await rpc('conversations.read', { threadKey });
    currentConversation = thread;
    return thread.messages || [];
  }

  async function openConversation(row, preferredMessageId = null) {
    const messages = await fetchConversation(row.thread_key);
    if (!messages.length) return;

    // Garde-fou : même si le compteur fourni par la liste est incohérent,
    // un fil réduit à un seul message reste une ligne simple.
    if (messages.length === 1) {
      list.collapseThread(row.thread_key);
      clearConversationPanel();
      await openMessage(messages[0]);
      return;
    }

    const latest = messages[messages.length - 1];
    const target = messages.find(message => Number(message.id) === Number(preferredMessageId)) || latest;
    list.expandThread(row.thread_key, messages, target.id);
    renderConversationPanel(messages, target.id);
    await openMessage(target, { keepConversation: true });
  }

  async function openConversationChild(row) {
    const threadKey = row.parent_thread_key || row.thread_key;
    let messages = currentConversation?.threadKey === threadKey ? currentConversation.messages : null;
    if (!messages) messages = await fetchConversation(threadKey);
    list.expandThread(threadKey, messages, row.id);
    renderConversationPanel(messages, row.id);
    await openMessage(row, { keepConversation: true });
  }

  async function toggleConversation(row) {
    if (Number(row.thread_count || 1) <= 1) {
      list.collapseThread(row.thread_key);
      clearConversationPanel();
      await openMessage(row);
      return;
    }
    if (list.isThreadExpanded(row.thread_key)) {
      list.collapseThread(row.thread_key);
      return;
    }
    await openConversation(row);
  }

  function renderConversationPanel(messages, activeId) {
    const panel = document.getElementById('conversation-panel');
    if (!messages || messages.length <= 1) {
      panel.classList.add('hidden');
      panel.innerHTML = '';
      return;
    }

    panel.classList.remove('hidden');
    panel.innerHTML = `
      <div class="conversation-title">
        <i class="fa-solid fa-comments"></i>
        <span>${esc(t('conversation.title', { count: messages.length }))}</span>
      </div>
      <div class="conversation-items"></div>`;
    const items = panel.querySelector('.conversation-items');

    messages.forEach((message, index) => {
      const button = document.createElement('button');
      button.className = 'conversation-card';
      button.classList.toggle('active', message.id === activeId);
      button.classList.toggle('conversation-reply', index > 0);
      button.classList.toggle('unread', !message.seen);
      const outgoing = message.folder_role === 'sent';
      const correspondentAddress = outgoing ? message.to_addr : message.from_addr;
      const knownContact = contactDirectoryEntry(correspondentAddress);
      const sender = outgoing
        ? (knownContact?.displayName || message.to_addr || t('mail.unknownRecipient'))
        : (message.contact_name || knownContact?.displayName || message.from_name || message.from_addr || t('mail.unknownSender'));
      const account = App.accountEmail(message.account_id);
      button.innerHTML = `
        <span class="conversation-unread-dot"></span>
        <span class="conversation-avatar"></span>
        <span class="conversation-main">
          <span class="conversation-from">${outgoing ? esc(t('mail.to', { recipient: sender })) : esc(sender)}</span>
          ${outgoing ? `<span class="conversation-account">${esc(t('sent.viaAccount', { account }))}</span>` : ''}
          <span class="conversation-snippet">${esc(message.snippet || message.subject || '')}</span>
        </span>
        <span class="conversation-meta">
          <span>${esc(fmtDateTime(message.date))}</span>
          ${message.has_attach ? '<i class="fa-solid fa-paperclip"></i>' : ''}
          ${message.flagged ? '<i class="fa-solid fa-star"></i>' : ''}
        </span>`;
      setAvatarElement(button.querySelector('.conversation-avatar'), {
        avatarData: knownContact?.avatarData || '',
        initials: contactInitials({ displayName: sender, email: correspondentAddress }),
        fallbackColor: colorFrom(correspondentAddress || sender),
      });
      button.onclick = async () => {
        list.setActiveMessage(message.id);
        renderConversationPanel(messages, message.id);
        await openMessage(message, { keepConversation: true });
      };
      items.appendChild(button);
    });
  }

  function clearReadTimer() {
    if (currentReadTimer) clearTimeout(currentReadTimer);
    currentReadTimer = null;
    currentMessageToken++;
  }

  function clearConversationPanel() {
    currentConversation = null;
    const panel = document.getElementById('conversation-panel');
    panel.innerHTML = '';
    panel.classList.add('hidden');
  }

  async function openMessage(row, { keepConversation = false } = {}) {
    closeRemoteContentDialog();
    clearReadTimer();
    if (!keepConversation) clearConversationPanel();
    const token = currentMessageToken;
    const message = await rpc('messages.read', { id: row.id });
    if (token !== currentMessageToken) return;
    updateActiveReaderTab(message);

    if (currentConversation) list.setActiveMessage(row.id);

    document.getElementById('reader-empty').classList.add('hidden');
    document.getElementById('reader-content').classList.remove('hidden');
    document.getElementById('r-subject').textContent = message.headers.subject || t('mail.noSubject');
    document.getElementById('r-from').textContent = message.headers.from || '';
    document.getElementById('r-date').textContent = message.headers.date
      ? ' — ' + new Date(message.headers.date).toLocaleString(I18N.locale)
      : '';
    document.getElementById('r-to').textContent = message.headers.to ? '→ ' + message.headers.to : '';

    const flagIcon = document.getElementById('btn-r-flag').querySelector('i');
    flagIcon.className = message.meta.flagged ? 'fa-solid fa-star' : 'fa-regular fa-star';
    const spamButton = document.getElementById('btn-r-spam');
    spamButton.classList.toggle('hidden', ['sent', 'trash'].includes(message.meta.folder_role));
    spamButton.title = t(message.meta.is_spam ? 'action.notspam' : 'action.spam');
    document.getElementById('btn-r-delete').title = t(
      message.meta.folder_role === 'trash' ? 'trash.deletePermanent' : 'trash.move'
    );
    setReaderSeenButton(Boolean(message.meta.seen));
    updateReaderContactState(message);

    const attachments = document.getElementById('attachments');
    attachments.innerHTML = '';
    attachments.classList.toggle('visible', message.attachments.length > 0);
    for (const attachment of message.attachments) {
      const chip = document.createElement('button');
      chip.className = 'att-chip';
      chip.innerHTML = `<i class="fa-solid fa-paperclip"></i>${esc(attachment.filename)}
        <span class="size">${fmtSize(attachment.size)}</span>`;
      chip.onclick = () => saveAttachment(message.meta.id, attachment);
      attachments.appendChild(chip);
    }
    Viewer.show({ ...message, meta: message.meta });
    scheduleAutoMarkRead(message.meta, token);
  }

  function scheduleAutoMarkRead(meta, token) {
    if (meta.seen || config.autoMarkRead === false) return;
    const seconds = Math.max(0, Math.min(3600, Number(config.markReadDelaySeconds) || 0));
    const run = () => {
      currentReadTimer = null;
      if (token !== currentMessageToken || Viewer.current?.meta?.id !== meta.id) return;
      setSeenState(meta, true, { automatic: true }).catch(error => status(error.message));
    };
    if (seconds === 0) run();
    else currentReadTimer = setTimeout(run, seconds * 1000);
  }

  function setReaderSeenButton(seen) {
    const button = document.getElementById('btn-r-seen');
    button.dataset.seen = seen ? '1' : '0';
    button.title = t(seen ? 'action.markUnread' : 'action.markRead');
    button.querySelector('i').className = seen ? 'fa-solid fa-envelope' : 'fa-regular fa-envelope-open';
  }

  async function setSeenState(row, seen, { automatic = false } = {}) {
    const isThread = Boolean(row.is_thread && !row.is_thread_child);
    if (isThread) {
      await rpc('conversations.setSeen', { threadKey: row.thread_key, value: seen });
      const threadPatch = {
        seen: seen ? 1 : 0,
        thread_unread: seen ? 0 : Number(row.thread_count || 1),
      };
      list.patchThread(row.thread_key, threadPatch);
      updateReaderTabsFlag(row, threadPatch);
      if (currentConversation?.threadKey === row.thread_key) {
        currentConversation.messages.forEach(message => { message.seen = seen ? 1 : 0; });
        list.expandThread(row.thread_key, currentConversation.messages, Viewer.current?.meta?.id);
        renderConversationPanel(currentConversation.messages, Viewer.current?.meta?.id);
      }
    } else {
      await rpc('messages.setFlag', { id: row.id, flag: 'seen', value: seen });
      row.seen = seen ? 1 : 0;
      updateReaderTabsFlag(row, { seen: row.seen });
      if (currentConversation && currentConversation.messages.some(message => message.id === row.id)) {
        const item = currentConversation.messages.find(message => message.id === row.id);
        if (item) item.seen = seen ? 1 : 0;
        list.patchConversationMessage(currentConversation.threadKey, row.id, { seen: seen ? 1 : 0 });
        renderConversationPanel(currentConversation.messages, row.id);
      } else {
        list.patchRow(row.id, { seen: seen ? 1 : 0 });
      }
    }

    if (Viewer.current?.meta?.id === row.id) {
      Viewer.current.meta.seen = seen ? 1 : 0;
      setReaderSeenButton(seen);
    }
    if (!automatic) clearReadTimer();
    refreshSidebarCounts().catch(() => {});
  }

  function clearReader() {
    clearExternalTarget();
    closeRemoteContentDialog();
    clearReadTimer();
    clearConversationPanel();
    if (activeReaderTabKey !== 'preview') {
      activeReaderTabKey = 'preview';
      renderReaderTabs();
    }
    document.getElementById('reader-content').classList.add('hidden');
    document.getElementById('reader-empty').classList.remove('hidden');
    const badge = document.getElementById('r-contact-badge');
    badge?.classList.add('hidden');
    const contactButton = document.getElementById('btn-r-contact');
    if (contactButton) {
      contactButton.dataset.contactId = '';
      contactButton.querySelector('i').className = 'fa-solid fa-user-plus';
    }
  }

  async function saveAttachment(messageId, attachment) {
    const target = await Neutralino.os.showSaveDialog(t('compose.attach'), {
      defaultPath: attachment.filename,
    });
    if (!target) return;
    await rpc('attachments.save', { messageId, index: attachment.index, targetPath: target });
    status('✓ ' + attachment.filename);
  }

  // ---------- Carnet d'adresses ----------
  function contactInitials(contact) {
    const source = contact?.displayName || contact?.firstName || contact?.lastName || contact?.primaryEmail || contact?.email || '?';
    const parts = String(source).trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0]?.slice(0, 2) || '?').toUpperCase();
  }

  function normalizeContactLookupEmail(value) {
    let text = String(value || '').trim();
    const bracket = text.match(/<([^>]+)>/);
    if (bracket) text = bracket[1];
    text = text.split(/[,;]/)[0].trim().toLowerCase();
    return text;
  }

  function contactDirectoryEntry(value) {
    return contactDirectory.get(normalizeContactLookupEmail(value)) || null;
  }

  async function refreshContactDirectory() {
    const rows = await rpc('contacts.directory');
    const next = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const email = normalizeContactLookupEmail(row.email);
      if (email) next.set(email, row);
    }
    contactDirectory = next;
    return next;
  }

  function setAvatarElement(element, { avatarData = '', initials = '?', fallbackColor = 'var(--accent)' } = {}) {
    if (!element) return;
    element.style.backgroundColor = fallbackColor;
    if (avatarData) {
      element.style.backgroundImage = `url("${avatarData}")`;
      element.textContent = '';
      element.classList.add('has-avatar');
    } else {
      element.style.backgroundImage = 'none';
      element.textContent = initials || '?';
      element.classList.remove('has-avatar');
    }
  }

  function updateContactAvatarPreview(contact = {}) {
    const fallbackEmail = contact.primaryEmail || contact.email || document.getElementById('contact-emails')?.value.split(/[\n;,]/)[0] || '';
    const fallbackName = contact.displayName || document.getElementById('contact-display-name')?.value || '';
    setAvatarElement(document.getElementById('contact-editor-avatar'), {
      avatarData: contactAvatarData,
      initials: contactInitials({ ...contact, displayName: fallbackName, email: fallbackEmail }),
      fallbackColor: colorFrom(fallbackEmail || fallbackName || 'contact'),
    });
    document.getElementById('btn-remove-contact-avatar')?.classList.toggle('hidden', !contactAvatarData);
  }

  async function imageBlobToAvatarData(blob) {
    if (!blob || !blob.size) throw new Error(t('contacts.avatarInvalid'));
    if (blob.size > 12 * 1024 * 1024) throw new Error(t('contacts.avatarTooLarge'));
    if (blob.type && !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) {
      throw new Error(t('contacts.avatarInvalid'));
    }

    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(t('contacts.avatarInvalid')));
        img.src = url;
      });
      if (!image.naturalWidth || !image.naturalHeight) throw new Error(t('contacts.avatarInvalid'));

      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(t('contacts.avatarInvalid'));

      const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      context.clearRect(0, 0, size, size);
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);

      const webp = canvas.toDataURL('image/webp', 0.86);
      return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function chooseContactAvatar() {
    const input = document.getElementById('contact-avatar-file');
    if (!input) {
      document.getElementById('contact-form-error').textContent = t('contacts.avatarInvalid');
      return;
    }
    input.value = '';
    input.click();
  }

  async function handleContactAvatarFile(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const errorElement = document.getElementById('contact-form-error');
    errorElement.textContent = '';
    try {
      contactAvatarData = await imageBlobToAvatarData(file);
      updateContactAvatarPreview();
    } catch (error) {
      errorElement.textContent = error.message || t('contacts.avatarInvalid');
    } finally {
      input.value = '';
    }
  }

  function removeContactAvatar() {
    contactAvatarData = '';
    updateContactAvatarPreview();
  }

  async function refreshContactsCount() {
    const result = await rpc('contacts.list', { limit: 1 });
    const count = Number(result.counts?.n) || 0;
    const badge = document.getElementById('contacts-count');
    if (badge) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.toggle('hidden', count === 0);
    }
    return result.counts || { n: count };
  }

  function contactAccountOptions(selected = '') {
    return `<option value="">${esc(t('contacts.noPreferredAccount'))}</option>` + accounts.map(account =>
      `<option value="${esc(account.id)}" ${String(account.id) === String(selected) ? 'selected' : ''}>${esc(account.displayName || account.email)} — ${esc(account.email)}</option>`
    ).join('');
  }

  function renderContactGroupFilter(selected = '') {
    const select = document.getElementById('contacts-group-filter');
    if (!select) return;
    select.innerHTML = `<option value="">${esc(t('contacts.allGroups'))}</option>` + contactGroups.map(group =>
      `<option value="${group.id}" ${String(group.id) === String(selected) ? 'selected' : ''}>${esc(group.name)} (${Number(group.contactCount) || 0})</option>`
    ).join('');
  }

  function normalizeContactGroupNames(groups) {
    if (typeof groups === 'string') groups = groups.split(',');
    return (Array.isArray(groups) ? groups : []).map(group =>
      String(typeof group === 'string' ? group : group?.name || '').trim()
    ).filter(Boolean);
  }

  function renderContactNewGroupChips() {
    const container = document.getElementById('contact-new-group-chips');
    if (!container) return;
    container.innerHTML = '';
    for (const name of contactPendingNewGroups) {
      const chip = document.createElement('span');
      chip.className = 'contact-new-group-chip';
      chip.innerHTML = `<i class="fa-solid fa-folder-plus"></i><span>${esc(name)}</span><button type="button" title="${esc(t('contacts.removePendingGroup'))}"><i class="fa-solid fa-xmark"></i></button>`;
      chip.querySelector('button').onclick = () => {
        contactPendingNewGroups.delete(name);
        renderContactNewGroupChips();
      };
      container.appendChild(chip);
    }
    container.classList.toggle('hidden', contactPendingNewGroups.size === 0);
  }

  function renderContactGroupAssignments(selectedGroups = []) {
    const selectedNames = normalizeContactGroupNames(selectedGroups);
    const selectedLower = new Set(selectedNames.map(name => name.toLowerCase()));
    const existingLower = new Map(contactGroups.map(group => [String(group.name).toLowerCase(), group]));
    contactPendingNewGroups = new Set(selectedNames.filter(name => !existingLower.has(name.toLowerCase())));
    const container = document.getElementById('contact-groups-existing');
    if (!container) return;
    container.dataset.emptyLabel = t('contacts.noGroups');
    container.innerHTML = '';
    for (const group of contactGroups) {
      const label = document.createElement('label');
      label.className = 'contact-group-choice';
      label.innerHTML = `<input type="checkbox" data-contact-group-name="${esc(group.name)}" ${selectedLower.has(String(group.name).toLowerCase()) ? 'checked' : ''}><span class="account-dot" style="background:${safeColor(group.color)}"></span><span>${esc(group.name)}</span>`;
      container.appendChild(label);
    }
    renderContactNewGroupChips();
  }

  function addPendingContactGroup() {
    const input = document.getElementById('contact-new-group');
    const name = String(input?.value || '').trim().slice(0, 80);
    if (!name) return;
    const existing = contactGroups.find(group => String(group.name).toLowerCase() === name.toLowerCase());
    if (existing) {
      const checkbox = [...document.querySelectorAll('[data-contact-group-name]')]
        .find(item => String(item.dataset.contactGroupName).toLowerCase() === name.toLowerCase());
      if (checkbox) checkbox.checked = true;
    } else {
      for (const current of [...contactPendingNewGroups]) {
        if (current.toLowerCase() === name.toLowerCase()) contactPendingNewGroups.delete(current);
      }
      contactPendingNewGroups.add(name);
      renderContactNewGroupChips();
    }
    input.value = '';
    input.focus();
  }

  function selectedContactGroupNames() {
    return [
      ...[...document.querySelectorAll('[data-contact-group-name]:checked')].map(input => input.dataset.contactGroupName),
      ...contactPendingNewGroups,
    ];
  }

  function renderContactsList(result, { preserveSelection = false } = {}) {
    contactsCache = Array.isArray(result.rows) ? result.rows : [];
    contactGroups = Array.isArray(result.groups) ? result.groups : [];
    const selectedGroup = document.getElementById('contacts-group-filter')?.value || '';
    renderContactGroupFilter(selectedGroup);
    const listElement = document.getElementById('contacts-list');
    const empty = document.getElementById('contacts-empty');
    listElement.innerHTML = '';

    for (const contact of contactsCache) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'contact-list-row';
      button.dataset.contactId = contact.id;
      button.classList.toggle('active', Number(editingContactId) === Number(contact.id));
      const metaIcons = [
        contact.favorite ? '<i class="fa-solid fa-star" title="' + esc(t('contacts.favorite')) + '"></i>' : '',
        contact.trusted ? '<i class="fa-solid fa-shield-halved" title="' + esc(t('contacts.trusted')) + '"></i>' : '',
        contact.messageCount ? `<span title="${esc(t('contacts.messageCount', { count: contact.messageCount }))}">${contact.messageCount}</span>` : '',
      ].filter(Boolean).join('');
      button.innerHTML = `
        <span class="contact-list-avatar"></span>
        <span class="contact-list-main"><strong>${esc(contact.displayName || contact.primaryEmail)}</strong><span>${esc(contact.primaryEmail || contact.company || '')}</span></span>
        <span class="contact-list-meta">${metaIcons}</span>`;
      setAvatarElement(button.querySelector('.contact-list-avatar'), {
        avatarData: contact.avatarData || '',
        initials: contactInitials(contact),
        fallbackColor: colorFrom(contact.primaryEmail || contact.displayName),
      });
      button.onclick = () => editContact(contact);
      listElement.appendChild(button);
    }

    listElement.classList.toggle('hidden', contactsCache.length === 0);
    empty.classList.toggle('hidden', contactsCache.length > 0);
    const counts = result.counts || {};
    document.getElementById('contacts-summary').textContent = t('contacts.summary', {
      count: Number(counts.n) || contactsCache.length,
      trusted: Number(counts.trusted) || 0,
      favorites: Number(counts.favorites) || 0,
    });
    const badge = document.getElementById('contacts-count');
    if (badge) {
      const total = Number(counts.n) || 0;
      badge.textContent = total > 99 ? '99+' : String(total);
      badge.classList.toggle('hidden', total === 0);
    }

    if (preserveSelection && editingContactId) {
      const selected = contactsCache.find(contact => Number(contact.id) === Number(editingContactId));
      if (selected) editContact(selected, { focus: false });
    }
  }

  async function loadContacts({ preserveSelection = false } = {}) {
    const query = document.getElementById('contacts-search')?.value || '';
    const groupId = document.getElementById('contacts-group-filter')?.value || null;
    const result = await rpc('contacts.list', { query, groupId, limit: 1000 });
    renderContactsList(result, { preserveSelection });
    return result;
  }

  function resetContactEditor({ seed = null, focus = false } = {}) {
    editingContactId = null;
    document.getElementById('contact-id').value = '';
    document.getElementById('contact-first-name').value = seed?.firstName || '';
    document.getElementById('contact-last-name').value = seed?.lastName || '';
    document.getElementById('contact-display-name').value = seed?.displayName || seed?.name || '';
    document.getElementById('contact-company').value = seed?.company || '';
    document.getElementById('contact-job-title').value = seed?.jobTitle || '';
    document.getElementById('contact-emails').value = seed?.email || '';
    document.getElementById('contact-phone').value = seed?.phone || '';
    document.getElementById('contact-mobile').value = seed?.mobile || '';
    document.getElementById('contact-birthday').value = seed?.birthday || '';
    document.getElementById('contact-preferred-account').innerHTML = contactAccountOptions(seed?.preferredAccountId || '');
    contactAvatarData = seed?.avatarData || '';
    renderContactGroupAssignments(seed?.groups || []);
    document.getElementById('contact-new-group').value = '';
    document.getElementById('contact-address').value = seed?.postalAddress || '';
    document.getElementById('contact-notes').value = seed?.notes || '';
    document.getElementById('contact-trusted').checked = seed?.trusted !== false;
    document.getElementById('contact-favorite').checked = Boolean(seed?.favorite);
    document.getElementById('contact-form-error').textContent = '';
    document.getElementById('btn-delete-contact').classList.add('hidden');
    document.getElementById('contact-editor-heading').textContent = t('contacts.new');
    document.getElementById('contact-editor-subtitle').textContent = seed?.email || '';
    updateContactAvatarPreview(seed || {});
    document.getElementById('contact-editor-empty').classList.add('hidden');
    document.getElementById('contact-editor').classList.remove('hidden');
    document.querySelectorAll('.contact-list-row').forEach(row => row.classList.remove('active'));
    if (focus) setTimeout(() => document.getElementById(seed?.displayName ? 'contact-emails' : 'contact-display-name').focus(), 0);
  }

  function editContact(contact, { focus = false } = {}) {
    if (!contact) return resetContactEditor({ focus });
    editingContactId = Number(contact.id);
    document.getElementById('contact-id').value = contact.id;
    document.getElementById('contact-first-name').value = contact.firstName || '';
    document.getElementById('contact-last-name').value = contact.lastName || '';
    document.getElementById('contact-display-name').value = contact.displayName || '';
    document.getElementById('contact-company').value = contact.company || '';
    document.getElementById('contact-job-title').value = contact.jobTitle || '';
    document.getElementById('contact-emails').value = (contact.emails || []).map(item =>
      item.label ? `${item.email} | ${item.label}` : item.email).join('\n');
    document.getElementById('contact-phone').value = contact.phone || '';
    document.getElementById('contact-mobile').value = contact.mobile || '';
    document.getElementById('contact-birthday').value = contact.birthday || '';
    document.getElementById('contact-preferred-account').innerHTML = contactAccountOptions(contact.preferredAccountId || '');
    contactAvatarData = contact.avatarData || '';
    renderContactGroupAssignments(contact.groups || []);
    document.getElementById('contact-new-group').value = '';
    document.getElementById('contact-address').value = contact.postalAddress || '';
    document.getElementById('contact-notes').value = contact.notes || '';
    document.getElementById('contact-trusted').checked = Boolean(contact.trusted);
    document.getElementById('contact-favorite').checked = Boolean(contact.favorite);
    document.getElementById('contact-form-error').textContent = '';
    document.getElementById('btn-delete-contact').classList.remove('hidden');
    document.getElementById('contact-editor-heading').textContent = contact.displayName || contact.primaryEmail;
    document.getElementById('contact-editor-subtitle').textContent = contact.primaryEmail || contact.company || '';
    updateContactAvatarPreview(contact);
    document.getElementById('contact-editor-empty').classList.add('hidden');
    document.getElementById('contact-editor').classList.remove('hidden');
    document.querySelectorAll('.contact-list-row').forEach(row => {
      row.classList.toggle('active', Number(row.dataset.contactId) === Number(contact.id));
    });
    if (focus) setTimeout(() => document.getElementById('contact-display-name').focus(), 0);
  }

  function parseContactEmails(value) {
    return String(value || '').split(/[\n;,]+/).map((line, index) => {
      const [email, ...labelParts] = line.split('|');
      return { email: email.trim(), label: labelParts.join('|').trim(), isPrimary: index === 0 };
    }).filter(item => item.email);
  }

  function collectContactForm() {
    return {
      displayName: document.getElementById('contact-display-name').value,
      firstName: document.getElementById('contact-first-name').value,
      lastName: document.getElementById('contact-last-name').value,
      company: document.getElementById('contact-company').value,
      jobTitle: document.getElementById('contact-job-title').value,
      emails: parseContactEmails(document.getElementById('contact-emails').value),
      phone: document.getElementById('contact-phone').value,
      mobile: document.getElementById('contact-mobile').value,
      birthday: document.getElementById('contact-birthday').value,
      preferredAccountId: document.getElementById('contact-preferred-account').value,
      groups: selectedContactGroupNames(),
      avatarData: contactAvatarData,
      postalAddress: document.getElementById('contact-address').value,
      notes: document.getElementById('contact-notes').value,
      trusted: document.getElementById('contact-trusted').checked,
      favorite: document.getElementById('contact-favorite').checked,
    };
  }

  async function saveContact() {
    const button = document.getElementById('btn-save-contact');
    const errorElement = document.getElementById('contact-form-error');
    errorElement.textContent = '';
    button.disabled = true;
    const wasEditing = Boolean(editingContactId);
    try {
      const result = await rpc('contacts.save', {
        id: editingContactId || null,
        contact: collectContactForm(),
      });
      editingContactId = result.contact.id;
      await refreshContactDirectory();
      await loadContacts({ preserveSelection: true });
      updateCurrentCorrespondentFromContact(result.contact);
      list.render(true);
      status(t(wasEditing ? 'contacts.saved' : 'contacts.created'), 'success');
      if (Number(result.clearedSpam) > 0) {
        status(t('contacts.spamCleared', { count: result.clearedSpam }), 'success');
        refresh().catch(() => {});
      }
    } catch (error) {
      errorElement.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function deleteContact() {
    if (!editingContactId) return;
    const contact = contactsCache.find(item => Number(item.id) === Number(editingContactId));
    const accepted = await confirmAction({
      title: t('contacts.deleteTitle'),
      message: t('contacts.deleteConfirm', { name: contact?.displayName || contact?.primaryEmail || '' }),
      confirmLabel: t('contacts.delete'),
      icon: 'fa-user-xmark', danger: true,
    });
    if (!accepted) return;
    await rpc('contacts.remove', { id: editingContactId });
    editingContactId = null;
    document.getElementById('contact-editor').classList.add('hidden');
    document.getElementById('contact-editor-empty').classList.remove('hidden');
    await loadContacts();
    if (Viewer.current) refreshCurrentCorrespondentContact().catch(() => {});
    status(t('contacts.deleted'), 'success');
  }

  async function openContacts({ contactId = null, seed = null } = {}) {
    if (!contactId) editingContactId = null;
    openModal('contacts-modal');
    document.getElementById('contact-preferred-account').innerHTML = contactAccountOptions(seed?.preferredAccountId || '');
    const result = await loadContacts();
    if (contactId) {
      const contact = result.rows.find(item => Number(item.id) === Number(contactId))
        || await rpc('contacts.get', { id: contactId });
      if (contact) editContact(contact);
      else resetContactEditor({ seed, focus: true });
    } else if (seed) {
      resetContactEditor({ seed, focus: true });
    } else {
      document.getElementById('contact-editor').classList.add('hidden');
      document.getElementById('contact-editor-empty').classList.remove('hidden');
    }
  }

  function updateCurrentCorrespondentFromContact(contact) {
    if (!Viewer.current?.correspondent?.email || !contact) return;
    const matches = (contact.emails || []).some(item => item.email.toLowerCase() === Viewer.current.correspondent.email.toLowerCase());
    if (!matches) return;
    Viewer.current.correspondent.contact = contact;
    updateReaderContactState(Viewer.current);
  }

  function updateReaderContactState(message) {
    const button = document.getElementById('btn-r-contact');
    const badge = document.getElementById('r-contact-badge');
    const avatar = document.getElementById('r-contact-avatar');
    const contact = message?.correspondent?.contact || null;
    const email = message?.correspondent?.email || '';
    const directoryContact = contactDirectoryEntry(email);
    const displayName = contact?.displayName || directoryContact?.displayName || message?.correspondent?.name || email;
    if (avatar) {
      avatar.classList.toggle('hidden', !displayName && !email);
      setAvatarElement(avatar, {
        avatarData: contact?.avatarData || directoryContact?.avatarData || '',
        initials: contactInitials({ displayName, email }),
        fallbackColor: colorFrom(email || displayName || 'contact'),
      });
    }
    button.dataset.contactId = contact?.id || '';
    button.dataset.email = email;
    button.querySelector('i').className = contact ? 'fa-solid fa-user-pen' : 'fa-solid fa-user-plus';
    button.title = t(contact ? 'contacts.editSender' : 'contacts.addSender');
    if (contact) {
      badge.textContent = contact.displayName || contact.primaryEmail;
      badge.classList.toggle('trusted', Boolean(contact.trusted));
      badge.classList.remove('hidden');
      badge.title = contact.trusted ? t('contacts.trustedContact') : t('contacts.knownContact');
    } else {
      badge.textContent = '';
      badge.classList.add('hidden');
      badge.classList.remove('trusted');
    }
  }

  async function refreshCurrentCorrespondentContact() {
    const message = Viewer.current;
    const email = message?.correspondent?.email;
    if (!message || !email) return;
    message.correspondent.contact = await rpc('contacts.findByEmail', { email });
    updateReaderContactState(message);
  }

  function openCurrentCorrespondentContact() {
    const message = Viewer.current;
    if (!message?.correspondent?.email) return;
    const contact = message.correspondent.contact;
    if (contact) {
      openContacts({ contactId: contact.id });
      return;
    }
    openContacts({ seed: {
      displayName: message.correspondent.name || message.correspondent.email,
      name: message.correspondent.name || '',
      email: message.correspondent.email,
      trusted: true,
      preferredAccountId: message.meta?.account_id || '',
    }});
  }

  function recipientQuery(value) {
    const parts = String(value || '').split(/[,;]/);
    return parts[parts.length - 1].trim().replace(/^.*<([^>]*)>?$/, '$1').trim();
  }

  function insertContactRecipient(input, suggestion) {
    const value = input.value;
    const separatorIndex = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'));
    const prefix = separatorIndex >= 0 ? value.slice(0, separatorIndex + 1) + ' ' : '';
    const label = suggestion.type === 'group'
      ? (suggestion.emails || []).join(', ')
      : suggestion.displayName && suggestion.displayName !== suggestion.email
        ? `${suggestion.displayName} <${suggestion.email}>`
        : suggestion.email;
    input.value = prefix + label + ', ';
    if (suggestion.preferredAccountId
        && accounts.some(account => String(account.id) === String(suggestion.preferredAccountId))) {
      const from = document.getElementById('compose-from');
      from.value = suggestion.preferredAccountId;
      updateComposeSignature({ resetChoice: true });
    }
    hideContactSuggestions(input.id);
    input.focus();
  }

  function suggestionContainer(inputId) {
    const suffix = inputId === 'compose-bcc' ? 'bcc'
      : inputId === 'compose-cc' ? 'cc'
        : 'to';
    return document.getElementById(`compose-${suffix}-suggestions`);
  }

  function hideContactSuggestions(inputId) {
    const container = suggestionContainer(inputId);
    if (container) {
      container.classList.add('hidden');
      container.innerHTML = '';
    }
    const state = contactSuggestionState.get(inputId);
    if (state) state.index = -1;
  }

  function renderContactSuggestions(input, rows) {
    const container = suggestionContainer(input.id);
    const state = contactSuggestionState.get(input.id) || { rows: [], index: -1, timer: null };
    state.rows = rows;
    state.index = -1;
    contactSuggestionState.set(input.id, state);
    container.innerHTML = '';
    if (!rows.length) return hideContactSuggestions(input.id);
    rows.forEach((row, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'contact-suggestion';
      button.dataset.suggestionIndex = index;
      const group = row.type === 'group';
      button.innerHTML = `
        <span class="contact-suggestion-avatar">${group ? '<i class="fa-solid fa-user-group"></i>' : ''}</span>
        <span class="contact-suggestion-main"><strong>${esc(row.displayName || row.email)}</strong><span>${group ? esc(t('contacts.groupRecipients', { count: row.emails?.length || 0 })) : esc(row.email) + (row.company ? ' · ' + esc(row.company) : '')}</span></span>
        <span class="contact-suggestion-icons">${row.favorite ? '<i class="fa-solid fa-star"></i>' : ''}${row.trusted ? '<i class="fa-solid fa-shield-halved"></i>' : ''}</span>`;
      if (group) {
        button.querySelector('.contact-suggestion-avatar').style.backgroundColor = safeColor(row.color);
      } else {
        setAvatarElement(button.querySelector('.contact-suggestion-avatar'), {
          avatarData: row.avatarData || '',
          initials: contactInitials(row),
          fallbackColor: colorFrom(row.email),
        });
      }
      button.onmousedown = event => event.preventDefault();
      button.onclick = () => insertContactRecipient(input, row);
      container.appendChild(button);
    });
    container.classList.remove('hidden');
  }

  function updateSuggestionHighlight(inputId) {
    const state = contactSuggestionState.get(inputId);
    const container = suggestionContainer(inputId);
    if (!state || !container) return;
    container.querySelectorAll('.contact-suggestion').forEach((button, index) => {
      button.classList.toggle('active', index === state.index);
      if (index === state.index) button.scrollIntoView({ block: 'nearest' });
    });
  }

  function wireContactAutocomplete(inputId) {
    const input = document.getElementById(inputId);
    const state = { rows: [], index: -1, timer: null };
    contactSuggestionState.set(inputId, state);
    input.addEventListener('input', () => {
      clearTimeout(state.timer);
      const query = recipientQuery(input.value);
      if (query.length < 1) return hideContactSuggestions(inputId);
      state.timer = setTimeout(async () => {
        try {
          const rows = await rpc('contacts.suggest', { query, limit: 12 });
          if (recipientQuery(input.value) === query) renderContactSuggestions(input, rows);
        } catch { hideContactSuggestions(inputId); }
      }, 150);
    });
    input.addEventListener('keydown', event => {
      const container = suggestionContainer(inputId);
      if (container.classList.contains('hidden') || !state.rows.length) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault(); state.index = (state.index + 1) % state.rows.length; updateSuggestionHighlight(inputId);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault(); state.index = (state.index - 1 + state.rows.length) % state.rows.length; updateSuggestionHighlight(inputId);
      } else if (event.key === 'Enter' && state.index >= 0) {
        event.preventDefault(); insertContactRecipient(input, state.rows[state.index]);
      } else if (event.key === 'Escape') {
        hideContactSuggestions(inputId);
      }
    });
    input.addEventListener('blur', () => setTimeout(() => hideContactSuggestions(inputId), 160));
  }

  // ---------- Confirmations et actions de dossier ----------
  function messageParty(name, address) {
    const cleanName = String(name || '').trim();
    const cleanAddress = String(address || '').trim();
    if (cleanName && cleanAddress && !cleanName.toLowerCase().includes(cleanAddress.toLowerCase())) {
      return `${cleanName} <${cleanAddress}>`;
    }
    return cleanName || cleanAddress;
  }

  function deletionDetailsFromRow(row) {
    if (!row) return null;
    const isThread = Boolean(row.is_thread && !row.is_thread_child);
    const outgoing = row.folder_role === 'sent' || row.display_mode === 'sent';
    const account = accounts.find(item => item.id === row.account_id);
    let correspondent = '';
    let correspondentLabel = '';

    if (isThread && row.participants) {
      correspondent = row.participants;
      correspondentLabel = t('trash.detailParticipants');
    } else if (outgoing) {
      correspondent = String(row.to_addr || '').trim();
      correspondentLabel = t('trash.detailTo');
    } else {
      correspondent = messageParty(row.contact_name || row.from_name, row.from_addr);
      correspondentLabel = t('trash.detailFrom');
    }

    return {
      kind: isThread ? 'conversation' : 'message',
      count: isThread ? Number(row.thread_count || 1) : 1,
      subject: String(row.subject || '').trim() || t('mail.noSubject'),
      correspondent,
      correspondentLabel,
      date: row.date ? fmtDateTime(row.date) : '',
      account: account?.displayName || account?.email || '',
    };
  }

  function renderConfirmActionDetails(details) {
    const box = document.getElementById('confirm-action-details');
    if (!box) return;
    if (!details) {
      box.innerHTML = '';
      box.className = 'confirm-action-details hidden';
      return;
    }

    if (details.kind === 'link') {
      const rows = [];
      if (details.domain) rows.push([t('link.domain'), details.domain]);
      if (details.protocol) rows.push([t('link.protocol'), details.protocol]);
      if (details.displayText && details.displayText !== details.url) {
        rows.push([t('link.displayedText'), details.displayText]);
      }
      box.className = `confirm-action-details link-details${details.suspicious ? ' suspicious' : ''}`;
      box.innerHTML = `
        <div class="confirm-action-details-heading">
          <i class="fa-solid fa-arrow-up-right-from-square"></i>
          <span>${esc(t('link.destination'))}</span>
        </div>
        <div class="confirm-action-link-url" title="${esc(details.url)}">${esc(details.url)}</div>
        ${rows.length ? `<dl>${rows.map(([label, value]) => `
          <div><dt>${esc(label)}</dt><dd title="${esc(value)}">${esc(value)}</dd></div>`).join('')}</dl>` : ''}
        ${details.suspicious ? `<div class="confirm-action-link-warning">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <span>${esc(details.warning || t('link.suspicious'))}</span>
        </div>` : ''}`;
      return;
    }

    const heading = details.kind === 'conversation'
      ? t('trash.affectedConversation', { count: details.count || 1 })
      : t('trash.affectedMessage');
    const rows = [];
    if (details.correspondent) rows.push([details.correspondentLabel || t('trash.detailFrom'), details.correspondent]);
    if (details.date) rows.push([t('trash.detailDate'), details.date]);
    if (details.account) rows.push([t('trash.detailAccount'), details.account]);

    box.className = 'confirm-action-details';
    box.innerHTML = `
      <div class="confirm-action-details-heading">
        <i class="fa-regular ${details.kind === 'conversation' ? 'fa-comments' : 'fa-envelope'}"></i>
        <span>${esc(heading)}</span>
      </div>
      <div class="confirm-action-details-subject" title="${esc(details.subject)}">${esc(details.subject)}</div>
      ${rows.length ? `<dl>${rows.map(([label, value]) => `
        <div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>` : ''}`;
  }

  function confirmAction({
    title,
    message,
    confirmLabel,
    icon = 'fa-triangle-exclamation',
    danger = true,
    note = t('trash.serverNote'),
    details = null,
  }) {
    return new Promise(resolve => {
      pendingConfirmAction = resolve;
      document.getElementById('confirm-action-title').textContent = title;
      document.getElementById('confirm-action-message').textContent = message;
      document.getElementById('confirm-action-icon').className = `fa-solid ${icon}`;
      renderConfirmActionDetails(details);
      const noteBox = document.getElementById('confirm-action-note');
      const noteText = document.getElementById('confirm-action-note-text');
      if (noteBox && noteText) {
        noteText.textContent = note || '';
        noteBox.classList.toggle('hidden', !note);
      }
      const button = document.getElementById('btn-confirm-action');
      button.classList.toggle('danger', danger);
      button.classList.toggle('primary', !danger);
      button.querySelector('span').textContent = confirmLabel;
      openModal('confirm-action-modal');
    });
  }

  function resolveConfirmAction(accepted) {
    const resolve = pendingConfirmAction;
    pendingConfirmAction = null;
    document.getElementById('confirm-action-modal').classList.remove('open');
    if (resolve) resolve(Boolean(accepted));
  }

  async function emptyCurrentFolder() {
    if (!['spam', 'trash'].includes(view.type)) return;
    const trash = view.type === 'trash';
    const accepted = await confirmAction({
      title: t(trash ? 'trash.emptyTitle' : 'spam.emptyTitle'),
      message: t(trash ? 'trash.emptyConfirm' : 'spam.emptyConfirm'),
      confirmLabel: t(trash ? 'trash.empty' : 'spam.empty'),
      icon: trash ? 'fa-trash-can' : 'fa-broom',
      danger: true,
    });
    if (!accepted) return;
    try {
      await rpc(trash ? 'trash.empty' : 'spam.empty');
      clearReader();
      await refresh();
      await refreshSpamStats();
    } catch (error) {
      status(`${t('error')} : ${error.message}`, 'error');
    }
  }

  // ---------- Actions ----------
  async function quickAction(row, action, sourceElement = null) {
    if (action !== 'label') closeQuickLabelMenu();
    if (action === 'toggle-thread') {
      await toggleConversation(row);
    } else if (action === 'seen') {
      const unread = row.is_thread ? Number(row.thread_unread) > 0 : !row.seen;
      await setSeenState(row, unread);
    } else if (action === 'delete') {
      const permanent = row.folder_role === 'trash';
      const accepted = await confirmAction({
        title: t(permanent ? 'trash.deleteTitle' : 'trash.moveTitle'),
        message: t(permanent ? 'trash.deleteMessage' : 'trash.moveMessage'),
        confirmLabel: t(permanent ? 'trash.deletePermanent' : 'trash.move'),
        icon: 'fa-trash-can',
        danger: permanent,
        details: deletionDetailsFromRow(row),
      });
      if (!accepted) return;
      const deletedItems = [selectionItemFromRow(row)];
      await rpc('messages.batchDelete', { items: deletedItems });
      closeReaderTabsForItems(deletedItems);
      clearReader();
      await refreshVisibleList({ preserveListState: true });
    } else if (action === 'label') {
      await toggleQuickLabelMenu(row, sourceElement);
    } else if (action === 'spam') {
      const result = await rpc('messages.batchMarkSpam', {
        items: [selectionItemFromRow(row)],
        isSpam: view.type !== 'spam',
      });
      if (!Number(result.processed) && result.errors?.length) {
        status(`${t('error')} : ${result.errors[0].error}`, 'error');
        return;
      }
      clearReader();
      await refresh();
      await refreshSpamStats();
    } else if (action === 'flag') {
      const value = row.flagged ? 0 : 1;
      if (row.is_thread && !row.is_thread_child) {
        await rpc('messages.batchSetFlag', {
          items: [selectionItemFromRow(row)], flag: 'flagged', value: Boolean(value),
        });
        list.patchThread(row.thread_key, { flagged: value });
      } else {
        await rpc('messages.setFlag', { id: row.id, flag: 'flagged', value: Boolean(value) });
        list.patchRow(row.id, { flagged: value });
      }
      updateReaderTabsFlag(row, { flagged: value });
      if (Viewer.current?.meta?.id === row.id) {
        Viewer.current.meta.flagged = value;
        document.getElementById('btn-r-flag').querySelector('i').className =
          value ? 'fa-solid fa-star' : 'fa-regular fa-star';
      }
    } else if (action === 'reply') {
      openCompose(row, 'reply');
    } else if (action === 'reply-all') {
      openCompose(row, 'reply-all');
    }
  }

  // ---------- Sélection multiple ----------
  function selectionItemFromRow(row) {
    const isThread = Boolean(row?.is_thread && !row?.is_thread_child);
    return {
      type: isThread ? 'thread' : 'message',
      id: row?.id,
      threadKey: isThread ? row.thread_key : null,
      folderRole: row?.folder_role || '',
      isSpam: Boolean(row?.is_spam),
      seen: isThread ? Number(row?.thread_unread || 0) === 0 : Boolean(row?.seen),
      flagged: Boolean(row?.flagged),
      count: isThread ? Number(row?.thread_count || 1) : 1,
    };
  }

  function selectionPayload(items = bulkSelection) {
    return (items || []).map(item => ({
      type: item.type,
      id: Number(item.id),
      threadKey: item.threadKey || undefined,
    }));
  }

  function closeBulkLabelMenu() {
    document.getElementById('bulk-label-menu')?.classList.add('hidden');
  }

  function closeQuickLabelMenu() {
    quickLabelRequestToken += 1;
    quickLabelContext = null;
    const menu = document.getElementById('quick-label-menu');
    if (!menu) return;
    menu.classList.add('hidden');
    menu.innerHTML = '';
    menu.style.removeProperty('left');
    menu.style.removeProperty('top');
  }

  function quickLabelItemKey(item) {
    return item?.type === 'thread'
      ? `thread:${item.threadKey || ''}`
      : `message:${item?.id || ''}`;
  }

  function positionQuickLabelMenu(anchor) {
    const menu = document.getElementById('quick-label-menu');
    if (!menu || menu.classList.contains('hidden') || !anchor?.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const width = Math.max(220, Math.min(menu.offsetWidth || 220, window.innerWidth - margin * 2));
    const height = Math.min(menu.scrollHeight || 300, 300);
    let left = rect.right - width;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    let top = rect.bottom + 5;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 5);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  async function renderQuickLabelMenu(context, token) {
    const menu = document.getElementById('quick-label-menu');
    const labels = await rpc('labels.selectionState', { items: selectionPayload([context.item]) });
    if (token !== quickLabelRequestToken || quickLabelContext !== context) return;

    menu.innerHTML = '';
    if (!labels.length) {
      menu.innerHTML = `<div class="empty-hint">${esc(t('selection.noLabels'))}</div>`;
      positionQuickLabelMenu(context.anchor);
      return;
    }

    for (const label of labels) {
      const applied = Number(label.applied_count) > 0;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'side-item';
      button.setAttribute('role', 'menuitemcheckbox');
      button.setAttribute('aria-checked', applied ? 'true' : 'false');
      button.innerHTML = `
        <span class="account-dot" style="background:${safeColor(label.color)}"></span>
        <span style="overflow:hidden;text-overflow:ellipsis">${esc(label.name)}</span>
        <span class="label-selection-state ${applied ? 'all' : ''}">
          <i class="fa-solid ${applied ? 'fa-check' : 'fa-plus'}"></i>
        </span>`;
      button.title = t(applied ? 'selection.removeLabel' : 'selection.addLabel', { label: label.name });
      button.onclick = async event => {
        event.stopPropagation();
        if (quickLabelContext !== context) return;
        button.disabled = true;
        try {
          const result = await rpc('labels.batchSet', {
            items: selectionPayload([context.item]),
            labelId: label.id,
            applied: !applied,
          });
          closeQuickLabelMenu();
          status(t('selection.labelProcessed', { count: result.processed || 0 }), 'success');
          renderLabels(await rpc('labels.list'));
          await refreshVisibleList({ preserveListState: true });
        } catch (error) {
          status(`${t('error')} : ${error.message}`, 'error');
          button.disabled = false;
        }
      };
      menu.appendChild(button);
    }
    positionQuickLabelMenu(context.anchor);
  }

  async function toggleQuickLabelMenu(row, anchor) {
    if (!row || !anchor) return;
    const item = selectionItemFromRow(row);
    const key = quickLabelItemKey(item);
    const menu = document.getElementById('quick-label-menu');
    if (quickLabelContext?.key === key && !menu.classList.contains('hidden')) {
      closeQuickLabelMenu();
      return;
    }

    closeBulkLabelMenu();
    document.getElementById('label-menu')?.classList.add('hidden');
    const token = ++quickLabelRequestToken;
    const context = { key, item, anchor };
    quickLabelContext = context;
    menu.innerHTML = `<div class="empty-hint"><i class="fa-solid fa-rotate fa-spin"></i> ${esc(t('selection.loadingLabels'))}</div>`;
    menu.classList.remove('hidden');
    positionQuickLabelMenu(anchor);
    try {
      await renderQuickLabelMenu(context, token);
    } catch (error) {
      if (token !== quickLabelRequestToken || quickLabelContext !== context) return;
      menu.innerHTML = `<div class="empty-hint">${esc(error.message)}</div>`;
      positionQuickLabelMenu(anchor);
    }
  }

  function updateBulkSelection(items, meta = {}) {
    bulkSelection = Array.isArray(items) ? items : [];
    bulkSelectionMeta = {
      total: Number(meta.total) || 0,
      allSelected: Boolean(meta.allSelected),
    };

    const count = bulkSelection.length;
    const messageCount = bulkSelection.reduce((total, item) => total + Math.max(1, Number(item.count) || 1), 0);
    const toolbar = document.getElementById('bulk-actions');
    toolbar.classList.toggle('hidden', count === 0);
    const bulkCount = document.getElementById('bulk-count');
    bulkCount.textContent = count ? t('selection.count', { count }) : '0';
    bulkCount.title = count ? t('selection.countDetails', { count, messages: messageCount }) : '';

    const selectAll = document.getElementById('btn-select-all');
    const selectIcon = selectAll.querySelector('i');
    selectAll.classList.toggle('active', count > 0);
    selectAll.setAttribute('aria-pressed', bulkSelectionMeta.allSelected ? 'true' : 'false');
    selectIcon.className = bulkSelectionMeta.allSelected
      ? 'fa-solid fa-square-check'
      : count > 0
        ? 'fa-solid fa-square-minus'
        : 'fa-regular fa-square';
    selectAll.title = t(bulkSelectionMeta.allSelected ? 'selection.clearAll' : 'selection.selectAll');

    if (!count) {
      closeBulkLabelMenu();
      return;
    }

    const allFlagged = bulkSelection.every(item => item.flagged);
    const flagButton = document.getElementById('btn-bulk-flag');
    flagButton.dataset.value = allFlagged ? '0' : '1';
    flagButton.querySelector('i').className = allFlagged ? 'fa-solid fa-star' : 'fa-regular fa-star';
    flagButton.title = t(allFlagged ? 'selection.unflag' : 'selection.flag');

    const eligibleSpam = bulkSelection.filter(item => !['sent', 'trash'].includes(item.folderRole));
    const spamButton = document.getElementById('btn-bulk-spam');
    const removeSpam = eligibleSpam.length > 0 && eligibleSpam.every(item => item.isSpam);
    spamButton.disabled = eligibleSpam.length === 0;
    spamButton.dataset.isSpam = removeSpam ? '0' : '1';
    spamButton.querySelector('i').className = removeSpam ? 'fa-solid fa-shield' : 'fa-solid fa-ban';
    spamButton.title = t(removeSpam ? 'action.notspam' : 'action.spam');

    const deleteButton = document.getElementById('btn-bulk-delete');
    const permanent = bulkSelection.every(item => item.folderRole === 'trash');
    deleteButton.title = t(permanent ? 'trash.deletePermanent' : 'selection.delete');
  }

  async function runBulkFlag(flag, value) {
    if (!bulkSelection.length) return;
    try {
      const result = await rpc('messages.batchSetFlag', {
        items: selectionPayload(), flag, value: Boolean(value),
      });
      const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
      status(errorCount
        ? t('contacts.spamSkippedTrusted', { processed: result.processed || 0, skipped: errorCount })
        : t('selection.processed', { count: result.processed || 0 }),
      errorCount ? 'error' : 'success');
      clearReader();
      await refresh();
    } catch (error) {
      status(`${t('error')} : ${error.message}`, 'error');
    }
  }

  async function runBulkDelete() {
    if (!bulkSelection.length) return;
    const selectedCount = bulkSelection.length;
    const hasPermanent = bulkSelection.some(item => item.folderRole === 'trash');
    const accepted = await confirmAction({
      title: t('selection.deleteTitle', { count: selectedCount }),
      message: t(hasPermanent ? 'selection.deleteMixedMessage' : 'selection.deleteMessage', { count: selectedCount }),
      confirmLabel: t('selection.delete'),
      icon: 'fa-trash-can',
      danger: true,
    });
    if (!accepted) return;
    try {
      const deletedItems = selectionPayload();
      const result = await rpc('messages.batchDelete', { items: deletedItems });
      closeReaderTabsForItems(deletedItems);
      const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
      status(errorCount
        ? t('contacts.spamSkippedTrusted', { processed: result.processed || 0, skipped: errorCount })
        : t('selection.processed', { count: result.processed || 0 }),
      errorCount ? 'error' : 'success');
      clearReader();
      await refreshVisibleList({ preserveListState: true });
    } catch (error) {
      status(`${t('error')} : ${error.message}`, 'error');
    }
  }

  async function runBulkSpam() {
    if (!bulkSelection.length) return;
    const button = document.getElementById('btn-bulk-spam');
    if (button.disabled) return;
    const isSpam = button.dataset.isSpam !== '0';
    const accepted = await confirmAction({
      title: t(isSpam ? 'selection.spamTitle' : 'selection.notSpamTitle'),
      message: t(isSpam ? 'selection.spamMessage' : 'selection.notSpamMessage', { count: bulkSelection.length }),
      confirmLabel: t(isSpam ? 'action.spam' : 'action.notspam'),
      icon: isSpam ? 'fa-ban' : 'fa-shield',
      danger: isSpam,
    });
    if (!accepted) return;
    try {
      const result = await rpc('messages.batchMarkSpam', {
        items: selectionPayload(), isSpam,
      });
      const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
      status(errorCount
        ? t('contacts.spamSkippedTrusted', { processed: result.processed || 0, skipped: errorCount })
        : t('selection.processed', { count: result.processed || 0 }),
      errorCount ? 'error' : 'success');
      clearReader();
      await refresh();
      await refreshSpamStats();
    } catch (error) {
      status(`${t('error')} : ${error.message}`, 'error');
    }
  }

  async function renderBulkLabelMenu() {
    const menu = document.getElementById('bulk-label-menu');
    menu.innerHTML = `<div class="empty-hint"><i class="fa-solid fa-rotate fa-spin"></i> ${esc(t('selection.loadingLabels'))}</div>`;
    const labels = await rpc('labels.selectionState', { items: selectionPayload() });
    menu.innerHTML = '';
    if (!labels.length) {
      menu.innerHTML = `<div class="empty-hint">${esc(t('selection.noLabels'))}</div>`;
      return;
    }
    for (const label of labels) {
      const applied = Number(label.applied_count) || 0;
      const total = Number(label.selected_count) || 0;
      const all = total > 0 && applied === total;
      const partial = applied > 0 && applied < total;
      const button = document.createElement('button');
      button.className = 'side-item';
      button.innerHTML = `
        <span class="account-dot" style="background:${safeColor(label.color)}"></span>
        <span style="overflow:hidden;text-overflow:ellipsis">${esc(label.name)}</span>
        <span class="label-selection-state ${all ? 'all' : partial ? 'partial' : ''}">
          <i class="fa-solid ${all ? 'fa-check' : partial ? 'fa-minus' : 'fa-plus'}"></i>
        </span>`;
      button.title = t(all ? 'selection.removeLabel' : 'selection.addLabel', { label: label.name });
      button.onclick = async event => {
        event.stopPropagation();
        try {
          const result = await rpc('labels.batchSet', {
            items: selectionPayload(),
            labelId: label.id,
            applied: !all,
          });
          closeBulkLabelMenu();
          status(t('selection.labelProcessed', { count: result.processed || 0 }), 'success');
          renderLabels(await rpc('labels.list'));
          await refreshVisibleList({ preserveListState: true });
        } catch (error) {
          status(`${t('error')} : ${error.message}`, 'error');
        }
      };
      menu.appendChild(button);
    }
  }

  async function toggleBulkLabelMenu(event) {
    event.stopPropagation();
    if (!bulkSelection.length) return;
    closeQuickLabelMenu();
    const menu = document.getElementById('bulk-label-menu');
    if (menu.classList.contains('hidden')) {
      menu.classList.remove('hidden');
      try { await renderBulkLabelMenu(); }
      catch (error) {
        menu.innerHTML = `<div class="empty-hint">${esc(error.message)}</div>`;
      }
    } else {
      menu.classList.add('hidden');
    }
  }

  // ---------- Étiquettes ----------
  function normalizeLabelColor(value) {
    const raw = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(raw)) {
      return '#' + raw.slice(1).split('').map(character => character + character).join('').toLowerCase();
    }
    return null;
  }

  function setLabelColor(value) {
    const color = normalizeLabelColor(value) || '#8b7dd8';
    document.getElementById('label-color-picker').value = color;
    document.getElementById('label-color-hex').value = color.toUpperCase();
    document.querySelectorAll('#label-color-presets [data-label-color]').forEach(button => {
      button.classList.toggle('selected', button.dataset.labelColor.toLowerCase() === color);
    });
  }

  function clearLabelError() {
    const error = document.getElementById('label-form-error');
    error.textContent = '';
    error.classList.remove('visible');
  }

  function showLabelError(message) {
    const error = document.getElementById('label-form-error');
    error.textContent = message;
    error.classList.add('visible');
  }

  function resetLabelEditor({ focus = false } = {}) {
    editingLabelId = null;
    clearLabelError();
    document.getElementById('label-name').value = '';
    setLabelColor('#8b7dd8');
    document.getElementById('btn-save-label').innerHTML =
      `<i class="fa-solid fa-plus"></i><span>${esc(t('label.create'))}</span>`;
    document.getElementById('btn-cancel-label-edit').classList.add('hidden');
    document.getElementById('label-editor-title').textContent = t('label.new');
    document.querySelectorAll('.label-manager-row').forEach(row => row.classList.remove('editing'));
    if (focus) setTimeout(() => document.getElementById('label-name').focus(), 30);
  }

  function startLabelEdit(labelId) {
    const label = currentLabels.find(item => String(item.id) === String(labelId));
    if (!label) return;
    editingLabelId = label.id;
    pendingLabelDeleteId = null;
    clearLabelError();
    document.getElementById('label-name').value = label.name;
    setLabelColor(label.color);
    document.getElementById('btn-save-label').innerHTML =
      `<i class="fa-solid fa-floppy-disk"></i><span>${esc(t('label.update'))}</span>`;
    document.getElementById('btn-cancel-label-edit').classList.remove('hidden');
    document.getElementById('label-editor-title').textContent = t('label.edit');
    renderLabelManagerList(currentLabels);
    setTimeout(() => {
      const input = document.getElementById('label-name');
      input.focus();
      input.select();
    }, 20);
  }

  function renderLabelColorPresets() {
    const presets = document.getElementById('label-color-presets');
    presets.innerHTML = '';
    for (const color of LABEL_COLORS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'label-color-preset';
      button.dataset.labelColor = color;
      button.style.background = color;
      button.title = color.toUpperCase();
      button.setAttribute('aria-label', `${t('label.color')} ${color}`);
      button.onclick = () => setLabelColor(color);
      presets.appendChild(button);
    }
  }

  function renderLabelManagerList(labels) {
    const container = document.getElementById('label-manager-list');
    container.innerHTML = '';
    if (!labels.length) {
      container.innerHTML = `<div class="label-manager-empty">
        <i class="fa-solid fa-tags"></i>
        <span>${esc(t('label.noLabels'))}</span>
      </div>`;
      return;
    }

    for (const label of labels) {
      const row = document.createElement('div');
      row.className = 'label-manager-row';
      row.dataset.labelRow = String(label.id);
      if (String(editingLabelId) === String(label.id)) row.classList.add('editing');
      const count = Number(label.message_count || 0);
      const isConfirming = String(pendingLabelDeleteId) === String(label.id);
      row.innerHTML = `
        <span class="label-manager-swatch" style="background:${safeColor(label.color)}"></span>
        <div class="label-manager-info">
          <strong>${esc(label.name)}</strong>
          <span>${esc(t('label.messageCount', { count }))}</span>
        </div>
        <div class="label-manager-actions ${isConfirming ? 'confirming' : ''}">
          ${isConfirming ? `
            <span class="label-delete-question">${esc(t('label.deleteConfirm'))}</span>
            <button class="btn danger compact" type="button" data-label-delete-confirm="${label.id}">
              <i class="fa-solid fa-trash"></i>${esc(t('label.deleteYes'))}
            </button>
            <button class="btn compact" type="button" data-label-delete-cancel="${label.id}">${esc(t('cancel'))}</button>
          ` : `
            <button class="iconbtn" type="button" data-label-edit="${label.id}" title="${esc(t('label.edit'))}">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button class="iconbtn label-delete-btn" type="button" data-label-delete="${label.id}" title="${esc(t('label.delete'))}">
              <i class="fa-solid fa-trash"></i>
            </button>
          `}
        </div>`;
      container.appendChild(row);
    }

    container.querySelectorAll('[data-label-edit]').forEach(button => {
      button.onclick = () => startLabelEdit(button.dataset.labelEdit);
    });
    container.querySelectorAll('[data-label-delete]').forEach(button => {
      button.onclick = () => {
        pendingLabelDeleteId = button.dataset.labelDelete;
        renderLabelManagerList(currentLabels);
      };
    });
    container.querySelectorAll('[data-label-delete-cancel]').forEach(button => {
      button.onclick = () => {
        pendingLabelDeleteId = null;
        renderLabelManagerList(currentLabels);
      };
    });
    container.querySelectorAll('[data-label-delete-confirm]').forEach(button => {
      button.onclick = () => deleteLabel(button.dataset.labelDeleteConfirm);
    });
  }

  async function openLabelManager() {
    openModal('labels-modal');
    renderLabelColorPresets();
    resetLabelEditor({ focus: true });
    const container = document.getElementById('label-manager-list');
    container.innerHTML = `<div class="label-manager-loading"><i class="fa-solid fa-rotate fa-spin"></i>${esc(t('label.loading'))}</div>`;
    try {
      renderLabels(await rpc('labels.list'));
      renderLabelManagerList(currentLabels);
      resetLabelEditor({ focus: true });
    } catch (error) {
      container.innerHTML = `<div class="label-manager-empty">${esc(t('error'))} : ${esc(error.message)}</div>`;
    }
  }

  async function saveLabel() {
    const name = document.getElementById('label-name').value.trim();
    const color = normalizeLabelColor(document.getElementById('label-color-hex').value);
    if (!name) {
      showLabelError(t('label.errorName'));
      document.getElementById('label-name').focus();
      return;
    }
    if (!color) {
      showLabelError(t('label.errorColor'));
      document.getElementById('label-color-hex').focus();
      return;
    }

    const button = document.getElementById('btn-save-label');
    button.disabled = true;
    clearLabelError();
    try {
      const wasEditing = editingLabelId !== null;
      const editedId = editingLabelId;
      const labels = await rpc(wasEditing ? 'labels.update' : 'labels.add', wasEditing
        ? { id: editingLabelId, name, color }
        : { name, color });
      renderLabels(labels);
      pendingLabelDeleteId = null;
      if (wasEditing && view.type === 'label' && String(view.labelId) === String(editedId)) {
        document.getElementById('list-title').textContent = name;
      }
      renderLabelManagerList(currentLabels);
      resetLabelEditor({ focus: true });
      status(t(wasEditing ? 'label.updated' : 'label.created', { name }));
      await refresh();
    } catch (error) {
      const duplicate = /unique|constraint.*labels\.name/i.test(error.message || '');
      showLabelError(duplicate ? t('label.errorDuplicate') : `${t('error')} : ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  async function deleteLabel(labelId) {
    const label = currentLabels.find(item => String(item.id) === String(labelId));
    if (!label) return;
    try {
      const labels = await rpc('labels.remove', { id: label.id });
      const deletedSelectedLabel = view.type === 'label' && String(view.labelId) === String(label.id);
      if (deletedSelectedLabel) {
        view = { type: 'unified' };
        document.getElementById('list-title').textContent = t('unified.inbox');
        document.querySelectorAll('.side-item').forEach(item => item.classList.remove('active'));
        document.querySelector('[data-view="unified"]')?.classList.add('active');
        clearReader();
      }
      pendingLabelDeleteId = null;
      if (String(editingLabelId) === String(label.id)) resetLabelEditor();
      renderLabels(labels);
      renderLabelManagerList(currentLabels);
      status(t('label.removed', { name: label.name }));
      await refresh();
    } catch (error) {
      showLabelError(`${t('error')} : ${error.message}`);
    }
  }

  async function renderLabelMenu() {
    const menu = document.getElementById('label-menu');
    const message = Viewer.current;
    if (!message) return;
    const labels = await rpc('labels.ofMessage', { messageId: message.meta.id });
    menu.innerHTML = '';
    if (!labels.length) {
      menu.innerHTML = `<div class="empty-hint">${esc(t('label.emptyHint'))}</div>`;
    }
    for (const label of labels) {
      const button = document.createElement('button');
      button.className = 'side-item';
      button.innerHTML = `<span class="account-dot" style="background:${safeColor(label.color)}"></span>
        <span style="overflow:hidden;text-overflow:ellipsis">${esc(label.name)}</span>
        ${label.applied ? '<i class="fa-solid fa-check"></i>' : ''}`;
      button.onclick = async event => {
        event.stopPropagation();
        button.disabled = true;
        try {
          await rpc(label.applied ? 'labels.untag' : 'labels.tag', {
            messageId: message.meta.id,
            labelId: label.id,
          });
          // Une sélection d'étiquette est une action ponctuelle : le menu se
          // referme et la liste conserve le message actif ainsi que sa position.
          menu.classList.add('hidden');
          await refreshVisibleList({ preserveListState: true });
        } catch (error) {
          status(`${t('error')} : ${error.message}`, 'error');
          button.disabled = false;
        }
      };
      menu.appendChild(button);
    }
  }

  async function toggleLabelMenu(event) {
    event.stopPropagation();
    closeQuickLabelMenu();
    const menu = document.getElementById('label-menu');
    if (menu.classList.contains('hidden')) {
      await renderLabelMenu();
      menu.classList.remove('hidden');
    } else {
      menu.classList.add('hidden');
    }
  }

  async function refreshSpamStats() {
    const statistics = await rpc('spam.stats');
    document.getElementById('spam-stats').textContent = t('spam.stats', {
      ham: statistics.hamMessages,
      spam: statistics.spamMessages,
    });
  }

  // ---------- Statistiques ----------
  async function openStatistics() {
    openModal('stats-modal');
    await loadStatistics();
  }

  async function loadStatistics() {
    const body = document.getElementById('stats-body');
    const token = ++statisticsRequestToken;
    body.innerHTML = `<div class="stats-loading"><i class="fa-solid fa-rotate fa-spin"></i>${esc(t('stats.loading'))}</div>`;
    try {
      const statistics = await rpc('stats.get', {
        period: statisticsState.period,
        accountId: statisticsState.accountId || undefined,
      });
      if (token !== statisticsRequestToken) return;
      statisticsData = statistics;
      renderStatistics(statistics);
    } catch (error) {
      if (token !== statisticsRequestToken) return;
      body.innerHTML = `<div class="stats-empty">${esc(t('error'))} : ${esc(error.message)}</div>`;
    }
  }

  function renderStatistics(data) {
    const summary = data.summary || {};
    const globalSummary = data.globalSummary || summary;
    const previous = data.previous || null;
    const body = document.getElementById('stats-body');
    const accountOptions = accounts.map(account => `
      <option value="${esc(account.id)}" ${statisticsState.accountId === account.id ? 'selected' : ''}>
        ${esc(account.displayName || account.email)}
      </option>`).join('');

    const cards = [
      {
        icon: 'fa-envelope', label: 'stats.total', value: numberFormat(summary.total),
        detail: t('stats.averagePerDay', { count: formatDecimal(summary.averagePerActiveDay, 1) }),
        delta: statsDelta(summary.total, previous?.total),
      },
      {
        icon: 'fa-inbox', label: 'stats.received', value: numberFormat(summary.received),
        detail: t('stats.readRateValue', { rate: formatPercent(summary.readRate) }),
        delta: statsDelta(summary.received, previous?.received),
      },
      {
        icon: 'fa-paper-plane', label: 'stats.sent', value: numberFormat(summary.sent),
        detail: t('stats.responseRateValue', { rate: formatPercent(summary.responseRate) }),
        delta: statsDelta(summary.sent, previous?.sent),
      },
      {
        icon: 'fa-comments', label: 'stats.conversations', value: numberFormat(summary.conversations),
        detail: t('stats.messagesPerConversation', {
          count: formatDecimal((summary.total || 0) / Math.max(1, summary.conversations || 0), 1),
        }),
      },
      {
        icon: 'fa-envelope-open-text', label: 'stats.unread', value: numberFormat(summary.unread),
        detail: t('stats.ofReceived', {
          rate: formatPercent((summary.received || 0) ? (summary.unread || 0) * 100 / summary.received : 0),
        }),
      },
      {
        icon: 'fa-paperclip', label: 'stats.attachments', value: numberFormat(summary.attachments),
        detail: t('stats.ofMessages', { rate: formatPercent(summary.attachmentRate) }),
      },
      {
        icon: 'fa-ban', label: 'stats.spam', value: numberFormat(summary.spam),
        detail: t('stats.ofReceived', { rate: formatPercent(summary.spamRate) }),
      },
      {
        icon: 'fa-database', label: 'stats.selectionSize', value: fmtSize(summary.totalSize),
        detail: t('stats.periodValue', { period: formatPeriod(summary.oldestDate, summary.newestDate) }),
        delta: statsDelta(summary.totalSize, previous?.totalSize),
      },
    ];

    body.innerHTML = `
      <div class="stats-toolbar">
        <div class="stats-filter-group">
          <label>${esc(t('stats.periodFilter'))}
            <select id="stats-period-select">
              ${['7d', '30d', '90d', '365d', 'all'].map(value => `
                <option value="${value}" ${statisticsState.period === value ? 'selected' : ''}>${esc(t(`stats.period.${value}`))}</option>
              `).join('')}
            </select>
          </label>
          <label>${esc(t('stats.accountFilter'))}
            <select id="stats-account-select">
              <option value="">${esc(t('stats.allAccounts'))}</option>
              ${accountOptions}
            </select>
          </label>
        </div>
        <div class="stats-toolbar-actions">
          <button class="btn" id="btn-stats-refresh" type="button"><i class="fa-solid fa-rotate"></i>${esc(t('stats.refresh'))}</button>
          <button class="btn" id="btn-stats-export" type="button"><i class="fa-solid fa-file-csv"></i>${esc(t('stats.export'))}</button>
        </div>
      </div>

      <nav class="stats-tabs" aria-label="${esc(t('stats.title'))}">
        ${['overview', 'activity', 'contacts', 'storage'].map(tab => `
          <button type="button" data-stats-tab="${tab}" class="${statisticsState.tab === tab ? 'active' : ''}">
            <i class="fa-solid ${statsTabIcon(tab)}"></i>${esc(t(`stats.tab.${tab}`))}
          </button>`).join('')}
      </nav>

      <div class="stats-panel ${statisticsState.tab === 'overview' ? 'active' : ''}" data-stats-panel="overview">
        <div class="stats-kpi-grid">
          ${cards.map(renderStatisticsCard).join('')}
        </div>
        <section class="stats-section stats-section-wide">
          <div class="stats-section-heading">
            <div><h3>${esc(t('stats.timeline'))}</h3><p>${esc(t('stats.timelineHint'))}</p></div>
            <div class="stats-legend"><span class="received"></span>${esc(t('stats.received'))}<span class="sent"></span>${esc(t('stats.sent'))}</div>
          </div>
          ${buildTimelineChart(data.timeline || [], data.period?.grain || 'day')}
        </section>
        <div class="stats-two-columns">
          ${buildFolderDistribution(data.byFolder || [])}
          ${buildAccountStatistics(data.byAccount || [])}
        </div>
      </div>

      <div class="stats-panel ${statisticsState.tab === 'activity' ? 'active' : ''}" data-stats-panel="activity">
        <div class="stats-two-columns">
          ${buildWeekdayChart(data.byWeekday || [])}
          ${buildUnreadAge(data.unreadAge || [])}
        </div>
        ${buildHourlyHeatmap(data.byHour || [])}
      </div>

      <div class="stats-panel ${statisticsState.tab === 'contacts' ? 'active' : ''}" data-stats-panel="contacts">
        <div class="stats-two-columns">
          ${buildContactTable('senders', data.topSenders || [])}
          ${buildContactTable('recipients', data.topRecipients || [])}
        </div>
        <div class="stats-two-columns">
          ${buildRankBars('domains', data.topDomains || [], row => row.domain, row => row.total)}
          ${buildLabelStatistics(data.labels || [])}
        </div>
      </div>

      <div class="stats-panel ${statisticsState.tab === 'storage' ? 'active' : ''}" data-stats-panel="storage">
        <div class="stats-storage-summary">
          <div><i class="fa-solid fa-database"></i><b>${fmtSize(globalSummary.totalSize)}</b><span>${esc(t('stats.localSize'))}</span></div>
          <div><i class="fa-solid fa-paperclip"></i><b>${numberFormat(summary.attachments)}</b><span>${esc(t('stats.attachments'))}</span></div>
          <div><i class="fa-solid fa-trash-can"></i><b>${numberFormat(globalSummary.trash)}</b><span>${esc(t('trash.folder'))}</span></div>
          <div><i class="fa-solid fa-star"></i><b>${numberFormat(globalSummary.flagged)}</b><span>${esc(t('stats.flagged'))}</span></div>
        </div>
        ${buildLargestMessages(data.largestMessages || [])}
      </div>

      <p class="stats-note"><i class="fa-solid fa-circle-info"></i>${esc(t('stats.localNote'))}</p>`;

    wireStatisticsDashboard();
  }

  function renderStatisticsCard(card) {
    return `<article class="stat-card-v2">
      <div class="stat-card-icon"><i class="fa-solid ${card.icon}"></i></div>
      <div class="stat-card-main">
        <span class="stat-label">${esc(t(card.label))}</span>
        <strong class="stat-value">${esc(card.value)}</strong>
        <span class="stat-detail">${esc(card.detail || '')}</span>
      </div>
      ${card.delta ? `<span class="stat-delta ${card.delta.className}"><i class="fa-solid ${card.delta.icon}"></i>${esc(card.delta.text)}</span>` : ''}
    </article>`;
  }

  function statsDelta(current, previous) {
    if (previous == null || !Number.isFinite(Number(previous))) return null;
    const now = Number(current) || 0;
    const before = Number(previous) || 0;
    if (before === 0) {
      if (now === 0) return { className: 'neutral', icon: 'fa-minus', text: '0 %' };
      return { className: 'up', icon: 'fa-arrow-up', text: t('stats.newActivity') };
    }
    const change = ((now - before) / Math.abs(before)) * 100;
    if (Math.abs(change) < 0.05) return { className: 'neutral', icon: 'fa-minus', text: '0 %' };
    return {
      className: change > 0 ? 'up' : 'down',
      icon: change > 0 ? 'fa-arrow-up' : 'fa-arrow-down',
      text: `${Math.abs(change).toLocaleString(I18N.locale, { maximumFractionDigits: 1 })} %`,
    };
  }

  function statsTabIcon(tab) {
    return {
      overview: 'fa-chart-pie',
      activity: 'fa-wave-square',
      contacts: 'fa-address-book',
      storage: 'fa-hard-drive',
    }[tab] || 'fa-chart-column';
  }

  function wireStatisticsDashboard() {
    document.getElementById('stats-period-select').onchange = event => {
      statisticsState.period = event.target.value;
      loadStatistics();
    };
    document.getElementById('stats-account-select').onchange = event => {
      statisticsState.accountId = event.target.value;
      loadStatistics();
    };
    document.getElementById('btn-stats-refresh').onclick = loadStatistics;
    document.getElementById('btn-stats-export').onclick = exportStatisticsCsv;
    document.querySelectorAll('[data-stats-tab]').forEach(button => {
      button.onclick = () => activateStatisticsTab(button.dataset.statsTab);
    });
  }

  function activateStatisticsTab(tab) {
    statisticsState.tab = tab;
    document.querySelectorAll('[data-stats-tab]').forEach(button => {
      button.classList.toggle('active', button.dataset.statsTab === tab);
    });
    document.querySelectorAll('[data-stats-panel]').forEach(panel => {
      panel.classList.toggle('active', panel.dataset.statsPanel === tab);
    });
  }

  function buildTimelineChart(rows, grain) {
    if (!rows.length) return `<div class="stats-empty-block">${esc(t('stats.noData'))}</div>`;
    const width = 960;
    const height = 250;
    const left = 44;
    const right = 18;
    const top = 16;
    const bottom = 38;
    const chartWidth = width - left - right;
    const chartHeight = height - top - bottom;
    const maximum = Math.max(1, ...rows.flatMap(row => [Number(row.received) || 0, Number(row.sent) || 0]));
    const xAt = index => rows.length === 1 ? left + chartWidth / 2 : left + (index * chartWidth / (rows.length - 1));
    const yAt = value => top + chartHeight - ((Number(value) || 0) / maximum * chartHeight);
    const receivedPoints = rows.map((row, index) => `${xAt(index).toFixed(1)},${yAt(row.received).toFixed(1)}`).join(' ');
    const sentPoints = rows.map((row, index) => `${xAt(index).toFixed(1)},${yAt(row.sent).toFixed(1)}`).join(' ');
    const labelIndexes = [...new Set([0, Math.floor((rows.length - 1) / 4), Math.floor((rows.length - 1) / 2), Math.floor((rows.length - 1) * 3 / 4), rows.length - 1])];
    const grid = Array.from({ length: 5 }, (_, index) => {
      const ratio = index / 4;
      const y = top + ratio * chartHeight;
      const value = Math.round(maximum * (1 - ratio));
      return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="stats-grid-line"/>
        <text x="${left - 8}" y="${y + 4}" text-anchor="end" class="stats-axis-text">${compactNumber(value)}</text>`;
    }).join('');
    const xLabels = labelIndexes.map(index => `
      <text x="${xAt(index)}" y="${height - 12}" text-anchor="middle" class="stats-axis-text">${esc(formatStatsBucket(rows[index].bucket, grain))}</text>
    `).join('');
    const points = rows.length <= 60 ? rows.map((row, index) => `
      <circle cx="${xAt(index)}" cy="${yAt(row.received)}" r="3" class="stats-point received"><title>${esc(formatStatsBucket(row.bucket, grain))} · ${esc(t('stats.received'))} : ${row.received}</title></circle>
      <circle cx="${xAt(index)}" cy="${yAt(row.sent)}" r="3" class="stats-point sent"><title>${esc(formatStatsBucket(row.bucket, grain))} · ${esc(t('stats.sent'))} : ${row.sent}</title></circle>
    `).join('') : '';
    return `<div class="stats-line-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(t('stats.timeline'))}">
      ${grid}${xLabels}
      <polyline points="${receivedPoints}" class="stats-line received"/>
      <polyline points="${sentPoints}" class="stats-line sent"/>
      ${points}
    </svg></div>`;
  }

  function formatStatsBucket(bucket, grain) {
    if (!bucket) return '';
    if (grain === 'month') {
      const [year, month] = bucket.split('-').map(Number);
      return new Date(year, month - 1, 1).toLocaleDateString(I18N.locale, { month: 'short', year: '2-digit' });
    }
    if (grain === 'week') {
      const [year, week] = bucket.split('-W');
      return t('stats.weekLabel', { week: Number(week), year });
    }
    const [year, month, day] = bucket.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(I18N.locale, { day: 'numeric', month: 'short' });
  }

  function buildFolderDistribution(rows) {
    const order = ['inbox', 'sent', 'junk', 'trash', 'other'];
    const totals = Object.fromEntries(order.map(role => [role, 0]));
    for (const row of rows) totals[order.includes(row.role) ? row.role : 'other'] += Number(row.total) || 0;
    const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
    const colors = {
      inbox: 'var(--accent)', sent: '#4f8bd6', junk: 'var(--danger)',
      trash: 'var(--fg-faint)', other: 'var(--ok)',
    };
    let cursor = 0;
    const segments = order.filter(role => totals[role] > 0).map(role => {
      const start = cursor;
      cursor += totals[role] * 100 / Math.max(1, total);
      return `${colors[role]} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
    });
    const gradient = segments.length ? `conic-gradient(${segments.join(',')})` : 'var(--bg-hover)';
    return `<section class="stats-section stats-card-section">
      <div class="stats-section-heading"><div><h3>${esc(t('stats.byFolder'))}</h3><p>${esc(t('stats.byFolderHint'))}</p></div></div>
      <div class="stats-donut-layout">
        <div class="stats-donut" style="background:${gradient}"><div><b>${numberFormat(total)}</b><span>${esc(t('stats.messages'))}</span></div></div>
        <div class="stats-donut-legend">
          ${order.map(role => `<div><span style="background:${colors[role]}"></span><b>${esc(t(`stats.folder.${role}`))}</b><em>${numberFormat(totals[role])}</em></div>`).join('')}
        </div>
      </div>
    </section>`;
  }

  function buildAccountStatistics(rows) {
    const tableRows = rows.map(account => `
      <tr>
        <td><span class="account-dot" style="background:${safeColor(account.color)}"></span><span>${esc(account.displayName)}</span></td>
        <td>${numberFormat(account.received)}</td><td>${numberFormat(account.sent)}</td>
        <td>${numberFormat(account.unread)}</td><td>${numberFormat(account.spam)}</td><td>${fmtSize(account.totalSize)}</td>
      </tr>`).join('') || `<tr><td colspan="6">${esc(t('stats.noData'))}</td></tr>`;
    return `<section class="stats-section stats-card-section">
      <div class="stats-section-heading"><div><h3>${esc(t('stats.byAccount'))}</h3><p>${esc(t('stats.byAccountHint'))}</p></div></div>
      <div class="table-scroll"><table class="stats-table compact">
        <thead><tr><th>${esc(t('accounts'))}</th><th>${esc(t('stats.received'))}</th><th>${esc(t('stats.sent'))}</th><th>${esc(t('stats.unread'))}</th><th>${esc(t('stats.spam'))}</th><th>${esc(t('stats.size'))}</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>
    </section>`;
  }

  function buildWeekdayChart(rows) {
    const indexed = new Map(rows.map(row => [Number(row.weekday), row]));
    const days = [1, 2, 3, 4, 5, 6, 0];
    const values = days.map(day => indexed.get(day) || { received: 0, sent: 0 });
    const maximum = Math.max(1, ...values.flatMap(row => [Number(row.received) || 0, Number(row.sent) || 0]));
    return `<section class="stats-section stats-card-section">
      <div class="stats-section-heading"><div><h3>${esc(t('stats.byWeekday'))}</h3><p>${esc(t('stats.byWeekdayHint'))}</p></div></div>
      <div class="stats-weekday-chart">
        ${days.map((day, index) => {
          const row = values[index];
          const receivedHeight = row.received ? Math.max(4, row.received * 100 / maximum) : 0;
          const sentHeight = row.sent ? Math.max(4, row.sent * 100 / maximum) : 0;
          return `<div class="stats-weekday-column">
            <div class="stats-weekday-bars">
              <span class="received" style="height:${receivedHeight}%" title="${esc(t('stats.received'))} : ${row.received}"></span>
              <span class="sent" style="height:${sentHeight}%" title="${esc(t('stats.sent'))} : ${row.sent}"></span>
            </div>
            <b>${esc(t(`stats.weekday.${day}`))}</b><small>${numberFormat((row.received || 0) + (row.sent || 0))}</small>
          </div>`;
        }).join('')}
      </div>
    </section>`;
  }

  function buildHourlyHeatmap(rows) {
    const indexed = new Map(rows.map(row => [Number(row.hour), Number(row.total) || 0]));
    const maximum = Math.max(1, ...indexed.values());
    return `<section class="stats-section stats-card-section stats-section-wide">
      <div class="stats-section-heading"><div><h3>${esc(t('stats.byHour'))}</h3><p>${esc(t('stats.byHourHint'))}</p></div></div>
      <div class="stats-hour-grid">
        ${Array.from({ length: 24 }, (_, hour) => {
          const value = indexed.get(hour) || 0;
          const intensity = Math.round(value * 100 / maximum);
          return `<div class="stats-hour-cell" style="--intensity:${intensity}%" title="${String(hour).padStart(2, '0')}:00 · ${value} ${esc(t('stats.messages').toLocaleLowerCase())}">
            <b>${String(hour).padStart(2, '0')}</b><span>${numberFormat(value)}</span>
          </div>`;
        }).join('')}
      </div>
    </section>`;
  }

  function buildUnreadAge(rows) {
    const indexed = new Map(rows.map(row => [row.age, Number(row.total) || 0]));
    const ages = ['day', 'week', 'month', 'quarter', 'older'];
    const maximum = Math.max(1, ...ages.map(age => indexed.get(age) || 0));
    return `<section class="stats-section stats-card-section">
      <div class="stats-section-heading"><div><h3>${esc(t('stats.unreadAge'))}</h3><p>${esc(t('stats.unreadAgeHint'))}</p></div></div>
      <div class="stats-horizontal-bars">
        ${ages.map(age => {
          const value = indexed.get(age) || 0;
          return `<div><span>${esc(t(`stats.age.${age}`))}</span><div><i style="width:${value * 100 / maximum}%"></i></div><b>${numberFormat(value)}</b></div>`;
        }).join('')}
      </div>
    </section>`;
  }

  function buildContactTable(type, rows) {
    const sender = type === 'senders';
    const tableRows = rows.map(row => `
      <tr><td><b>${esc(sender ? row.sender : row.recipient)}</b>${sender && row.address && row.address !== row.sender ? `<small>${esc(row.address)}</small>` : ''}</td>
      <td>${numberFormat(row.total)}</td><td>${fmtSize(row.totalSize)}</td><td>${fmtDateTime(row.lastDate)}</td></tr>
    `).join('') || `<tr><td colspan="4">${esc(t('stats.noData'))}</td></tr>`;
    return `<section class="stats-section stats-card-section">
      <div class="stats-section-heading"><div><h3>${esc(t(`stats.top.${type}`))}</h3><p>${esc(t(`stats.top.${type}Hint`))}</p></div></div>
      <div class="table-scroll"><table class="stats-table compact contacts">
        <thead><tr><th>${esc(t(sender ? 'stats.sender' : 'stats.recipient'))}</th><th>${esc(t('stats.messages'))}</th><th>${esc(t('stats.size'))}</th><th>${esc(t('stats.lastActivity'))}</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>
    </section>`;
  }

  function buildRankBars(type, rows, labelGetter, valueGetter) {
    const maximum = Math.max(1, ...rows.map(valueGetter));
    return `<section class="stats-section stats-card-section">
      <div class="stats-section-heading"><div><h3>${esc(t(`stats.${type}`))}</h3><p>${esc(t(`stats.${type}Hint`))}</p></div></div>
      <div class="stats-ranked-bars">
        ${rows.map((row, index) => {
          const value = Number(valueGetter(row)) || 0;
          return `<div><span class="rank">${index + 1}</span><span class="rank-label" title="${esc(labelGetter(row))}">${esc(labelGetter(row))}</span><div><i style="width:${value * 100 / maximum}%"></i></div><b>${numberFormat(value)}</b></div>`;
        }).join('') || `<div class="stats-empty-block">${esc(t('stats.noData'))}</div>`}
      </div>
    </section>`;
  }

  function buildLabelStatistics(rows) {
    const maximum = Math.max(1, ...rows.map(row => Number(row.total) || 0));
    return `<section class="stats-section stats-card-section">
      <div class="stats-section-heading"><div><h3>${esc(t('stats.labels'))}</h3><p>${esc(t('stats.labelsHint'))}</p></div></div>
      <div class="stats-ranked-bars label-bars">
        ${rows.map((row, index) => `<div><span class="rank label-dot" style="background:${safeColor(row.color)}"></span><span class="rank-label">${esc(row.name)}</span><div><i style="width:${Number(row.total) * 100 / maximum}%;background:${safeColor(row.color)}"></i></div><b>${numberFormat(row.total)}</b></div>`).join('') || `<div class="stats-empty-block">${esc(t('stats.noData'))}</div>`}
      </div>
    </section>`;
  }

  function buildLargestMessages(rows) {
    const tableRows = rows.map(row => `
      <tr>
        <td><span class="account-dot" style="background:${safeColor(row.color)}"></span>${esc(row.displayName)}</td>
        <td><b title="${esc(row.subject || t('compose.noSubject'))}">${esc(row.subject || t('compose.noSubject'))}</b><small>${esc(row.from_name || row.from_addr || row.to_addr || '')}</small></td>
        <td>${esc(t(`stats.folder.${['inbox', 'sent', 'junk', 'trash'].includes(row.folder_role) ? row.folder_role : 'other'}`))}</td>
        <td>${fmtDateTime(row.date)}</td><td><b>${fmtSize(row.size)}</b></td>
      </tr>`).join('') || `<tr><td colspan="5">${esc(t('stats.noData'))}</td></tr>`;
    return `<section class="stats-section stats-card-section stats-section-wide">
      <div class="stats-section-heading"><div><h3>${esc(t('stats.largestMessages'))}</h3><p>${esc(t('stats.largestMessagesHint'))}</p></div></div>
      <div class="table-scroll"><table class="stats-table largest">
        <thead><tr><th>${esc(t('accounts'))}</th><th>${esc(t('compose.subject'))}</th><th>${esc(t('stats.folder'))}</th><th>${esc(t('stats.date'))}</th><th>${esc(t('stats.size'))}</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>
    </section>`;
  }

  async function exportStatisticsCsv() {
    if (!statisticsData) return;
    const filename = `LibraMail-statistiques-${new Date().toISOString().slice(0, 10)}.csv`;
    const target = await Neutralino.os.showSaveDialog(t('stats.export'), {
      defaultPath: filename,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (!target) return;

    const data = statisticsData;
    const rows = [];
    const add = (...cells) => rows.push(cells.map(csvCell).join(';'));
    add(t('stats.title'));
    add(t('stats.periodFilter'), t(`stats.period.${statisticsState.period}`));
    add(t('stats.accountFilter'), statisticsState.accountId
      ? accounts.find(account => account.id === statisticsState.accountId)?.email || statisticsState.accountId
      : t('stats.allAccounts'));
    add('');
    add(t('stats.metric'), t('stats.value'));
    for (const [key, value] of Object.entries({
      [t('stats.total')]: data.summary.total,
      [t('stats.received')]: data.summary.received,
      [t('stats.sent')]: data.summary.sent,
      [t('stats.conversations')]: data.summary.conversations,
      [t('stats.unread')]: data.summary.unread,
      [t('stats.spam')]: data.summary.spam,
      [t('stats.attachments')]: data.summary.attachments,
      [t('stats.localSize')]: data.summary.totalSize,
    })) add(key, value);
    add('');
    add(t('stats.byAccount'));
    add(t('accounts'), t('stats.received'), t('stats.sent'), t('stats.unread'), t('stats.spam'), t('stats.size'));
    for (const row of data.byAccount || []) add(row.displayName, row.received, row.sent, row.unread, row.spam, row.totalSize);
    add('');
    add(t('stats.top.senders'));
    add(t('stats.sender'), t('account.email'), t('stats.messages'), t('stats.size'));
    for (const row of data.topSenders || []) add(row.sender, row.address, row.total, row.totalSize);
    add('');
    add(t('stats.top.recipients'));
    add(t('stats.recipient'), t('stats.messages'), t('stats.size'));
    for (const row of data.topRecipients || []) add(row.recipient, row.total, row.totalSize);
    add('');
    add(t('stats.labels'));
    add(t('labels'), t('stats.messages'));
    for (const row of data.labels || []) add(row.name, row.total);

    await Neutralino.filesystem.writeFile(target, '\ufeff' + rows.join('\r\n'));
    status(t('stats.exported', { file: target.split(/[\\/]/).pop() }), 'success');
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return `"${text.replaceAll('"', '""')}"`;
  }

  function formatPercent(value, digits = 0) {
    return `${(Number(value) || 0).toLocaleString(I18N.locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })} %`;
  }

  function formatDecimal(value, digits = 1) {
    return (Number(value) || 0).toLocaleString(I18N.locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function compactNumber(value) {
    return new Intl.NumberFormat(I18N.locale, {
      notation: 'compact', maximumFractionDigits: 1,
    }).format(Number(value) || 0);
  }

  // ---------- Compositeur et signatures ----------
  let composeAttachments = [];
  let composeMode = 'new';
  let composeSource = null;
  let composeQuoteText = '';
  let composeReplyHeaders = null;

  function defaultSignatureProfile() {
    return {
      enabled: false,
      format: 'text',
      content: '',
      newMessages: true,
      replies: true,
      forwards: true,
      separator: true,
      replyPosition: 'above',
      forwardPosition: 'above',
    };
  }

  function normalizeSignatureProfile(profile = {}) {
    const source = { ...defaultSignatureProfile(), ...(profile || {}) };
    return {
      enabled: source.enabled === true,
      format: source.format === 'html' ? 'html' : 'text',
      content: String(source.content || ''),
      newMessages: source.newMessages !== false,
      replies: source.replies !== false,
      forwards: source.forwards !== false,
      separator: source.separator !== false,
      replyPosition: source.replyPosition === 'below' ? 'below' : 'above',
      forwardPosition: source.forwardPosition === 'below' ? 'below' : 'above',
    };
  }

  function signatureProfile(accountId) {
    return normalizeSignatureProfile(config.signatureProfiles?.[accountId]);
  }

  function isReplyMode(mode = composeMode) {
    return mode === 'reply' || mode === 'reply-all';
  }

  function signatureApplies(profile, mode) {
    if (!profile.enabled || !profile.content.trim()) return false;
    if (isReplyMode(mode)) return profile.replies;
    if (mode === 'forward') return profile.forwards;
    return profile.newMessages;
  }

  function sanitizeSignatureHtml(html) {
    return DOMPurify.sanitize(String(html || ''), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'video', 'audio'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'formaction'],
    });
  }

  function htmlToPlainText(html) {
    const documentFragment = new DOMParser().parseFromString(sanitizeSignatureHtml(html), 'text/html');
    return (documentFragment.body.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  function signaturePlainText(profile) {
    const content = profile.format === 'html' ? htmlToPlainText(profile.content) : profile.content.trim();
    if (!content) return '';
    return `${profile.separator ? '-- \n' : ''}${content}`;
  }

  function signatureHtml(profile) {
    const content = profile.format === 'html'
      ? sanitizeSignatureHtml(profile.content)
      : `<div style="white-space:pre-wrap">${esc(profile.content.trim()).replaceAll('\n', '<br>')}</div>`;
    if (!content) return '';
    return `<div class="libramail-signature">${profile.separator ? '<div>-- </div>' : ''}${content}</div>`;
  }

  function sourceMeta(source) {
    return source?.meta || source || {};
  }

  function sourceText(source) {
    const meta = sourceMeta(source);
    return String(source?.text || meta.snippet || '').trim();
  }

  function formatSourceDate(source) {
    const meta = sourceMeta(source);
    const value = source?.headers?.date || meta.date;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(I18N.locale);
  }

  function quoteOriginalMessage(source, mode) {
    if (!source) return '';
    const meta = sourceMeta(source);
    const from = source?.headers?.from || meta.from_name || meta.from_addr || '';
    const to = source?.headers?.to || meta.to_addr || '';
    const subject = source?.headers?.subject || meta.subject || '';
    const date = formatSourceDate(source);
    const body = sourceText(source);

    if (mode === 'forward') {
      return [
        '-------- ' + t('compose.forwardedMessage') + ' --------',
        `${t('compose.from')} : ${from}`,
        `${t('compose.date')} : ${date}`,
        `${t('compose.subject')} : ${subject}`,
        `${t('compose.to')} : ${to}`,
        '',
        body,
      ].join('\n').trim();
    }

    const heading = t('compose.replyQuote', { sender: from, date });
    const quoted = body.split(/\r?\n/).map(line => `> ${line}`).join('\n');
    return `${heading}\n${quoted}`.trim();
  }

  function composePosition(profile) {
    if (isReplyMode()) return profile.replyPosition;
    if (composeMode === 'forward') return profile.forwardPosition;
    return 'above';
  }

  function updateComposeSignature({ resetChoice = false } = {}) {
    const accountId = document.getElementById('compose-from').value;
    const profile = signatureProfile(accountId);
    const checkbox = document.getElementById('compose-use-signature');
    const applies = signatureApplies(profile, composeMode);
    if (resetChoice) checkbox.checked = applies;
    checkbox.disabled = !applies;

    const account = accounts.find(item => item.id === accountId);
    document.getElementById('compose-signature-account-hint').textContent = account
      ? t('compose.signatureForAccount', { account: account.displayName || account.email })
      : '';

    const signatureBlock = document.getElementById('compose-signature-block');
    const quoteBlock = document.getElementById('compose-quote-block');
    const preview = document.getElementById('compose-signature-preview');
    const useSignature = applies && checkbox.checked;

    signatureBlock.classList.toggle('hidden', !useSignature);
    quoteBlock.classList.toggle('hidden', !composeQuoteText);
    if (useSignature) {
      if (profile.format === 'html') preview.innerHTML = signatureHtml(profile);
      else preview.textContent = signaturePlainText(profile);
      preview.classList.toggle('plain', profile.format !== 'html');
    } else {
      preview.innerHTML = '';
    }

    const stack = document.getElementById('compose-render-stack');
    const position = composePosition(profile);
    if (composeQuoteText && useSignature && position === 'below') {
      stack.append(quoteBlock, signatureBlock);
    } else {
      stack.append(signatureBlock, quoteBlock);
    }
  }

  function splitAddressTokens(value) {
    const tokens = [];
    let current = '';
    let quoted = false;
    let escaped = false;
    let angleDepth = 0;

    for (const character of String(value || '')) {
      if (escaped) {
        current += character;
        escaped = false;
        continue;
      }
      if (character === '\\' && quoted) {
        current += character;
        escaped = true;
        continue;
      }
      if (character === '"') quoted = !quoted;
      if (!quoted && character === '<') angleDepth += 1;
      if (!quoted && character === '>' && angleDepth > 0) angleDepth -= 1;
      if (!quoted && angleDepth === 0 && (character === ',' || character === ';')) {
        if (current.trim()) tokens.push(current.trim());
        current = '';
      } else {
        current += character;
      }
    }
    if (current.trim()) tokens.push(current.trim());
    return tokens;
  }

  function parseAddressText(value) {
    return splitAddressTokens(value).map(token => {
      const match = token.match(/^(.*?)<\s*([^<>]+)\s*>$/);
      if (match) {
        return {
          name: match[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"'),
          address: match[2].trim(),
        };
      }
      return { name: '', address: token.trim() };
    }).filter(item => item.address.includes('@'));
  }

  function headerAddressList(source, name, fallback = '') {
    const rows = source?.headers?.[`${name}List`];
    if (Array.isArray(rows) && rows.length) {
      return rows.map(item => ({
        name: String(item?.name || '').trim(),
        address: String(item?.address || '').trim(),
      })).filter(item => item.address);
    }
    return parseAddressText(source?.headers?.[name] || fallback);
  }

  function normalizeRecipientAddress(value) {
    return String(value || '').trim().toLocaleLowerCase('en-US');
  }

  function formatRecipientAddress(item) {
    const address = String(item?.address || '').trim();
    const name = String(item?.name || '').trim();
    if (!address) return '';
    if (!name) return address;
    return `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" <${address}>`;
  }

  function uniqueAddressList(rows, excluded = new Set()) {
    const seen = new Set(excluded);
    const result = [];
    for (const row of rows || []) {
      const key = normalizeRecipientAddress(row?.address);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(row);
    }
    return result;
  }

  function ownAddressSet(accountId) {
    const values = accounts.flatMap(account => [account.email]);
    const selected = accounts.find(account => String(account.id) === String(accountId));
    if (selected?.email) values.push(selected.email);
    return new Set(values.map(normalizeRecipientAddress).filter(Boolean));
  }

  function replyRecipients(source, mode, accountId) {
    const meta = sourceMeta(source);
    const outgoing = meta.folder_role === 'sent';
    const own = ownAddressSet(accountId);
    const fromList = headerAddressList(source, 'from', meta.from_addr || '');
    const replyToList = headerAddressList(source, 'replyTo');
    const toList = headerAddressList(source, 'to', meta.to_addr || '');
    const ccList = headerAddressList(source, 'cc', meta.cc_addr || '');
    let to = [];
    let cc = [];

    if (outgoing) {
      to = uniqueAddressList(toList, own);
      if (mode === 'reply-all') {
        const excluded = new Set([...own, ...to.map(item => normalizeRecipientAddress(item.address))]);
        cc = uniqueAddressList(ccList, excluded);
      }
    } else {
      const primary = replyToList.length ? replyToList : fromList;
      to = uniqueAddressList(primary, own);
      if (mode === 'reply-all') {
        const excluded = new Set([...own, ...to.map(item => normalizeRecipientAddress(item.address))]);
        cc = uniqueAddressList([...toList, ...ccList], excluded);
      }
    }

    // Repli pour les anciens enregistrements ne disposant pas encore des
    // listes d'adresses structurées.
    if (!to.length) {
      const fallback = outgoing ? meta.to_addr : (source?.headers?.replyTo || meta.from_addr);
      to = uniqueAddressList(parseAddressText(fallback), own);
    }

    return {
      to: to.map(formatRecipientAddress).filter(Boolean).join(', '),
      cc: cc.map(formatRecipientAddress).filter(Boolean).join(', '),
    };
  }

  function openCompose(source = null, mode = 'new') {
    composeMode = mode;
    composeSource = source;
    composeAttachments = [];
    composeQuoteText = mode === 'new' ? '' : quoteOriginalMessage(source, mode);
    composeReplyHeaders = isReplyMode(mode) ? {
      inReplyTo: source?.headers?.messageId || sourceMeta(source).message_id || undefined,
      references: source?.headers?.references || undefined,
    } : null;

    document.getElementById('compose-attachments').innerHTML = '';
    const from = document.getElementById('compose-from');
    from.innerHTML = accounts.map(account =>
      `<option value="${esc(account.id)}" ${account.id === config.defaultAccountId ? 'selected' : ''}>
        ${esc(account.displayName || '')} &lt;${esc(account.email)}&gt;</option>`).join('');

    const meta = sourceMeta(source);
    if (source && meta.account_id) from.value = meta.account_id;

    const toInput = document.getElementById('compose-to');
    const ccInput = document.getElementById('compose-cc');
    const bccInput = document.getElementById('compose-bcc');
    const subjectInput = document.getElementById('compose-subject');
    const bodyInput = document.getElementById('compose-body');
    ccInput.value = '';
    bccInput.value = '';
    bodyInput.value = '';
    document.getElementById('compose-read-receipt').checked = false;
    document.getElementById('compose-delivery-receipt').checked = false;

    if (isReplyMode(mode) && source) {
      const recipients = replyRecipients(source, mode, from.value);
      toInput.value = recipients.to;
      ccInput.value = recipients.cc;
      subjectInput.value = /^re\s*:/i.test(meta.subject || '') ? meta.subject : 'Re: ' + (meta.subject || '');
    } else if (mode === 'forward' && source) {
      toInput.value = '';
      const prefix = I18N.locale === 'fr' ? 'Tr: ' : 'Fwd: ';
      subjectInput.value = /^(tr|fwd?)\s*:/i.test(meta.subject || '') ? meta.subject : prefix + (meta.subject || '');
    } else {
      toInput.value = '';
      subjectInput.value = '';
    }

    document.getElementById('compose-modal-title').textContent = t(
      mode === 'reply-all' ? 'compose.replyAllTitle'
        : mode === 'reply' ? 'compose.replyTitle'
          : mode === 'forward' ? 'compose.forwardTitle'
            : 'compose.title');
    document.getElementById('compose-quote-title').textContent = t(
      mode === 'forward' ? 'compose.forwardedMessage' : 'compose.quotedMessage');
    document.getElementById('compose-quote-content').textContent = composeQuoteText;
    updateComposeSignature({ resetChoice: true });
    openModal('compose-modal');
    setTimeout(() => bodyInput.focus(), 0);
  }

  function buildOutgoingMessage() {
    const accountId = document.getElementById('compose-from').value;
    const profile = signatureProfile(accountId);
    const useSignature = !document.getElementById('compose-use-signature').disabled
      && document.getElementById('compose-use-signature').checked;
    const body = document.getElementById('compose-body').value.trimEnd();
    const signatureText = useSignature ? signaturePlainText(profile) : '';
    const position = composePosition(profile);
    const textParts = [body];

    if (composeQuoteText) {
      if (useSignature && position === 'above') textParts.push(signatureText);
      textParts.push(composeQuoteText);
      if (useSignature && position === 'below') textParts.push(signatureText);
    } else if (useSignature) {
      textParts.push(signatureText);
    }

    const text = textParts.filter(Boolean).join('\n\n');
    let html;
    if (useSignature && profile.format === 'html') {
      const bodyHtml = `<div class="libramail-body" style="white-space:pre-wrap">${esc(body).replaceAll('\n', '<br>')}</div>`;
      const quoteHtml = composeQuoteText
        ? `<blockquote style="margin:16px 0;padding-left:12px;border-left:3px solid #bbb;white-space:pre-wrap">${esc(composeQuoteText).replaceAll('\n', '<br>')}</blockquote>`
        : '';
      const sigHtml = signatureHtml(profile);
      const htmlParts = [bodyHtml];
      if (quoteHtml) {
        if (position === 'above') htmlParts.push(sigHtml);
        htmlParts.push(quoteHtml);
        if (position === 'below') htmlParts.push(sigHtml);
      } else {
        htmlParts.push(sigHtml);
      }
      html = htmlParts.filter(Boolean).join('<br>');
    }

    return { text, html, accountId };
  }

  async function attachFile() {
    const paths = await Neutralino.os.showOpenDialog(t('compose.attach'), { multiSelections: true });
    for (const filePath of paths || []) {
      const filename = filePath.split(/[\\/]/).pop();
      composeAttachments.push({ filename, path: filePath });
      const chip = document.createElement('span');
      chip.className = 'att-chip';
      chip.innerHTML = `<i class="fa-solid fa-paperclip"></i>${esc(filename)}`;
      document.getElementById('compose-attachments').appendChild(chip);
    }
  }

  async function send() {
    const button = document.getElementById('btn-send');
    button.disabled = true;
    try {
      const outgoing = buildOutgoingMessage();
      const result = await rpc('mail.send', {
        accountId: outgoing.accountId,
        mail: {
          to: document.getElementById('compose-to').value,
          cc: document.getElementById('compose-cc').value || undefined,
          bcc: document.getElementById('compose-bcc').value || undefined,
          subject: document.getElementById('compose-subject').value,
          text: outgoing.text,
          html: outgoing.html,
          readReceipt: document.getElementById('compose-read-receipt').checked,
          deliveryReceipt: document.getElementById('compose-delivery-receipt').checked,
          inReplyTo: composeReplyHeaders?.inReplyTo,
          references: composeReplyHeaders?.references,
          attachments: composeAttachments,
        },
      });
      closeModals();
      status(result.sentCopyWarning
        ? t('compose.sentCopyWarning')
        : '✓ ' + t('compose.sent'), result.sentCopyWarning ? 'error' : 'success');
      refreshSidebarCounts().catch(() => {});
      if (view.type === 'sent') refresh().catch(() => {});
    } catch (error) {
      alert(`${t('error')} : ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  // ---------- Réglages des signatures ----------
  function populateSignatureAccountSelect() {
    const select = document.getElementById('set-signature-account');
    select.innerHTML = accounts.map(account =>
      `<option value="${esc(account.id)}">${esc(account.displayName || account.email)} — ${esc(account.email)}</option>`).join('');
    if (config.defaultAccountId && accounts.some(account => account.id === config.defaultAccountId)) {
      select.value = config.defaultAccountId;
    }
    loadSignatureEditor(select.value);
  }

  function loadSignatureEditor(accountId) {
    const profile = signatureProfile(accountId);
    document.getElementById('set-signature-enabled').value = profile.enabled ? '1' : '0';
    document.getElementById('set-signature-format').value = profile.format;
    document.getElementById('set-signature-new').value = profile.newMessages ? '1' : '0';
    document.getElementById('set-signature-replies').value = profile.replies ? '1' : '0';
    document.getElementById('set-signature-forwards').value = profile.forwards ? '1' : '0';
    document.getElementById('set-signature-separator').value = profile.separator ? '1' : '0';
    document.getElementById('set-signature-reply-position').value = profile.replyPosition;
    document.getElementById('set-signature-forward-position').value = profile.forwardPosition;
    document.getElementById('set-signature-content').value = profile.content;
    document.getElementById('signature-settings-status').textContent = '';
    renderSettingsSignaturePreview();
  }

  function signatureProfileFromEditor() {
    return normalizeSignatureProfile({
      enabled: document.getElementById('set-signature-enabled').value === '1',
      format: document.getElementById('set-signature-format').value,
      content: document.getElementById('set-signature-content').value,
      newMessages: document.getElementById('set-signature-new').value === '1',
      replies: document.getElementById('set-signature-replies').value === '1',
      forwards: document.getElementById('set-signature-forwards').value === '1',
      separator: document.getElementById('set-signature-separator').value === '1',
      replyPosition: document.getElementById('set-signature-reply-position').value,
      forwardPosition: document.getElementById('set-signature-forward-position').value,
    });
  }

  function renderSettingsSignaturePreview() {
    const profile = signatureProfileFromEditor();
    const preview = document.getElementById('settings-signature-preview');
    preview.classList.toggle('disabled', !profile.enabled);
    if (!profile.content.trim()) {
      preview.textContent = t('signature.emptyPreview');
      preview.classList.add('empty');
      return;
    }
    preview.classList.remove('empty');
    if (profile.format === 'html') preview.innerHTML = signatureHtml(profile);
    else preview.textContent = signaturePlainText(profile);
  }

  async function saveSignatureSettings() {
    const accountId = document.getElementById('set-signature-account').value;
    if (!accountId) return;
    const profile = signatureProfileFromEditor();
    if (profile.format === 'html') profile.content = sanitizeSignatureHtml(profile.content);
    const signatureProfiles = { ...(config.signatureProfiles || {}), [accountId]: profile };
    try {
      config = await rpc('config.set', { signatureProfiles });
      document.getElementById('signature-settings-status').textContent = t('signature.saved');
      status(t('signature.saved'), 'success');
      renderSettingsSignaturePreview();
    } catch (error) {
      document.getElementById('signature-settings-status').textContent = `${t('error')} : ${error.message}`;
      status(`${t('error')} : ${error.message}`, 'error');
    }
  }

  // ---------- Comptes ----------
  const accountField = id => document.getElementById(id);

  function setAccountStatus(message = '', state = '') {
    const element = accountField('acc-status');
    element.textContent = message;
    element.classList.remove('success', 'error');
    if (state) element.classList.add(state);
  }

  function resetAccountForm() {
    editingAccountId = null;
    accountField('acc-id').value = '';
    accountField('account-modal-title').textContent = t('account.add');
    accountField('btn-delete-account').classList.add('hidden');
    accountField('acc-name').value = '';
    accountField('acc-email').value = '';
    accountField('acc-color').value = '#8b7dd8';
    accountField('acc-imap-host').value = '';
    accountField('acc-imap-port').value = '993';
    accountField('acc-imap-secure').value = '1';
    accountField('acc-imap-user').value = '';
    accountField('acc-imap-pass').value = '';
    accountField('acc-smtp-host').value = '';
    accountField('acc-smtp-port').value = '465';
    accountField('acc-smtp-secure').value = '1';
    accountField('acc-smtp-user').value = '';
    accountField('acc-smtp-pass').value = '';
    accountField('acc-sync-interval').value = '5';
    accountField('acc-spam-retention').value = '30';
    accountField('account-password-hint').textContent = t('account.passwordRequired');
    setAccountStatus();
  }

  function openNewAccount() {
    resetAccountForm();
    openModal('account-modal');
    accountField('acc-name').focus();
  }

  async function openAccountEditor(accountId) {
    resetAccountForm();
    editingAccountId = accountId;
    accountField('acc-id').value = accountId;
    accountField('account-modal-title').textContent = t('account.editTitle');
    accountField('btn-delete-account').classList.remove('hidden');
    accountField('account-password-hint').textContent = t('account.passwordHint');
    openModal('account-modal');
    setAccountStatus(t('account.loading'));
    try {
      const details = await rpc('accounts.getDetails', { id: accountId });
      if (editingAccountId !== accountId) return;
      accountField('acc-name').value = details.displayName || '';
      accountField('acc-email').value = details.email || '';
      accountField('acc-color').value = safeColor(details.color);
      accountField('acc-imap-host').value = details.imap?.host || '';
      accountField('acc-imap-port').value = Number(details.imap?.port) || 993;
      accountField('acc-imap-secure').value = details.imap?.secure === false ? '0' : '1';
      accountField('acc-imap-user').value = details.imap?.user || '';
      accountField('acc-imap-pass').value = '';
      accountField('acc-smtp-host').value = details.smtp?.host || '';
      accountField('acc-smtp-port').value = Number(details.smtp?.port) || 465;
      accountField('acc-smtp-secure').value = details.smtp?.secure === false ? '0' : '1';
      accountField('acc-smtp-user').value = details.smtp?.user || details.imap?.user || '';
      accountField('acc-smtp-pass').value = '';
      accountField('acc-sync-interval').value = Number(details.syncIntervalMinutes) || 0;
      accountField('acc-spam-retention').value = Number(details.spamRetentionDays) || 0;
      setAccountStatus();
      accountField('acc-name').focus();
    } catch (error) {
      setAccountStatus(`${t('error')} : ${error.message}`, 'error');
    }
  }

  function accountPayload() {
    const value = id => accountField(id).value.trim();
    return {
      id: editingAccountId || undefined,
      displayName: value('acc-name'),
      email: value('acc-email'),
      color: accountField('acc-color').value,
      syncIntervalMinutes: Number(accountField('acc-sync-interval').value) || 0,
      spamRetentionDays: Number(accountField('acc-spam-retention').value) || 0,
      imap: {
        host: value('acc-imap-host'),
        port: Number(value('acc-imap-port')),
        secure: accountField('acc-imap-secure').value === '1',
        user: value('acc-imap-user'),
        pass: accountField('acc-imap-pass').value,
      },
      smtp: {
        host: value('acc-smtp-host'),
        port: Number(value('acc-smtp-port')),
        secure: accountField('acc-smtp-secure').value === '1',
        user: value('acc-smtp-user') || value('acc-imap-user'),
        pass: accountField('acc-smtp-pass').value,
      },
    };
  }

  async function saveAccount() {
    const saveButton = accountField('btn-save-account');
    setAccountStatus(t('account.testing'));
    saveButton.disabled = true;
    try {
      const payload = accountPayload();
      const method = editingAccountId ? 'accounts.update' : 'accounts.add';
      const account = await rpc(method, payload);
      const index = accounts.findIndex(item => item.id === account.id);
      if (index >= 0) accounts[index] = account;
      else accounts.push(account);
      if (!config.defaultAccountId) config.defaultAccountId = account.id;
      if (view.type === 'account' && view.accountId === account.id) {
        document.getElementById('list-title').textContent = account.email;
      }
      renderSidebar();
      closeModals();
      setAccountStatus();
      status(t(editingAccountId ? 'account.updated' : 'account.added'), 'success');
      const wasNew = !editingAccountId;
      editingAccountId = null;
      if (wasNew) rpc('sync.folder', { accountId: account.id }).catch(error => status(error.message, 'error'));
    } catch (error) {
      setAccountStatus('✗ ' + error.message, 'error');
    } finally {
      saveButton.disabled = false;
    }
  }

  async function deleteEditedAccount() {
    const accountId = editingAccountId;
    if (!accountId) return;
    const account = accounts.find(item => item.id === accountId);
    const accepted = await confirmAction({
      title: t('account.removeTitle'),
      message: t('account.removeConfirm', { account: account?.displayName || account?.email || '' }),
      confirmLabel: t('account.remove'),
      icon: 'fa-user-minus',
      danger: true,
    });
    if (!accepted) return;
    setAccountStatus(t('account.removing'));
    try {
      const result = await rpc('accounts.remove', { id: accountId });
      accounts = Array.isArray(result.accounts) ? result.accounts : accounts.filter(item => item.id !== accountId);
      config.defaultAccountId = result.defaultAccountId || null;
      if (view.type === 'account' && view.accountId === accountId) {
        view = { type: 'unified' };
        document.getElementById('list-title').textContent = t('unified.inbox');
        document.querySelectorAll('.side-item').forEach(item => item.classList.remove('active'));
        document.querySelector('[data-view="unified"]')?.classList.add('active');
        clearReader();
      }
      editingAccountId = null;
      closeModals();
      renderSidebar();
      await refresh();
      status(t('account.removed'), 'success');
    } catch (error) {
      setAccountStatus(`${t('error')} : ${error.message}`, 'error');
    }
  }

  // ---------- Contenus distants ----------
  function remoteTypeIcon(type) {
    if (type === 'background') return 'fa-solid fa-panorama';
    if (type === 'stylesheet') return 'fa-solid fa-paintbrush';
    return 'fa-regular fa-image';
  }

  function remoteTypeLabel(type) {
    if (type === 'background') return t('remote.type.background');
    if (type === 'stylesheet') return t('remote.type.stylesheet');
    return t('remote.type.image');
  }

  function remoteOccurrencesLabel(count) {
    return Number(count) > 1 ? t('remote.occurrences', { count }) : '';
  }

  function updateRemoteDomainCheckbox(group) {
    const domainCheckbox = group.querySelector('.remote-domain-checkbox');
    const resourceChecks = [...group.querySelectorAll('.remote-resource-checkbox:not(:disabled)')];
    if (!domainCheckbox) return;
    if (!resourceChecks.length) {
      domainCheckbox.checked = true;
      domainCheckbox.indeterminate = false;
      domainCheckbox.disabled = true;
      return;
    }
    const checked = resourceChecks.filter(input => input.checked).length;
    domainCheckbox.checked = checked === resourceChecks.length;
    domainCheckbox.indeterminate = checked > 0 && checked < resourceChecks.length;
  }

  function updateRemoteDialogState() {
    const modal = document.getElementById('remote-content-modal');
    const checks = [...modal.querySelectorAll('.remote-resource-checkbox:not(:disabled)')];
    const selected = checks.filter(input => input.checked);
    const button = document.getElementById('btn-display-selected-remote');
    button.disabled = selected.length === 0;
    button.querySelector('span').textContent = t('remote.displaySelected', { count: selected.length });
    modal.querySelectorAll('.remote-domain-group').forEach(updateRemoteDomainCheckbox);
  }

  function renderRemoteContentDialog(resources) {
    const listElement = document.getElementById('remote-resource-list');
    const summaryElement = document.getElementById('remote-summary');
    listElement.innerHTML = '';

    const totalOccurrences = resources.reduce((sum, resource) => sum + Number(resource.occurrences || 1), 0);
    const domains = new Set(resources.map(resource => resource.domain).filter(Boolean));
    const trackers = resources.filter(resource => resource.suspectedTracker)
      .reduce((sum, resource) => sum + Number(resource.occurrences || 1), 0);
    const alreadyLoaded = resources.filter(resource => resource.allowed)
      .reduce((sum, resource) => sum + Number(resource.occurrences || 1), 0);

    summaryElement.innerHTML = `
      <span class="remote-summary-chip"><i class="fa-regular fa-image"></i>${esc(t('remote.resourceCount', { count: totalOccurrences }))}</span>
      <span class="remote-summary-chip"><i class="fa-solid fa-globe"></i>${esc(t('remote.domainCount', { count: domains.size }))}</span>
      ${trackers ? `<span class="remote-summary-chip warning"><i class="fa-solid fa-eye"></i>${esc(t('remote.trackerCount', { count: trackers }))}</span>` : ''}
      ${alreadyLoaded ? `<span class="remote-summary-chip success"><i class="fa-solid fa-check"></i>${esc(t('remote.loadedCount', { count: alreadyLoaded }))}</span>` : ''}`;

    const grouped = new Map();
    for (const resource of resources) {
      const domain = resource.domain || t('remote.unknownDomain');
      if (!grouped.has(domain)) grouped.set(domain, []);
      grouped.get(domain).push(resource);
    }

    [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, I18N.locale)).forEach(([domain, items]) => {
      const group = document.createElement('section');
      group.className = 'remote-domain-group';

      const heading = document.createElement('div');
      heading.className = 'remote-domain-heading';
      const domainLabel = document.createElement('label');
      domainLabel.className = 'remote-domain-select';
      const domainCheckbox = document.createElement('input');
      domainCheckbox.type = 'checkbox';
      domainCheckbox.className = 'remote-domain-checkbox';
      const domainText = document.createElement('span');
      domainText.className = 'remote-domain-name';
      domainText.textContent = domain;
      domainLabel.append(domainCheckbox, domainText);

      const domainCount = document.createElement('span');
      domainCount.className = 'remote-domain-count';
      domainCount.textContent = t('remote.domainResources', {
        count: items.reduce((sum, item) => sum + Number(item.occurrences || 1), 0),
      });
      heading.append(domainLabel, domainCount);
      group.appendChild(heading);

      const rows = document.createElement('div');
      rows.className = 'remote-resource-rows';

      items.sort((a, b) => Number(b.suspectedTracker) - Number(a.suspectedTracker) || a.url.localeCompare(b.url))
        .forEach(resource => {
          const row = document.createElement('label');
          row.className = 'remote-resource-row';
          row.classList.toggle('tracker-suspected', Boolean(resource.suspectedTracker));
          row.classList.toggle('already-loaded', Boolean(resource.allowed));

          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'remote-resource-checkbox';
          checkbox.dataset.remoteUrl = resource.url;
          checkbox.checked = resource.allowed || !resource.suspectedTracker;
          checkbox.disabled = Boolean(resource.allowed);
          checkbox.addEventListener('change', updateRemoteDialogState);

          const icon = document.createElement('span');
          icon.className = 'remote-resource-icon';
          icon.innerHTML = `<i class="${remoteTypeIcon(resource.type)}"></i>`;

          const details = document.createElement('span');
          details.className = 'remote-resource-details';
          const titleLine = document.createElement('span');
          titleLine.className = 'remote-resource-title';
          const title = document.createElement('strong');
          title.textContent = resource.label || remoteTypeLabel(resource.type);
          const type = document.createElement('span');
          type.className = 'remote-resource-type';
          type.textContent = remoteTypeLabel(resource.type);
          titleLine.append(title, type);

          if (resource.suspectedTracker) {
            const tracker = document.createElement('span');
            tracker.className = 'remote-tracker-badge';
            tracker.innerHTML = `<i class="fa-solid fa-eye"></i> ${esc(t('remote.trackerSuspected'))}`;
            titleLine.appendChild(tracker);
          }
          if (resource.allowed) {
            const loaded = document.createElement('span');
            loaded.className = 'remote-loaded-badge';
            loaded.innerHTML = `<i class="fa-solid fa-check"></i> ${esc(t('remote.loaded'))}`;
            titleLine.appendChild(loaded);
          }

          const url = document.createElement('code');
          url.className = 'remote-resource-url';
          url.textContent = resource.url;
          url.title = resource.url;

          const metadata = document.createElement('span');
          metadata.className = 'remote-resource-meta';
          const parts = [];
          if (resource.width && resource.height) parts.push(`${resource.width} × ${resource.height} px`);
          const occurrences = remoteOccurrencesLabel(resource.occurrences);
          if (occurrences) parts.push(occurrences);
          if (resource.trackerReason === 'dimensions') parts.push(t('remote.trackerReason.dimensions'));
          if (resource.trackerReason === 'address') parts.push(t('remote.trackerReason.address'));
          metadata.textContent = parts.join(' · ');

          details.append(titleLine, url);
          if (metadata.textContent) details.appendChild(metadata);
          row.append(checkbox, icon, details);
          rows.appendChild(row);
        });

      group.appendChild(rows);
      listElement.appendChild(group);

      domainCheckbox.addEventListener('change', () => {
        group.querySelectorAll('.remote-resource-checkbox:not(:disabled)').forEach(input => {
          input.checked = domainCheckbox.checked;
        });
        updateRemoteDialogState();
      });
    });

    updateRemoteDialogState();
  }

  function openRemoteContentDialog() {
    const resources = Viewer.getRemoteResources();
    if (!resources.length) {
      status(t('remote.none'));
      return;
    }
    renderRemoteContentDialog(resources);
    openModal('remote-content-modal');
  }

  function closeRemoteContentDialog() {
    document.getElementById('remote-content-modal').classList.remove('open');
  }

  function displaySelectedRemoteContent() {
    const selected = [...document.querySelectorAll('#remote-content-modal .remote-resource-checkbox:checked')]
      .map(input => input.dataset.remoteUrl)
      .filter(Boolean);
    if (!selected.length) return;
    Viewer.allowRemote(selected);
    closeRemoteContentDialog();
  }

  // ---------- Sauvegarde et restauration ----------
  function setBackupOperationStatus(message = '', state = '') {
    const element = document.getElementById('backup-operation-status');
    if (!element) return;
    element.textContent = message;
    element.classList.remove('busy', 'success', 'error');
    if (state) element.classList.add(state);
  }

  function clampBackupPercent(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.min(100, Math.round(number)));
  }

  function setBackupProgress({ label = '', percent = 0, detail = '', state = '', indeterminate = false, visible = true } = {}) {
    const root = document.getElementById('backup-progress');
    const bar = document.getElementById('backup-progress-bar');
    const labelElement = document.getElementById('backup-progress-label');
    const percentElement = document.getElementById('backup-progress-percent');
    const detailElement = document.getElementById('backup-progress-detail');
    if (!root || !bar || !labelElement || !percentElement || !detailElement) return;

    root.classList.toggle('hidden', !visible);
    root.classList.remove('busy', 'success', 'error', 'is-indeterminate');
    if (state) root.classList.add(state);
    root.classList.toggle('is-indeterminate', Boolean(indeterminate));

    const normalized = clampBackupPercent(percent);
    labelElement.textContent = label || t('backup.progress.waiting');
    detailElement.textContent = detail || '';
    percentElement.textContent = indeterminate || normalized === null ? '…' : `${normalized} %`;
    bar.style.width = `${normalized ?? 0}%`;
    root.setAttribute('aria-label', labelElement.textContent);
    if (indeterminate || normalized === null) root.removeAttribute('aria-valuenow');
    else root.setAttribute('aria-valuenow', String(normalized));
  }

  function resetBackupProgress({ hide = true } = {}) {
    setBackupProgress({
      label: t('backup.progress.waiting'),
      percent: 0,
      detail: '',
      visible: !hide,
    });
  }

  function backupPhasePercent(kind, step, completed, total) {
    const ratio = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;
    if (kind !== 'import') {
      if (step === 'prepare') return ratio * 8;
      return 8 + ratio * 92;
    }
    const phases = {
      safety: [0, 40],
      extract: [40, 85],
      validate: [85, 92],
      apply: [92, 98],
      finalize: [98, 100],
    };
    const [start, end] = phases[step] || [0, 100];
    return start + ratio * (end - start);
  }

  function updateBackupProgress(data = {}) {
    const kind = data.kind === 'import' ? 'import' : 'export';
    const step = String(data.step || (kind === 'import' ? 'extract' : 'archive'));
    const completed = Math.max(0, Number(data.completed) || 0);
    const total = Math.max(0, Number(data.total) || 0);
    const key = `backup.progress.${step}`;
    const label = t(key, { completed, total });
    const rawName = String(data.name || '').replace(/\\/g, '/');
    const currentName = rawName ? rawName.split('/').pop() : '';
    const detail = currentName
      ? t('backup.progress.currentFile', { name: currentName })
      : (total > 1 ? t('backup.progress.fileCount', { completed, total }) : '');
    const percent = backupPhasePercent(kind, step, completed, total);
    setBackupProgress({ label, percent, detail, state: 'busy' });
    setBackupOperationStatus(label, 'busy');
  }

  function setBackupBusy(value) {
    backupBusy = Boolean(value);
    const card = document.querySelector('.backup-settings-card');
    card?.classList.toggle('is-busy', backupBusy);
    ['btn-export-backup', 'btn-import-backup'].forEach(id => {
      const button = document.getElementById(id);
      if (button) button.disabled = backupBusy;
    });
  }

  function backupFilename() {
    const date = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `LibraMail-sauvegarde-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}.zip`;
  }

  async function selectBackupArchivePath(mode) {
    const exporting = mode === 'export';
    const label = t(exporting ? 'backup.selectingExport' : 'backup.selectingImport');
    setBackupOperationStatus(label, 'busy');
    setBackupProgress({ label, percent: 0, indeterminate: true, state: 'busy' });
    const response = await rpc(
      exporting ? 'backup.selectExportPath' : 'backup.selectImportPath',
      exporting ? { defaultName: backupFilename() } : {},
    );
    return String(response?.path || '').trim();
  }

  async function exportCompleteBackup() {
    if (backupBusy) return;
    resetBackupProgress();
    setBackupBusy(true);
    try {
      let target = await selectBackupArchivePath('export');
      if (!target) {
        setBackupOperationStatus('');
        resetBackupProgress();
        return;
      }
      if (!target.toLowerCase().endsWith('.zip')) target += '.zip';

      setBackupOperationStatus(t('backup.exporting'), 'busy');
      const result = await rpc('backup.export', { targetPath: target });
      setBackupProgress({
        label: t('backup.exportComplete'),
        percent: 100,
        detail: t('backup.progress.fileCount', {
          completed: Number(result.fileCount) || 0,
          total: Number(result.fileCount) || 0,
        }),
        state: 'success',
      });
      setBackupOperationStatus(t('backup.exported', {
        path: result.targetPath,
        size: fmtSize(result.archiveSize),
      }), 'success');
      status(t('backup.exported', {
        path: result.targetPath,
        size: fmtSize(result.archiveSize),
      }), 'success');
    } catch (error) {
      console.error('[LibraMail] Export de la sauvegarde :', error);
      setBackupProgress({ label: t('backup.failed'), percent: null, detail: error.message, state: 'error' });
      setBackupOperationStatus(`${t('error')} : ${error.message}`, 'error');
      status(`${t('error')} : ${error.message}`, 'error');
    } finally {
      setBackupBusy(false);
    }
  }

  async function importCompleteBackup() {
    if (backupBusy) return;
    resetBackupProgress();
    setBackupBusy(true);

    let sourcePath;
    let inspection;
    try {
      sourcePath = await selectBackupArchivePath('import');
      if (!sourcePath) {
        setBackupOperationStatus('');
        resetBackupProgress();
        setBackupBusy(false);
        return;
      }
      setBackupOperationStatus(t('backup.inspecting'), 'busy');
      setBackupProgress({ label: t('backup.inspecting'), percent: 0, indeterminate: true, state: 'busy' });
      inspection = await rpc('backup.inspect', { sourcePath });
    } catch (error) {
      console.error('[LibraMail] Sélection ou vérification de la sauvegarde :', error);
      setBackupProgress({ label: t('backup.failed'), percent: null, detail: error.message, state: 'error' });
      setBackupOperationStatus(`${t('error')} : ${error.message}`, 'error');
      status(`${t('error')} : ${error.message}`, 'error');
      setBackupBusy(false);
      return;
    }

    const manifest = inspection.manifest || {};
    const summary = manifest.summary || {};
    const createdAt = manifest.createdAt
      ? new Date(manifest.createdAt).toLocaleString(I18N.locale || 'fr')
      : '—';
    const accepted = await confirmAction({
      title: t('backup.importTitle'),
      message: t('backup.importConfirm', {
        date: createdAt,
        version: manifest.appVersion || '—',
        accounts: Number(summary.accounts) || 0,
        messages: Number(summary.messages) || 0,
      }),
      confirmLabel: t('backup.importButton'),
      icon: 'fa-box-archive',
      danger: true,
      note: t('backup.importWarning'),
    });
    if (!accepted) {
      setBackupOperationStatus('');
      resetBackupProgress();
      setBackupBusy(false);
      return;
    }

    setBackupOperationStatus(t('backup.importing'), 'busy');
    try {
      const result = await rpc('backup.import', { sourcePath });
      const message = t('backup.imported', {
        accounts: Number(result.accounts) || 0,
        messages: Number(result.messages) || 0,
        path: result.safetyBackupPath || '—',
      });
      setBackupProgress({ label: t('backup.importComplete'), percent: 100, detail: '', state: 'success' });
      setBackupOperationStatus(message, 'success');
      status(message, 'success');
      setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      console.error('[LibraMail] Import de la sauvegarde :', error);
      setBackupProgress({ label: t('backup.failed'), percent: null, detail: error.message, state: 'error' });
      setBackupOperationStatus(`${t('error')} : ${error.message}`, 'error');
      status(`${t('error')} : ${error.message}`, 'error');
    } finally {
      setBackupBusy(false);
    }
  }

  // ---------- Paramètres ----------
  function openSettings() {
    document.getElementById('set-theme').value = config.theme || 'dark';
    document.getElementById('set-locale').value = config.locale || 'fr';
    document.getElementById('set-layout').value = config.layout || 'vertical';
    document.getElementById('set-blockremote').value = config.blockRemoteImages === false ? '0' : '1';
    document.getElementById('set-conversations').value = config.conversationView === false ? '0' : '1';
    document.getElementById('set-auto-read').value = config.autoMarkRead === false ? '0' : '1';
    document.getElementById('set-read-delay').value = Math.max(0, Number(config.markReadDelaySeconds) || 0);
    document.getElementById('set-group-date').value = config.groupByDate === false ? '0' : '1';
    syncAccentControls();

    const defaultAccount = document.getElementById('set-default-account');
    defaultAccount.innerHTML = accounts.map(account =>
      `<option value="${esc(account.id)}" ${account.id === config.defaultAccountId ? 'selected' : ''}>${esc(account.email)}</option>`).join('');
    populateSignatureAccountSelect();

    const syncList = document.getElementById('sync-account-list');
    syncList.innerHTML = accounts.length ? accounts.map(account => `
      <div class="sync-account-row">
        <span class="account-dot" style="background:${safeColor(account.color)}"></span>
        <span class="sync-account-name">${esc(account.displayName || account.email)}<small>${esc(account.email)}</small></span>
        <label>${esc(t('settings.syncEvery'))}</label>
        <input class="sync-minutes" type="number" min="0" max="1440" step="1"
               data-account-sync="${esc(account.id)}" value="${Number(account.syncIntervalMinutes) || 0}">
        <span>${esc(t('settings.minutes'))}</span>
      </div>`).join('') : `<div class="empty-hint">${esc(t('settings.noAccounts'))}</div>`;

    syncList.querySelectorAll('[data-account-sync]').forEach(input => {
      input.onchange = async event => {
        const id = event.currentTarget.dataset.accountSync;
        const minutes = Math.max(0, Math.min(1440, Math.round(Number(event.currentTarget.value) || 0)));
        event.currentTarget.value = minutes;
        try {
          const updated = await rpc('accounts.setSyncInterval', { id, minutes });
          const index = accounts.findIndex(account => account.id === id);
          if (index >= 0) accounts[index] = updated;
          status(t('settings.syncSaved', { minutes }));
        } catch (error) {
          status(`${t('error')} : ${error.message}`, 'error');
        }
      };
    });

    const retentionList = document.getElementById('spam-retention-account-list');
    retentionList.innerHTML = accounts.length ? accounts.map(account => `
      <div class="sync-account-row retention-account-row">
        <span class="account-dot" style="background:${safeColor(account.color)}"></span>
        <span class="sync-account-name">${esc(account.displayName || account.email)}<small>${esc(account.email)}</small></span>
        <label>${esc(t('settings.keepSpamFor'))}</label>
        <input class="sync-minutes" type="number" min="0" max="3650" step="1"
               data-account-retention="${esc(account.id)}" value="${Number(account.spamRetentionDays) || 0}">
        <span>${esc(t('settings.days'))}</span>
      </div>`).join('') : `<div class="empty-hint">${esc(t('settings.noAccounts'))}</div>`;

    retentionList.querySelectorAll('[data-account-retention]').forEach(input => {
      input.onchange = async event => {
        const id = event.currentTarget.dataset.accountRetention;
        const days = Math.max(0, Math.min(3650, Math.round(Number(event.currentTarget.value) || 0)));
        event.currentTarget.value = days;
        try {
          const updated = await rpc('accounts.setSpamRetention', { id, days });
          const index = accounts.findIndex(account => account.id === id);
          if (index >= 0) accounts[index] = updated;
          status(t('settings.retentionSaved', { days }), 'success');
        } catch (error) {
          status(`${t('error')} : ${error.message}`, 'error');
        }
      };
    });
    openModal('settings-modal');
  }

  async function applySetting(key, value) {
    config = await rpc('config.set', { [key]: value });
    if (key === 'theme') {
      document.documentElement.dataset.theme = value;
      applyAccentScheme();
      syncAccentControls();
    }
    if (key === 'accentColor') {
      applyAccentScheme();
      syncAccentControls();
      status(t('settings.accentSaved'), 'success');
    }
    if (key === 'layout') {
      document.getElementById('app').dataset.layout = value;
      applyPaneDimensions();
    }
    if (key === 'locale') {
      await I18N.load(value);
      applyAppVersion();
      applySidebarSectionStates();
      renderSidebar();
      syncListControls();
      list.render(true);
    }
    if (key === 'defaultAccountId') {
      await rpc('accounts.setDefault', { id: value });
      renderSidebar();
    }
    if (key === 'conversationView' || key === 'groupByDate') {
      clearReader();
      syncListControls();
      await refresh();
    }
    if (key === 'autoMarkRead' || key === 'markReadDelaySeconds') clearReadTimer();
  }

  function syncListControls() {
    const sort = document.getElementById('list-sort');
    const direction = document.getElementById('list-sort-direction');
    const grouping = document.getElementById('btn-date-groups');
    if (!sort || !direction || !grouping) return;
    sort.value = config.sortBy || 'date';
    const ascending = (config.sortDirection || 'desc') === 'asc';
    direction.querySelector('i').className = ascending
      ? 'fa-solid fa-arrow-up-short-wide'
      : 'fa-solid fa-arrow-down-wide-short';
    direction.title = t(ascending ? 'sort.ascending' : 'sort.descending');
    const groupActive = config.groupByDate !== false && (config.sortBy || 'date') === 'date';
    grouping.classList.toggle('active', groupActive);
    grouping.disabled = (config.sortBy || 'date') !== 'date';
    grouping.title = t(groupActive ? 'group.disable' : 'group.enable');
  }

  async function applyListPreference(key, value) {
    config = await rpc('config.set', { [key]: value });
    syncListControls();
    clearReader();
    await refresh();
  }

  // ---------- Fermeture ----------
  function openQuitDialog() {
    if (shuttingDown) return;
    const activeCount = activeSyncActivities.size + activeMaintenanceActivities.size;
    const warning = document.getElementById('quit-sync-warning');
    const warningText = document.getElementById('quit-sync-warning-text');
    warning.classList.toggle('hidden', activeCount === 0);
    warningText.textContent = activeCount
      ? t('quit.syncActive', { count: activeCount })
      : '';
    openModal('quit-modal');
  }

  async function shutdownEngineAndExit() {
    if (shuttingDown) return;
    shuttingDown = true;
    closeModals();
    toggleActivityPanel(false);
    status(t('status.shuttingDown'), 'busy');
    try {
      if (ws?.readyState === WebSocket.OPEN) {
        await Promise.race([
          rpc('app.shutdown'),
          new Promise(resolve => setTimeout(resolve, 650)),
        ]);
      }
    } catch {}
    try { await Neutralino.app.exit(0); }
    catch { window.close(); }
  }

  // ---------- Utilitaires ----------
  const openModal = id => document.getElementById(id).classList.add('open');
  const closeModals = () => {
    document.querySelectorAll('.modal-veil').forEach(modal => modal.classList.remove('open'));
    if (pendingConfirmAction) {
      const resolve = pendingConfirmAction;
      pendingConfirmAction = null;
      resolve(false);
    }
  };
  const status = (text, state = 'info') => {
    const bar = document.getElementById('statusbar');
    const textElement = document.getElementById('status-text');
    const icon = document.getElementById('status-icon');
    if (!bar || !textElement || !icon) return;
    bar.dataset.status = state;
    textElement.textContent = text;
    textElement.title = text;
    icon.className = state === 'busy'
      ? 'fa-solid fa-rotate fa-spin'
      : state === 'success'
        ? 'fa-solid fa-circle-check'
        : state === 'error'
          ? 'fa-solid fa-triangle-exclamation'
          : 'fa-solid fa-circle-info';
  };
  const setEngine = connected => {
    document.getElementById('engine-dot').classList.toggle('on', connected);
    if (!I18N.locale) return;
    if (!connected) status(t('status.disconnected'), 'error');
    else if (activeSyncActivities.size === 0) status(t('status.connected'), 'success');
  };

  function normalizeExternalUrl(value) {
    let raw = String(value || '').trim().replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
    if (!raw) return '';
    if (raw.startsWith('//')) raw = `https:${raw}`;
    else if (/^www\./i.test(raw)) raw = `https://${raw}`;

    try {
      const parsed = new URL(raw);
      const protocol = parsed.protocol.toLowerCase();
      if (!['http:', 'https:', 'mailto:'].includes(protocol)) return '';
      if ((protocol === 'http:' || protocol === 'https:') && !parsed.hostname) return '';
      return parsed.href;
    } catch {
      return '';
    }
  }

  function externalLinkDetails(url, displayText = '') {
    const parsed = new URL(url);
    const protocol = parsed.protocol.replace(':', '').toUpperCase();
    const shown = String(displayText || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const shownCandidate = shown.match(/(?:https?:\/\/|www\.)[^\s<>"']+/i)?.[0]
      ?.replace(/[),.;!?]+$/g, '') || '';
    const shownUrl = normalizeExternalUrl(shownCandidate);
    let shownHost = '';
    let realHost = '';
    let mismatch = false;

    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      realHost = parsed.hostname || '';
      if (shownUrl) {
        try {
          const displayed = new URL(shownUrl);
          if (displayed.protocol === 'http:' || displayed.protocol === 'https:') {
            shownHost = displayed.hostname || '';
            const canonicalHost = host => String(host || '').toLowerCase().replace(/^www\./, '');
            mismatch = Boolean(shownHost && realHost && canonicalHost(shownHost) !== canonicalHost(realHost));
          }
        } catch {}
      }
    }

    const insecure = parsed.protocol === 'http:';
    const credentials = Boolean(parsed.username || parsed.password);
    const suspicious = mismatch || insecure || credentials;
    let warning = '';
    if (mismatch) warning = t('link.mismatchWarning', { shown: shownHost, real: realHost });
    else if (credentials) warning = t('link.credentialsWarning');
    else if (insecure) warning = t('link.httpWarning');

    return {
      kind: 'link',
      url,
      domain: realHost || (parsed.protocol === 'mailto:' ? parsed.pathname : ''),
      protocol,
      displayText: shown,
      suspicious,
      warning,
    };
  }

  function previewExternalTarget(value) {
    const raw = String(value || '').trim();
    const normalized = normalizeExternalUrl(raw);
    const statusMessage = document.getElementById('status-message');
    const targetStatus = document.getElementById('link-target-status');
    const targetText = document.getElementById('link-target-text');
    if (!statusMessage || !targetStatus || !targetText) return;
    const displayed = normalized || raw || t('link.invalid');
    targetText.textContent = t('link.statusTarget', { url: displayed });
    targetText.title = displayed;
    statusMessage.classList.add('hidden');
    targetStatus.classList.remove('hidden');
  }

  function clearExternalTarget() {
    const statusMessage = document.getElementById('status-message');
    const targetStatus = document.getElementById('link-target-status');
    if (!statusMessage || !targetStatus) return;
    targetStatus.classList.add('hidden');
    statusMessage.classList.remove('hidden');
  }

  async function openExternal(value, { displayText = '' } = {}) {
    const url = normalizeExternalUrl(value);
    clearExternalTarget();
    if (!url) {
      status(t('link.blockedInvalid'), 'error');
      return false;
    }
    if (externalLinkOpening) return false;
    externalLinkOpening = true;
    try {
      const details = externalLinkDetails(url, displayText);
      const accepted = await confirmAction({
        title: t('link.confirmTitle'),
        message: t('link.confirmMessage'),
        confirmLabel: t('link.open'),
        icon: 'fa-arrow-up-right-from-square',
        danger: false,
        note: t('link.securityNote'),
        details,
      });
      if (!accepted) return false;
      try {
        await rpc('app.openExternal', { url });
      } catch (engineError) {
        // Repli utile en mode développement ou avec un moteur plus ancien.
        await Neutralino.os.open(url);
      }
      status(t('link.opened', { destination: details.domain || url }), 'success');
      return true;
    } catch (error) {
      status(t('link.openFailed', { error: error?.message || String(error) }), 'error');
      return false;
    } finally {
      externalLinkOpening = false;
    }
  }

  function fmtSize(number) {
    const size = Number(number) || 0;
    if (size >= 1073741824) return (size / 1073741824).toFixed(1) + ' Go';
    if (size >= 1048576) return (size / 1048576).toFixed(1) + ' Mo';
    if (size >= 1024) return Math.round(size / 1024) + ' Ko';
    return size + ' o';
  }

  function fmtDateTime(timestamp) {
    const date = new Date(Number(timestamp));
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(I18N.locale, {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  function formatPeriod(oldest, newest) {
    if (!oldest || !newest) return t('stats.noData');
    const first = new Date(Number(oldest)).toLocaleDateString(I18N.locale);
    const last = new Date(Number(newest)).toLocaleDateString(I18N.locale);
    return `${first} → ${last}`;
  }

  const numberFormat = number => new Intl.NumberFormat(I18N.locale).format(Number(number) || 0);
  const safeColor = value => /^#[0-9a-f]{3,8}$/i.test(value || '') ? value : '#8b7dd8';
  const cssEscape = value => window.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');

  function defaultAccentForTheme(theme = document.documentElement.dataset.theme || config.theme || 'dark') {
    return DEFAULT_ACCENTS[theme] || DEFAULT_ACCENTS.dark;
  }

  function normalizeHexColor(value, fallback = defaultAccentForTheme()) {
    let color = String(value || '').trim();
    if (!color) return fallback;
    if (!color.startsWith('#')) color = `#${color}`;
    if (/^#[0-9a-f]{3}$/i.test(color)) color = '#' + color.slice(1).split('').map(char => char + char).join('');
    if (!/^#[0-9a-f]{6}$/i.test(color)) return fallback;
    return color.toUpperCase();
  }

  function hexToRgb(color) {
    const normalized = normalizeHexColor(color);
    return {
      r: parseInt(normalized.slice(1, 3), 16),
      g: parseInt(normalized.slice(3, 5), 16),
      b: parseInt(normalized.slice(5, 7), 16),
    };
  }

  function rgbaFromHex(color, alpha) {
    const { r, g, b } = hexToRgb(color);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function accentForeground(color) {
    const { r, g, b } = hexToRgb(color);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance > 0.58 ? '#1A1408' : '#FFFFFF';
  }

  function accentPresetId(color) {
    const normalized = normalizeHexColor(color);
    return ACCENT_PRESETS.find(preset => normalizeHexColor(preset.color) === normalized)?.id || 'custom';
  }

  function applyAccentScheme() {
    const accent = normalizeHexColor(config.accentColor || defaultAccentForTheme(config.theme));
    const root = document.documentElement;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-soft', rgbaFromHex(accent, root.dataset.theme === 'light' ? 0.12 : 0.14));
    root.style.setProperty('--accent-fg', accentForeground(accent));
  }

  function syncAccentControls(colorValue = config.accentColor || defaultAccentForTheme(config.theme)) {
    const color = normalizeHexColor(colorValue);
    const preset = accentPresetId(color);
    const presetSelect = document.getElementById('set-accent-preset');
    const picker = document.getElementById('set-accent-color');
    const hex = document.getElementById('set-accent-hex');
    const preview = document.getElementById('accent-preview-chip');
    if (presetSelect) presetSelect.value = preset;
    if (picker) picker.value = color;
    if (hex) hex.value = color;
    if (preview) {
      preview.style.background = color;
      preview.style.color = accentForeground(color);
      preview.style.borderColor = rgbaFromHex(color, 0.32);
    }
    document.querySelectorAll('.accent-swatch').forEach(button => {
      button.classList.toggle('active', normalizeHexColor(button.dataset.color, color) === color);
    });
  }

  function colorFrom(value) {
    let hue = 0;
    for (const char of String(value || '')) hue = (hue * 31 + char.codePointAt(0)) % 360;
    return `hsl(${hue} 42% 46%)`;
  }

  function esc(value) {
    return String(value || '').replace(/[&<>"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[character]));
  }

  // ---------- Câblage ----------
  function wire() {
    list = new VirtualMailList(document.getElementById('mail-list'), {
      onOpen: row => openListItem(row).catch(error => {
        console.error('[LibraMail] Lecture du message :', error);
        status(`${t('error')} : ${error.message}`, 'error');
      }),
      onOpenTab: row => openItemInTab(row).catch(error => {
        console.error('[LibraMail] Ouverture de l’onglet :', error);
        status(`${t('error')} : ${error.message}`, 'error');
      }),
      onQuickAction: quickAction,
      onSelectionChange: updateBulkSelection,
    });

    document.getElementById('sidebar').addEventListener('click', event => {
      const item = event.target.closest('[data-view]');
      if (!item) return;
      document.querySelectorAll('.side-item').forEach(button => button.classList.remove('active'));
      item.classList.add('active');
      const selected = item.dataset.view;
      closeQuickLabelMenu();
      view = selected.startsWith('account:')
        ? { type: 'account', accountId: selected.slice(8) }
        : { type: selected };
      const titles = {
        unified: t('unified.inbox'),
        sent: t('sent.folder'),
        spam: t('spam.folder'),
        trash: t('trash.folder'),
      };
      document.getElementById('list-title').textContent = titles[selected]
        || accounts.find(account => account.id === view.accountId)?.email || '';
      updateFolderActionButton();
      clearReader();
      refresh();
    });

    document.getElementById('btn-compose').onclick = () => openCompose(null, 'new');
    document.getElementById('btn-sync').onclick = () => rpc('sync.all').catch(error => status(error.message));
    document.getElementById('btn-select-all').onclick = () => list.selectAll();
    document.getElementById('btn-clear-selection').onclick = () => list.clearSelection();
    document.getElementById('btn-bulk-read').onclick = () => runBulkFlag('seen', true);
    document.getElementById('btn-bulk-unread').onclick = () => runBulkFlag('seen', false);
    document.getElementById('btn-bulk-flag').onclick = event =>
      runBulkFlag('flagged', event.currentTarget.dataset.value !== '0');
    document.getElementById('btn-bulk-label').onclick = toggleBulkLabelMenu;
    document.getElementById('btn-bulk-spam').onclick = runBulkSpam;
    document.getElementById('btn-bulk-delete').onclick = runBulkDelete;
    document.getElementById('btn-empty-folder').onclick = emptyCurrentFolder;
    document.getElementById('btn-confirm-action').onclick = () => resolveConfirmAction(true);
    document.getElementById('btn-cancel-confirm-action').onclick = () => resolveConfirmAction(false);
    document.getElementById('btn-close-confirm-action').onclick = () => resolveConfirmAction(false);
    document.getElementById('btn-contacts').onclick = () => openContacts();
    document.getElementById('btn-stats').onclick = openStatistics;
    document.getElementById('btn-exit').onclick = openQuitDialog;
    document.getElementById('btn-confirm-exit').onclick = shutdownEngineAndExit;
    document.getElementById('btn-send').onclick = send;
    document.getElementById('btn-attach').onclick = attachFile;
    document.getElementById('compose-from').onchange = () => updateComposeSignature({ resetChoice: true });
    document.getElementById('compose-use-signature').onchange = () => updateComposeSignature();
    document.getElementById('btn-toggle-accounts').onclick = () => toggleSidebarSection('accounts');
    document.getElementById('btn-toggle-labels').onclick = () => toggleSidebarSection('labels');
    document.getElementById('btn-add-account').onclick = openNewAccount;
    document.getElementById('btn-add-label').onclick = openLabelManager;
    document.getElementById('btn-save-label').onclick = saveLabel;
    document.getElementById('btn-cancel-label-edit').onclick = () => resetLabelEditor({ focus: true });
    document.getElementById('label-color-picker').oninput = event => setLabelColor(event.target.value);
    document.getElementById('label-color-hex').oninput = event => {
      const color = normalizeLabelColor(event.target.value);
      if (color) {
        document.getElementById('label-color-picker').value = color;
        document.querySelectorAll('#label-color-presets [data-label-color]').forEach(button => {
          button.classList.toggle('selected', button.dataset.labelColor.toLowerCase() === color);
        });
      }
      clearLabelError();
    };
    document.getElementById('label-name').oninput = clearLabelError;
    document.getElementById('label-name').onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); saveLabel(); }
      if (event.key === 'Escape' && editingLabelId !== null) resetLabelEditor({ focus: true });
    };
    document.getElementById('btn-save-account').onclick = saveAccount;
    document.getElementById('btn-delete-account').onclick = deleteEditedAccount;
    document.getElementById('btn-new-contact').onclick = () => resetContactEditor({ focus: true });
    document.getElementById('btn-save-contact').onclick = saveContact;
    document.getElementById('btn-delete-contact').onclick = deleteContact;
    document.getElementById('btn-contact-avatar').onclick = chooseContactAvatar;
    document.getElementById('contact-avatar-file').onchange = handleContactAvatarFile;
    document.getElementById('btn-remove-contact-avatar').onclick = removeContactAvatar;
    document.getElementById('btn-add-contact-group').onclick = addPendingContactGroup;
    document.getElementById('contact-new-group').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addPendingContactGroup();
      }
    });
    ['contact-display-name', 'contact-first-name', 'contact-last-name', 'contact-emails'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => {
        if (!contactAvatarData) updateContactAvatarPreview();
      });
    });
    document.getElementById('btn-cancel-contact-edit').onclick = () => {
      editingContactId = null;
      document.getElementById('contact-editor').classList.add('hidden');
      document.getElementById('contact-editor-empty').classList.remove('hidden');
      document.querySelectorAll('.contact-list-row').forEach(row => row.classList.remove('active'));
    };
    document.getElementById('contacts-search').addEventListener('input', () => {
      clearTimeout(contactsSearchTimer);
      contactsSearchTimer = setTimeout(() => loadContacts().catch(() => {}), 180);
    });
    document.getElementById('contacts-group-filter').onchange = () => loadContacts().catch(() => {});
    document.getElementById('btn-settings').onclick = openSettings;
    document.getElementById('btn-export-backup').onclick = exportCompleteBackup;
    document.getElementById('btn-import-backup').onclick = importCompleteBackup;
    document.getElementById('btn-allow-remote').onclick = openRemoteContentDialog;
    document.getElementById('btn-display-selected-remote').onclick = displaySelectedRemoteContent;
    document.getElementById('btn-display-all-remote').onclick = () => {
      Viewer.allowAllRemote();
      closeRemoteContentDialog();
    };
    document.getElementById('btn-select-all-remote').onclick = () => {
      document.querySelectorAll('#remote-content-modal .remote-resource-checkbox:not(:disabled)').forEach(input => { input.checked = true; });
      updateRemoteDialogState();
    };
    document.getElementById('btn-select-none-remote').onclick = () => {
      document.querySelectorAll('#remote-content-modal .remote-resource-checkbox:not(:disabled)').forEach(input => { input.checked = false; });
      updateRemoteDialogState();
    };
    document.getElementById('btn-theme').onclick = () =>
      applySetting('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    document.getElementById('btn-mode').onclick = event => {
      const mode = Viewer.toggleMode();
      event.currentTarget.querySelector('span').textContent =
        t(mode === 'html' ? 'action.viewtext' : 'action.viewhtml');
    };

    document.getElementById('btn-r-delete').onclick = () =>
      Viewer.current && quickAction(Viewer.current.meta, 'delete');
    document.getElementById('btn-r-spam').onclick = () =>
      Viewer.current && quickAction(Viewer.current.meta, 'spam');
    document.getElementById('btn-r-flag').onclick = () =>
      Viewer.current && quickAction(Viewer.current.meta, 'flag');
    document.getElementById('btn-r-seen').onclick = () => {
      if (!Viewer.current) return;
      setSeenState(Viewer.current.meta, !Boolean(Viewer.current.meta.seen)).catch(error => status(error.message));
    };
    document.getElementById('btn-reply').onclick = () =>
      Viewer.current && openCompose(Viewer.current, 'reply');
    document.getElementById('btn-reply-all').onclick = () =>
      Viewer.current && openCompose(Viewer.current, 'reply-all');
    document.getElementById('btn-forward').onclick = () =>
      Viewer.current && openCompose(Viewer.current, 'forward');
    document.getElementById('btn-r-contact').onclick = openCurrentCorrespondentContact;
    document.getElementById('btn-r-label').onclick = toggleLabelMenu;

    document.addEventListener('click', event => {
      if (!event.target.closest('.compose-address-wrap')) {
        hideContactSuggestions('compose-to');
        hideContactSuggestions('compose-cc');
        hideContactSuggestions('compose-bcc');
      }
      const menu = document.getElementById('label-menu');
      if (!menu.classList.contains('hidden') && !menu.contains(event.target)) {
        menu.classList.add('hidden');
      }
      const quickLabelMenu = document.getElementById('quick-label-menu');
      if (!quickLabelMenu.classList.contains('hidden')
          && !quickLabelMenu.contains(event.target)
          && !event.target.closest('[data-act="label"]')) {
        closeQuickLabelMenu();
      }
      const bulkLabelMenu = document.getElementById('bulk-label-menu');
      const bulkLabelButton = document.getElementById('btn-bulk-label');
      if (!bulkLabelMenu.classList.contains('hidden')
          && !bulkLabelMenu.contains(event.target)
          && !bulkLabelButton.contains(event.target)) {
        closeBulkLabelMenu();
      }
      const activityPanel = document.getElementById('activity-panel');
      const activityButton = document.getElementById('btn-activity');
      if (!activityPanel.classList.contains('hidden')
          && !activityPanel.contains(event.target)
          && !activityButton.contains(event.target)) {
        toggleActivityPanel(false);
      }
    });

    document.getElementById('btn-activity').onclick = event => {
      event.stopPropagation();
      toggleActivityPanel();
    };
    document.getElementById('btn-clear-activity').onclick = clearCompletedActivity;
    document.getElementById('btn-stop-sync').onclick = event => {
      event.stopPropagation();
      stopSync();
    };
    wirePaneResizer(document.getElementById('resize-sidebar'), 'sidebar');
    wirePaneResizer(document.getElementById('resize-list'), 'list');
    document.getElementById('mail-list').addEventListener('scroll', closeQuickLabelMenu, { passive: true });
    window.addEventListener('resize', () => {
      applyPaneDimensions();
      closeQuickLabelMenu();
    });

    let searchTimer;
    const searchInput = document.getElementById('search-input');
    const clearSearchButton = document.getElementById('btn-clear-search');
    searchInput.addEventListener('input', event => {
      updateSearchClearButton();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => searchFor(event.target.value), 280);
    });
    searchInput.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !searchInput.value) return;
      event.preventDefault();
      clearTimeout(searchTimer);
      clearSearch().catch(error => status(`${t('error')} : ${error.message}`, 'error'));
    });
    clearSearchButton.onclick = () => {
      clearTimeout(searchTimer);
      clearSearch().catch(error => status(`${t('error')} : ${error.message}`, 'error'));
    };
    updateSearchClearButton();

    wireContactAutocomplete('compose-to');
    wireContactAutocomplete('compose-cc');
    wireContactAutocomplete('compose-bcc');
    document.querySelectorAll('[data-close]').forEach(button => { button.onclick = closeModals; });
    document.getElementById('set-signature-account').onchange = event => loadSignatureEditor(event.target.value);
    document.getElementById('btn-save-signature').onclick = saveSignatureSettings;
    [
      'set-signature-enabled', 'set-signature-format', 'set-signature-new',
      'set-signature-replies', 'set-signature-forwards', 'set-signature-separator',
      'set-signature-reply-position', 'set-signature-forward-position',
    ].forEach(id => { document.getElementById(id).onchange = renderSettingsSignaturePreview; });
    document.getElementById('set-signature-content').oninput = renderSettingsSignaturePreview;
    document.getElementById('set-accent-preset').onchange = event => {
      const choice = event.target.value;
      if (choice === 'custom') {
        document.getElementById('set-accent-color').focus();
        syncAccentControls();
        return;
      }
      const preset = ACCENT_PRESETS.find(item => item.id === choice);
      if (preset) applySetting('accentColor', preset.color);
    };
    document.getElementById('set-accent-color').oninput = event => syncAccentControls(event.target.value);
    document.getElementById('set-accent-color').onchange = event => applySetting('accentColor', event.target.value);
    document.getElementById('set-accent-hex').oninput = event => {
      const value = String(event.target.value || '').trim();
      if (/^#?[0-9a-fA-F]{3}$/.test(value) || /^#?[0-9a-fA-F]{6}$/.test(value)) {
        syncAccentControls(normalizeHexColor(value));
      }
    };
    const commitAccentHex = event => {
      const value = String(event.currentTarget.value || '').trim();
      if (!value) {
        syncAccentControls();
        return;
      }
      if (!/^#?[0-9a-fA-F]{3}$/.test(value) && !/^#?[0-9a-fA-F]{6}$/.test(value)) {
        status(t('settings.accentInvalid'), 'error');
        syncAccentControls();
        return;
      }
      applySetting('accentColor', value);
    };
    document.getElementById('set-accent-hex').addEventListener('blur', commitAccentHex);
    document.getElementById('set-accent-hex').addEventListener('keydown', event => {
      if (event.key === 'Enter') commitAccentHex({ currentTarget: event.currentTarget });
    });
    document.querySelectorAll('.accent-swatch').forEach(button => {
      button.onclick = () => applySetting('accentColor', button.dataset.color);
    });
    document.getElementById('set-theme').onchange = event => applySetting('theme', event.target.value);
    document.getElementById('set-locale').onchange = event => applySetting('locale', event.target.value);
    document.getElementById('set-layout').onchange = event => applySetting('layout', event.target.value);
    document.getElementById('set-blockremote').onchange = event =>
      applySetting('blockRemoteImages', event.target.value === '1');
    document.getElementById('set-conversations').onchange = event =>
      applySetting('conversationView', event.target.value === '1');
    document.getElementById('set-auto-read').onchange = event =>
      applySetting('autoMarkRead', event.target.value === '1');
    document.getElementById('set-read-delay').onchange = event =>
      applySetting('markReadDelaySeconds', Math.max(0, Math.min(3600, Number(event.target.value) || 0)));
    document.getElementById('set-group-date').onchange = event =>
      applySetting('groupByDate', event.target.value === '1');
    document.getElementById('set-default-account').onchange = event =>
      applySetting('defaultAccountId', event.target.value);

    document.getElementById('list-sort').onchange = event =>
      applyListPreference('sortBy', event.target.value);
    document.getElementById('list-sort-direction').onclick = () =>
      applyListPreference('sortDirection', (config.sortDirection || 'desc') === 'desc' ? 'asc' : 'desc');
    document.getElementById('btn-date-groups').onclick = () =>
      applyListPreference('groupByDate', config.groupByDate === false);

    document.addEventListener('keydown', event => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'w' && activeReaderTabKey !== 'preview' && !document.querySelector('.modal-veil.open')) {
        event.preventDefault();
        closeReaderTab(activeReaderTabKey);
        return;
      }
      if (event.ctrlKey && event.key === 'Tab' && !document.querySelector('.modal-veil.open')) {
        event.preventDefault();
        const keys = ['preview', ...readerTabs.map(tab => tab.key)];
        const current = Math.max(0, keys.indexOf(activeReaderTabKey));
        const direction = event.shiftKey ? -1 : 1;
        const next = (current + direction + keys.length) % keys.length;
        activateReaderTab(keys[next]);
        return;
      }
      if (event.key === 'Escape') {
        toggleActivityPanel(false);
        closeBulkLabelMenu();
        if (bulkSelection.length && !document.querySelector('.modal-veil.open')) list.clearSelection();
      }
    });

    try {
      Neutralino.events.on('windowClose', openQuitDialog);
    } catch {}
  }

  window.addEventListener('DOMContentLoaded', () => {
    try { Neutralino.init(); } catch {}
    wire();
    connect();
  });

  return {
    openExternal,
    previewExternalTarget,
    clearExternalTarget,
    get config() { return config; },
    accountColor: id => accounts.find(account => account.id === id)?.color || 'var(--fg-faint)',
    accountEmail: id => accounts.find(account => account.id === id)?.email || '',
    accountName: id => accounts.find(account => account.id === id)?.displayName || accounts.find(account => account.id === id)?.email || '',
    contactAvatar: value => contactDirectoryEntry(value)?.avatarData || '',
  };
})();
