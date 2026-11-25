/* LibraMail 0.3.2 — planning local, vues multiples et import */
'use strict';
(function () {
  const MINUTE_HEIGHT = 0.8;
  const WEEK_DAY_COUNT = { week: 7, workweek: 5 };
  const state = {
    anchor: startOfDay(new Date()),
    selected: startOfDay(new Date()),
    view: 'month',
    events: [],
    categories: [],
    editorAttachments: [],
    pendingAttachments: [],
    loading: false,
    importing: false,
    filterAccountId: '',
    subscriptions: [],
    editingSubscriptionId: null,
    caldavCalendars: [],
    caldavConnections: [],
    caldavDiscovered: [],
    caldavSetupGeneration: 0,
    caldavSetupBusy: false,
    caldavPasswordEdit: null,
    caldavLoadSequence: 0,
    editingCalDav: null,
    caldavOperationId: '',
    caldavWriteBusy: false,
    caldavWriteBlocked: false,
    googleConnections: [],
    googleCalendars: {},
    googleOAuthFlowId: '',
    googleOAuthPollTimer: null,
    googleMock: { enabled: false, connected: false, connectionId: null, mock: null },
    editingRemoteEvent: false,
    editingRemoteWritable: false,
    summaryTimer: null,
    refreshNoticeTimer: null,
  };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));

  const locale = () => window.I18N?.locale || 'fr';
  function startOfDay(date) { const d = new Date(date); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function firstOfMonth(date) { const d = new Date(date); return new Date(d.getFullYear(), d.getMonth(), 1); }
  function firstOfYear(date) { const d = new Date(date); return new Date(d.getFullYear(), 0, 1); }
  function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
  function addMonths(date, months) { return new Date(date.getFullYear(), date.getMonth() + months, 1); }
  function addMonthsPreserveDay(date, months) {
    const source = new Date(date);
    const targetFirst = new Date(source.getFullYear(), source.getMonth() + months, 1);
    const lastDay = new Date(targetFirst.getFullYear(), targetFirst.getMonth() + 1, 0).getDate();
    return new Date(targetFirst.getFullYear(), targetFirst.getMonth(), Math.min(source.getDate(), lastDay));
  }
  function addYearsPreserveDay(date, years) {
    const source = new Date(date);
    const year = source.getFullYear() + years;
    const lastDay = new Date(year, source.getMonth() + 1, 0).getDate();
    return new Date(year, source.getMonth(), Math.min(source.getDate(), lastDay));
  }
  function mondayOnOrBefore(date) { const d = startOfDay(date); return addDays(d, -((d.getDay() + 6) % 7)); }

  function dateKey(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function parseDateKey(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  }
  function timeValue(date) {
    const d = new Date(date);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function parseLocalDateTime(dateValue, time = '00:00') {
    const d = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const clock = String(time || '00:00').match(/^(\d{2}):(\d{2})$/);
    if (!d || !clock) return NaN;
    return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(clock[1]), Number(clock[2]), 0, 0).getTime();
  }
  function eventColor(event) {
    if (/^#[0-9a-fA-F]{6}$/.test(String(event?.categoryColor || ''))) return event.categoryColor;
    if (/^#[0-9a-fA-F]{6}$/.test(String(event?.color || ''))) return event.color;
    return event?.accountId ? (App.accountColor(event.accountId) || 'var(--accent)') : 'var(--accent)';
  }
  function eventCategoryIcon(event) {
    const icon = /^fa-[a-z0-9-]+$/i.test(String(event?.categoryIcon || '')) ? event.categoryIcon : '';
    return icon ? `<i class="fa-solid ${esc(icon)} planner-event-category-icon"></i>` : '';
  }
  function eventAttachmentIcon(event) {
    const count = Math.max(0, Number(event?.attachmentCount) || 0);
    if (!count) return '';
    const label = count > 1
      ? `${t('planner.attachments')} (${count})`
      : t('planner.attachments');
    return `<i class="fa-solid fa-paperclip planner-event-attachment-icon" title="${esc(label)}" aria-hidden="true"></i>`;
  }
  function formatTime(timestamp) {
    return new Date(Number(timestamp)).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  }
  function formatSelectedDate(date) {
    return date.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function formatMonth(date) {
    const label = date.toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  function formatMonthName(date) {
    const label = date.toLocaleDateString(locale(), { month: 'long' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  function formatWeekRange(start, count) {
    const end = addDays(start, count - 1);
    if (start.getFullYear() !== end.getFullYear()) {
      return `${start.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })} – ${end.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    if (start.getMonth() !== end.getMonth()) {
      return `${start.toLocaleDateString(locale(), { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    return `${start.getDate()} – ${end.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' })}`;
  }
  function eventOverlapsDay(event, day) {
    const from = startOfDay(day).getTime();
    const to = addDays(startOfDay(day), 1).getTime();
    return Number(event.endAt) > from && Number(event.startAt) < to;
  }
  function eventLabel(event) { return event.allDay ? t('planner.allDayShort') : formatTime(event.startAt); }
  function accountLabel(accountId) {
    if (!accountId) return t('planner.localCalendar');
    const account = App.accounts.find(item => String(item.id) === String(accountId));
    return account?.displayName || account?.email || t('planner.localCalendar');
  }
  // A remote event has no mail account_id. Never label it as local.
  function eventSourceLabel(event) {
    if (event.remoteCalendarId) {
      const connection = state.caldavConnections.find(c => Number(c.id) === Number(event.remoteCalendarConnectionId));
      const type = caldavEvent(event)
        ? t(connection?.provider === 'icloud' ? 'planner.caldavApple' : 'planner.caldavGeneric')
        : t('planner.googleCalendar');
      return [event.remoteCalendarName, type].filter(Boolean).join(' · ');
    }
    if (event.subscriptionId || event.subscriptionName) {
      return [event.subscriptionName, 'ICS'].filter(Boolean).join(' · ');
    }
    return accountLabel(event.accountId);
  }
  function eventDetailLabel(event) {
    return [event.categoryName, eventSourceLabel(event), event.location].filter(Boolean).join(' · ');
  }
  function googleWritableRole(role = '') {
    return ['owner', 'writer', 'writerWithoutPrivateAccess'].includes(String(role || ''));
  }
  function googleCalendarById(id) {
    const numericId = Number(id);
    for (const calendars of Object.values(state.googleCalendars || {})) {
      const found = (calendars || []).find(calendar => Number(calendar.id) === numericId);
      if (found) return found;
    }
    return null;
  }
  function writableGoogleCalendars() {
    return state.googleConnections.flatMap(connection => (state.googleCalendars[connection.id] || [])
      .filter(calendar => calendar.selected && googleWritableRole(calendar.accessRole))
      .map(calendar => ({ ...calendar, connectionLabel: googleConnectionLabel(connection) })));
  }
  function googleTargetId(value = document.getElementById('planner-account')?.value || '') {
    const match = String(value || '').match(/^google:(\d+)$/);
    return match ? Number(match[1]) : null;
  }
  function caldavTargetId(value = document.getElementById('planner-account')?.value || '') {
    const match = String(value || '').match(/^caldav:([1-9]\d*)$/);
    return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
  }
  function caldavEvent(event) {
    return Boolean(event?.remoteCalendarId && (
      /^caldav-/.test(String(event.remoteCalendarAccessRole || '')) ||
      state.caldavCalendars.some(calendar => Number(calendar.id) === Number(event.remoteCalendarId))
    ));
  }
  function writableCalDavCalendars() {
    return state.caldavCalendars.filter(calendar => calendar.enabled && calendar.selected && calendar.accessRole === 'caldav-readWrite');
  }
  async function loadCalDavConnections() {
    const sequence = ++state.caldavLoadSequence;
    try {
      const connections = (await App.rpc('calendar.connections.list') || []).filter(c => ['icloud', 'caldav'].includes(c.provider));
      const lists = await Promise.all(connections.map(async connection => (await App.rpc('calendar.remoteCalendars.list', { connectionId: connection.id }) || [])
        .filter(calendar => Number(calendar.connectionId) === Number(connection.id))
        .map(calendar => ({ ...calendar, enabled: connection.enabled === true, connectionLabel: connection.displayName || connection.email || t('planner.caldavCalendar') }))));
      if (sequence !== state.caldavLoadSequence) return;
      state.caldavCalendars = lists.flat();
      state.caldavConnections = connections;
    } catch (_) {
      if (sequence !== state.caldavLoadSequence) return;
      state.caldavConnections = [];
      state.caldavCalendars = []; // fail closed; never replace an explicit remote target with local
    }
    populateAccountSelects();
    renderCalDavConnections();
  }
  function ensureRemoteEditorOption(value, name) {
    const editor = document.getElementById('planner-account');
    if (!editor || !value || [...editor.options].some(option => option.value === value)) return;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = name || t('planner.caldavCalendar');
    option.disabled = true;
    editor.appendChild(option);
  }
  function sortedEvents(events) {
    return [...events].sort((a, b) => Number(b.allDay) - Number(a.allDay) || Number(a.startAt) - Number(b.startAt) || String(a.title).localeCompare(String(b.title), locale()));
  }

  function populateAccountSelects() {
    const filter = document.getElementById('planner-filter-account');
    if (filter) {
      filter.innerHTML = [
        `<option value="">${esc(t('planner.allCalendars'))}</option>`,
        ...App.accounts.map(account => `<option value="${esc(account.id)}">${esc(account.displayName || account.email)}</option>`),
      ].join('');
      filter.value = state.filterAccountId || '';
    }
    const editor = document.getElementById('planner-account');
    if (editor) {
      const current = editor.value || '';
      const currentLabel = editor.selectedOptions?.[0]?.textContent || '';
      const google = writableGoogleCalendars();
      const caldav = writableCalDavCalendars();
      editor.innerHTML = [
        `<option value="">${esc(t('planner.localCalendar'))}</option>`,
        ...App.accounts.map(account => `<option value="${esc(account.id)}">${esc(account.displayName || account.email)}</option>`),
        google.length ? `<optgroup label="${esc(t('planner.googleCalendar'))}">${google.map(calendar => `<option value="google:${Number(calendar.id)}">${esc(calendar.name || calendar.remoteId)} · ${esc(calendar.connectionLabel)}</option>`).join('')}</optgroup>` : '',
        caldav.length ? `<optgroup label="${esc(t('planner.caldavCalendar'))}">${caldav.map(calendar => `<option value="caldav:${Number(calendar.id)}">${esc(calendar.name || t('planner.caldavCalendar'))} · ${esc(calendar.connectionLabel)}</option>`).join('')}</optgroup>` : '',
      ].join('');
      if (/^(?:caldav|google):\d+$/.test(current)) ensureRemoteEditorOption(current, currentLabel);
      if ([...editor.options].some(option => option.value === current)) editor.value = current;
    }
  }


  function populateCategorySelect(selected = '') {
    const select = document.getElementById('planner-category');
    if (!select) return;
    const selectedId = Number(selected) > 0 ? Number(selected) : null;
    const categories = state.categories.filter(category => category.active || Number(category.id) === selectedId);
    select.innerHTML = [
      `<option value="">${esc(t('calendarCategory.none'))}</option>`,
      ...categories.map(category => `<option value="${Number(category.id)}">${esc(category.name)}</option>`),
    ].join('');
    select.value = selectedId ? String(selectedId) : '';
  }

  function renderCategoryLegend() {
    const root = document.getElementById('planner-category-legend');
    if (!root) return;
    const categories = state.categories.filter(category => category.active);
    root.classList.toggle('hidden', categories.length === 0);
    if (!categories.length) {
      root.innerHTML = '';
      return;
    }

    const items = categories.map(category => {
      const color = /^#[0-9a-fA-F]{6}$/.test(String(category.color || ''))
        ? category.color
        : '#4F8BD6';
      return `<span class="planner-category-legend-item"><i class="planner-category-legend-dot" style="--category-color:${esc(color)}" aria-hidden="true"></i><span>${esc(category.name)}</span></span>`;
    }).join('');

    root.innerHTML = `<span class="planner-category-legend-title">${esc(t('planner.legend'))}</span><span class="planner-category-legend-items">${items}</span>`;
  }

  async function loadCategories() {
    try {
      state.categories = await App.rpc('calendar.categories.list', {
        ensureDefaults: true,
        locale: locale(),
      }) || [];
      populateCategorySelect(document.getElementById('planner-category')?.value || '');
      renderCategoryLegend();
    } catch (error) {
      App.status(`${t('error')} : ${error.message}`, 'error');
    }
  }

  function weekdayLabels(narrow = false) {
    const monday = new Date(2026, 7, 10);
    return Array.from({ length: 7 }, (_, index) => {
      const option = narrow ? 'narrow' : 'short';
      return addDays(monday, index).toLocaleDateString(locale(), { weekday: option }).replace('.', '');
    });
  }
  function renderWeekdays(show = true) {
    const root = document.getElementById('planner-weekdays');
    if (!root) return;
    root.classList.toggle('hidden', !show);
    root.innerHTML = show ? weekdayLabels().map(label => `<span>${esc(label)}</span>`).join('') : '';
  }

  function renderPeriodTitle() {
    const title = document.getElementById('planner-period-title');
    if (!title) return;
    if (state.view === 'month') title.textContent = formatMonth(state.anchor);
    else if (state.view === 'year') title.textContent = String(state.anchor.getFullYear());
    else {
      const start = mondayOnOrBefore(state.anchor);
      title.textContent = formatWeekRange(start, WEEK_DAY_COUNT[state.view] || 7);
    }
  }

  function renderViewButtons() {
    document.querySelectorAll('[data-planner-view]').forEach(button => {
      const active = button.dataset.plannerView === state.view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function isWeekend(day) { return [0, 6].includes(new Date(day).getDay()); }

  function syncWeekLayout(root = document.getElementById('planner-grid')) {
    if (!root || !(state.view === 'week' || state.view === 'workweek')) return;
    const scroll = root.querySelector('.planner-week-scroll');
    const header = root.querySelector('.planner-week-header');
    const allDay = root.querySelector('.planner-week-all-day');
    if (!scroll || !header || !allDay) return;
    const gutter = Math.max(0, scroll.offsetWidth - scroll.clientWidth);
    header.style.paddingRight = `${gutter}px`;
    allDay.style.paddingRight = `${gutter}px`;
  }

  function attachEventButtons(root) {
    root.querySelectorAll('[data-planner-event]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        const item = state.events.find(candidate => Number(candidate.id) === Number(button.dataset.plannerEvent));
        if (!item) return;
        state.selected = startOfDay(new Date(item.startAt));
        renderCurrentView();
        renderSelectedDay();
        openEditor(item);
      });
    });
  }

  function renderMonthView() {
    const root = document.getElementById('planner-grid');
    if (!root) return;
    renderWeekdays(true);
    root.className = 'planner-grid planner-month-grid';
    const month = firstOfMonth(state.anchor);
    const gridStart = mondayOnOrBefore(month);
    const todayKey = dateKey(new Date());
    const selectedKey = dateKey(state.selected);
    const monthIndex = month.getMonth();
    root.innerHTML = Array.from({ length: 42 }, (_, index) => {
      const day = addDays(gridStart, index);
      const key = dateKey(day);
      const dayEvents = sortedEvents(state.events.filter(event => eventOverlapsDay(event, day)));
      const visible = dayEvents.slice(0, 3);
      const more = dayEvents.length - visible.length;
      const classes = ['planner-day', day.getMonth() === monthIndex ? '' : 'outside', key === todayKey ? 'today' : '', key === selectedKey ? 'selected' : ''].filter(Boolean).join(' ');
      const eventsHtml = visible.map(event => `
        <button class="planner-event-chip" type="button" data-planner-event="${Number(event.id)}" style="--event-color:${esc(eventColor(event))}" title="${esc(event.title)}">
          <span class="planner-event-time">${esc(eventLabel(event))}</span><span>${eventCategoryIcon(event)}${eventAttachmentIcon(event)}${esc(event.title)}</span>
        </button>`).join('');
      return `<div class="${classes}" role="gridcell" data-planner-day="${key}" tabindex="0">
        <div class="planner-day-number"><span>${day.getDate()}</span></div>
        <div class="planner-day-items">${eventsHtml}${more > 0 ? `<button class="planner-more" type="button" data-planner-day-more="${key}">+${more} ${esc(t('planner.more'))}</button>` : ''}</div>
      </div>`;
    }).join('');

    root.querySelectorAll('[data-planner-day]').forEach(cell => {
      const select = () => selectDay(parseDateKey(cell.dataset.plannerDay));
      cell.addEventListener('click', event => { if (!event.target.closest('[data-planner-event],[data-planner-day-more]')) select(); });
      cell.addEventListener('dblclick', event => {
        if (!event.target.closest('[data-planner-event],[data-planner-day-more]')) { select(); openNewEvent(state.selected); }
      });
      cell.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(); } });
    });
    root.querySelectorAll('[data-planner-day-more]').forEach(button => {
      button.addEventListener('click', event => { event.stopPropagation(); selectDay(parseDateKey(button.dataset.plannerDayMore)); });
    });
    attachEventButtons(root);
  }

  function clippedTimedEvent(event, day) {
    const dayStart = startOfDay(day).getTime();
    const dayEnd = addDays(day, 1).getTime();
    const startAt = Math.max(Number(event.startAt), dayStart);
    const endAt = Math.min(Number(event.endAt), dayEnd);
    if (endAt <= startAt) return null;
    const startMinutes = (startAt - dayStart) / 60000;
    const durationMinutes = Math.max(1, (endAt - startAt) / 60000);
    return { startAt, endAt, startMinutes, durationMinutes };
  }

  function renderWeekView() {
    const root = document.getElementById('planner-grid');
    if (!root) return;
    renderWeekdays(false);
    const dayCount = WEEK_DAY_COUNT[state.view] || 7;
    const start = mondayOnOrBefore(state.anchor);
    const days = Array.from({ length: dayCount }, (_, index) => addDays(start, index));
    const todayKey = dateKey(new Date());
    const selectedKey = dateKey(state.selected);
    root.className = `planner-week-view ${state.view === 'workweek' ? 'workweek' : ''}`;

    const header = days.map(day => {
      const key = dateKey(day);
      return `<button class="planner-week-day-head ${isWeekend(day) ? 'weekend' : ''} ${key === todayKey ? 'today' : ''} ${key === selectedKey ? 'selected' : ''}" type="button" data-planner-week-day="${key}">
        <span>${esc(day.toLocaleDateString(locale(), { weekday: 'short' }).replace('.', ''))}</span><strong>${day.getDate()}</strong>
      </button>`;
    }).join('');

    const allDay = days.map(day => {
      const events = sortedEvents(state.events.filter(event => event.allDay && eventOverlapsDay(event, day)));
      return `<div class="planner-week-all-day-cell ${isWeekend(day) ? 'weekend' : ''}" data-planner-week-day="${dateKey(day)}">${events.slice(0, 4).map(event => `
        <button class="planner-event-chip" type="button" data-planner-event="${Number(event.id)}" style="--event-color:${esc(eventColor(event))}" title="${esc(event.title)}"><span>${eventAttachmentIcon(event)}${esc(event.title)}</span></button>`).join('')}${events.length > 4 ? `<span class="planner-week-more">+${events.length - 4}</span>` : ''}</div>`;
    }).join('');

    const timeGutter = Array.from({ length: 24 }, (_, hour) => `<span style="top:${hour * 60 * MINUTE_HEIGHT}px">${String(hour).padStart(2, '0')}:00</span>`).join('');

    const columns = days.map(day => {
      const key = dateKey(day);
      const events = sortedEvents(state.events.filter(event => !event.allDay && eventOverlapsDay(event, day)));
      return `<div class="planner-week-day-column ${isWeekend(day) ? 'weekend' : ''} ${key === todayKey ? 'today' : ''} ${key === selectedKey ? 'selected' : ''}" data-planner-week-column="${key}">
        ${events.map(event => {
          const clip = clippedTimedEvent(event, day);
          if (!clip) return '';
          const top = Math.round(clip.startMinutes * MINUTE_HEIGHT);
          const height = Math.max(24, Math.round(clip.durationMinutes * MINUTE_HEIGHT));
          return `<button class="planner-week-event" type="button" data-planner-event="${Number(event.id)}" style="--event-color:${esc(eventColor(event))};top:${top}px;height:${height}px" title="${esc(event.title)}">
            <span>${esc(formatTime(clip.startAt))}</span><strong>${eventCategoryIcon(event)}${eventAttachmentIcon(event)}${esc(event.title)}</strong>${event.location ? `<small>${esc(event.location)}</small>` : ''}
          </button>`;
        }).join('')}
      </div>`;
    }).join('');

    root.innerHTML = `
      <div class="planner-week-header" style="grid-template-columns:48px repeat(${dayCount},minmax(90px,1fr))"><span></span>${header}</div>
      <div class="planner-week-all-day" style="grid-template-columns:48px repeat(${dayCount},minmax(90px,1fr))"><span class="planner-week-all-day-label">${esc(t('planner.allDayShort'))}</span>${allDay}</div>
      <div class="planner-week-scroll">
        <div class="planner-week-timeline" style="grid-template-columns:48px repeat(${dayCount},minmax(90px,1fr));--planner-week-height:${24 * 60 * MINUTE_HEIGHT}px">
          <div class="planner-week-time-gutter" style="height:${24 * 60 * MINUTE_HEIGHT}px">${timeGutter}</div>${columns}
        </div>
      </div>`;

    root.querySelectorAll('[data-planner-week-day]').forEach(element => {
      element.addEventListener('click', event => {
        if (event.target.closest('[data-planner-event]')) return;
        selectDay(parseDateKey(element.dataset.plannerWeekDay));
      });
    });
    root.querySelectorAll('[data-planner-week-column]').forEach(column => {
      column.addEventListener('click', event => {
        if (!event.target.closest('[data-planner-event]')) selectDay(parseDateKey(column.dataset.plannerWeekColumn));
      });
      column.addEventListener('dblclick', event => {
        if (event.target.closest('[data-planner-event]')) return;
        const day = parseDateKey(column.dataset.plannerWeekColumn);
        const rect = column.getBoundingClientRect();
        const minutes = Math.max(0, Math.min(23 * 60 + 45, Math.round(((event.clientY - rect.top) / MINUTE_HEIGHT) / 15) * 15));
        selectDay(day);
        openNewEvent(day, minutes);
      });
    });
    attachEventButtons(root);

    requestAnimationFrame(() => {
      const scroll = root.querySelector('.planner-week-scroll');
      if (scroll && !scroll.dataset.initialized) {
        const now = new Date();
        const targetHour = dateKey(now) >= dateKey(start) && dateKey(now) <= dateKey(days[days.length - 1]) ? Math.max(0, now.getHours() - 2) : 7;
        scroll.scrollTop = targetHour * 60 * MINUTE_HEIGHT;
        scroll.dataset.initialized = '1';
      }
      syncWeekLayout(root);
    });
  }

  function renderYearView() {
    const root = document.getElementById('planner-grid');
    if (!root) return;
    renderWeekdays(false);
    root.className = 'planner-year-grid';
    const year = state.anchor.getFullYear();
    const todayKey = dateKey(new Date());
    const selectedKey = dateKey(state.selected);
    const labels = weekdayLabels(true);
    root.innerHTML = Array.from({ length: 12 }, (_, monthIndex) => {
      const month = new Date(year, monthIndex, 1);
      const firstOffset = (month.getDay() + 6) % 7;
      const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
      const cells = Array.from({ length: 42 }, (_, index) => {
        const dayNumber = index - firstOffset + 1;
        if (dayNumber < 1 || dayNumber > daysInMonth) return '<span class="planner-year-day empty"></span>';
        const day = new Date(year, monthIndex, dayNumber);
        const key = dateKey(day);
        const events = sortedEvents(state.events.filter(event => eventOverlapsDay(event, day)));
        const dots = events.slice(0, 3).map(event => `<i style="--event-color:${esc(eventColor(event))}"></i>`).join('');
        return `<button class="planner-year-day ${key === todayKey ? 'today' : ''} ${key === selectedKey ? 'selected' : ''}" type="button" data-planner-year-day="${key}" title="${events.length ? esc(t('planner.eventsCount', { count: events.length })) : ''}"><span>${dayNumber}</span><small>${dots}</small></button>`;
      }).join('');
      return `<section class="planner-year-month"><header>${esc(formatMonthName(month))}</header><div class="planner-year-weekdays">${labels.map(label => `<span>${esc(label)}</span>`).join('')}</div><div class="planner-year-days">${cells}</div></section>`;
    }).join('');
    root.querySelectorAll('[data-planner-year-day]').forEach(button => {
      const select = () => selectDay(parseDateKey(button.dataset.plannerYearDay));
      button.addEventListener('click', select);
      button.addEventListener('dblclick', () => { select(); openNewEvent(state.selected); });
    });
  }

  function renderCurrentView() {
    renderPeriodTitle();
    renderViewButtons();
    if (state.view === 'month') renderMonthView();
    else if (state.view === 'year') renderYearView();
    else renderWeekView();
  }

  function renderSelectedDay() {
    const selected = document.getElementById('planner-selected-date');
    if (selected) selected.textContent = formatSelectedDate(state.selected);
    const list = document.getElementById('planner-day-events');
    const empty = document.getElementById('planner-day-empty');
    if (!list || !empty) return;
    const events = sortedEvents(state.events.filter(event => eventOverlapsDay(event, state.selected)));
    empty.classList.toggle('hidden', events.length > 0);
    list.classList.toggle('hidden', events.length === 0);
    list.innerHTML = events.map(event => `
      <button class="planner-day-event" type="button" data-planner-day-event="${Number(event.id)}" style="--event-color:${esc(eventColor(event))}">
        <span class="planner-day-event-time">${esc(eventLabel(event))}</span>
        <span class="planner-day-event-main"><strong>${eventCategoryIcon(event)}${eventAttachmentIcon(event)}${esc(event.title)}</strong><small>${esc(eventDetailLabel(event))}</small></span>
        <i class="fa-solid fa-chevron-right"></i>
      </button>`).join('');
    list.querySelectorAll('[data-planner-day-event]').forEach(button => {
      button.addEventListener('click', () => {
        const item = state.events.find(candidate => Number(candidate.id) === Number(button.dataset.plannerDayEvent));
        if (item) openEditor(item);
      });
    });
  }

  function render() { renderCurrentView(); renderSelectedDay(); }

  function visibleRange() {
    if (state.view === 'year') {
      const from = firstOfYear(state.anchor);
      return { from: from.getTime(), to: new Date(from.getFullYear() + 1, 0, 1).getTime(), limit: 10000 };
    }
    if (state.view === 'week' || state.view === 'workweek') {
      const from = mondayOnOrBefore(state.anchor);
      return { from: from.getTime(), to: addDays(from, WEEK_DAY_COUNT[state.view] || 7).getTime(), limit: 5000 };
    }
    const from = mondayOnOrBefore(firstOfMonth(state.anchor));
    return { from: from.getTime(), to: addDays(from, 42).getTime(), limit: 5000 };
  }

  async function loadEvents() {
    if (state.loading) return;
    state.loading = true;
    document.getElementById('planner-grid')?.classList.add('loading');
    try {
      state.events = await App.rpc('calendar.list', { ...visibleRange(), accountId: state.filterAccountId || null });
      render();
    } catch (error) {
      App.status(`${t('error')} : ${error.message}`, 'error');
    } finally {
      state.loading = false;
      document.getElementById('planner-grid')?.classList.remove('loading');
    }
  }

  function selectDay(date) {
    if (!date || Number.isNaN(date.getTime())) return;
    state.selected = startOfDay(date);
    renderCurrentView();
    renderSelectedDay();
  }


  async function plannerConfirm(options = {}) {
    if (typeof App.confirmAction !== 'function') {
      App.status(t('planner.dialogUnavailable'), 'error');
      return false;
    }
    return Boolean(await App.confirmAction(options));
  }

  function plannerAttachmentSize(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value} o`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} Ko`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} Mo`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} Go`;
  }

  function renderPlannerAttachments() {
    const root = document.getElementById('planner-attachments-list');
    const empty = document.getElementById('planner-attachments-empty');
    if (!root || !empty) return;

    const stored = state.editorAttachments.map(item => `
      <div class="planner-attachment-row" data-planner-attachment-id="${Number(item.id)}">
        <button class="planner-attachment-open" type="button" data-planner-attachment-open="${Number(item.id)}" title="${esc(t('planner.attachmentOpen'))}">
          <i class="fa-solid fa-paperclip"></i>
          <span><strong>${esc(item.filename)}</strong><small>${esc(plannerAttachmentSize(item.size))}</small></span>
        </button>
        <button class="iconbtn danger-hover" type="button" data-planner-attachment-remove="${Number(item.id)}" title="${esc(t('planner.attachmentRemove'))}">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    `);

    const pending = state.pendingAttachments.map((item, index) => `
      <div class="planner-attachment-row pending">
        <div class="planner-attachment-open">
          <i class="fa-solid fa-paperclip"></i>
          <span><strong>${esc(item.name)}</strong><small>${esc(plannerAttachmentSize(item.size))} · ${esc(t('planner.attachmentPending'))}</small></span>
        </div>
        <button class="iconbtn danger-hover" type="button" data-planner-pending-attachment-remove="${index}" title="${esc(t('planner.attachmentRemove'))}">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    `);

    const rows = [...stored, ...pending];
    root.innerHTML = rows.join('');
    empty.classList.toggle('hidden', rows.length > 0);

    root.querySelectorAll('[data-planner-attachment-open]').forEach(button => {
      const open = async () => {
        try {
          await App.rpc('calendar.attachments.open', { id: Number(button.dataset.plannerAttachmentOpen) });
        } catch (error) {
          if (String(error?.message || '').includes('ATTACHMENT_OPEN_BLOCKED')) {
            App.status(t('attachment.openBlocked'), 'error');
          } else {
            App.status(t('planner.attachmentOpenFailed', { error: error.message }), 'error');
          }
        }
      };
      button.addEventListener('click', open);
      button.addEventListener('dblclick', event => { event.preventDefault(); open(); });
    });

    root.querySelectorAll('[data-planner-attachment-remove]').forEach(button => {
      button.addEventListener('click', async () => {
        const id = Number(button.dataset.plannerAttachmentRemove);
        const item = state.editorAttachments.find(candidate => Number(candidate.id) === id);
        if (!item) return;
        const accepted = await plannerConfirm({
          title: t('planner.attachmentRemoveTitle'),
          message: t('planner.attachmentRemoveConfirm', { name: item.filename }),
          confirmLabel: t('planner.attachmentRemoveAction'),
          icon: 'fa-paperclip',
          danger: true,
        });
        if (!accepted) return;
        try {
          await App.rpc('calendar.attachments.remove', { id });
          state.editorAttachments = state.editorAttachments.filter(candidate => Number(candidate.id) !== id);
          renderPlannerAttachments();
          App.status(t('planner.attachmentRemoved'), 'success');
        } catch (error) {
          App.status(`${t('error')} : ${error.message}`, 'error');
        }
      });
    });

    root.querySelectorAll('[data-planner-pending-attachment-remove]').forEach(button => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.plannerPendingAttachmentRemove);
        if (!Number.isInteger(index) || index < 0) return;
        state.pendingAttachments.splice(index, 1);
        renderPlannerAttachments();
      });
    });
  }

  function resetPlannerAttachments() {
    state.editorAttachments = [];
    state.pendingAttachments = [];
    renderPlannerAttachments();
  }

  async function loadPlannerAttachments(eventId) {
    const numericId = Number(eventId);
    if (!(numericId > 0)) {
      state.editorAttachments = [];
      renderPlannerAttachments();
      return;
    }
    try {
      const rows = await App.rpc('calendar.attachments.list', { eventId: numericId }) || [];
      if (Number(document.getElementById('planner-event-id')?.value || 0) !== numericId) return;
      state.editorAttachments = rows;
      renderPlannerAttachments();
    } catch (error) {
      App.status(`${t('error')} : ${error.message}`, 'error');
    }
  }

  async function selectPlannerAttachments() {
    try {
      const result = await App.rpc('calendar.attachments.selectPaths', {
        title: t('planner.attachmentSelect'),
      });
      const existing = new Set(state.pendingAttachments.map(item => String(item.path)));
      for (const item of result?.items || []) {
        if (!item?.path || existing.has(String(item.path))) continue;
        existing.add(String(item.path));
        state.pendingAttachments.push({
          path: String(item.path),
          name: String(item.name || ''),
          size: Math.max(0, Number(item.size) || 0),
        });
      }
      renderPlannerAttachments();
    } catch (error) {
      App.status(`${t('error')} : ${error.message}`, 'error');
    }
  }

  function closeEditor() {
    if (state.caldavWriteBusy) return;
    state.editingCalDav = null;
    state.caldavOperationId = '';
    state.caldavWriteBlocked = false;
    document.getElementById('planner-editor')?.classList.add('hidden');
    const error = document.getElementById('planner-form-error');
    if (error) error.textContent = '';
    resetPlannerAttachments();
  }

  function setEditorAllDay(allDay) {
    document.querySelectorAll('#planner-editor .planner-time-field').forEach(field => field.classList.toggle('hidden', Boolean(allDay)));
    syncEndConstraints(false);
  }

  function setTimedRangeFromMinutes(day, startMinutes) {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    document.getElementById('planner-start-date').value = dateKey(start);
    document.getElementById('planner-start-time').value = timeValue(start);
    document.getElementById('planner-end-date').value = dateKey(end);
    document.getElementById('planner-end-time').value = timeValue(end);
  }

  function renderGoogleEditorNotice({ remote = false, writable = false, caldav = false } = {}) {
    const notice = document.getElementById('planner-remote-readonly');
    if (!notice) return;
    notice.classList.toggle('hidden', !remote);
    notice.classList.toggle('writable', remote && writable);
    const text = notice.querySelector('span');
    if (text) text.textContent = t(caldav
      ? (writable ? 'planner.caldavWritableEvent' : 'planner.caldavReadOnlyEvent')
      : (writable ? 'planner.googleWritableEvent' : 'planner.googleReadOnlyEvent'));
    const icon = notice.querySelector('i');
    if (icon) icon.className = caldav ? 'fa-solid fa-cloud' : 'fa-brands fa-google';
  }

  function syncEditorTargetMode({ clearPending = false } = {}) {
    if (state.editingRemoteEvent) return;
    const caldavId = caldavTargetId();
    const remoteCalendarId = googleTargetId() || caldavId;
    const remote = Boolean(remoteCalendarId);
    const category = document.getElementById('planner-category');
    if (category) category.disabled = Boolean(caldavId);
    const attachments = document.querySelector('#planner-editor .planner-attachments-section');
    const attach = document.getElementById('btn-planner-attachment-add');
    attachments?.classList.toggle('hidden', remote);
    attach?.classList.toggle('hidden', remote);
    renderGoogleEditorNotice({ remote, writable: remote && (!caldavId || writableCalDavCalendars().some(c => Number(c.id) === caldavId)), caldav: Boolean(caldavId) });
    if (remote && clearPending && state.pendingAttachments.length) resetPlannerAttachments();
  }

  function setRemoteEditorMode(event = null) {
    const remote = Boolean(event?.remoteCalendarId);
    const caldav = caldavEvent(event);
    const writable = remote && (caldav
      ? event.remoteCalendarAccessRole === 'caldav-readWrite' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(String(event.remoteEtag || '')) && !String(event.remoteEventId || '').includes('#') && Boolean(event.remoteEventId)
      : googleWritableRole(event?.remoteCalendarAccessRole));
    const readOnly = remote && !writable;
    state.editingRemoteEvent = remote;
    state.editingRemoteWritable = writable;
    // Snapshot the ETag at opening; an automatic refresh must not replace it.
    state.editingCalDav = caldav ? { id: Number(event.id), remoteCalendarId: Number(event.remoteCalendarId), expectedEtag: event.remoteEtag, startAt: Number(event.startAt), endAt: Number(event.endAt), allDay: Boolean(event.allDay) } : null;
    state.caldavOperationId = '';
    state.caldavWriteBlocked = false;
    const editor = document.getElementById('planner-editor');
    editor?.classList.toggle('remote-readonly', readOnly);
    editor?.classList.toggle('remote-writable', writable);
    renderGoogleEditorNotice({ remote, writable, caldav });
    [
      'planner-title', 'planner-category', 'planner-all-day',
      'planner-start-date', 'planner-start-time', 'planner-end-date', 'planner-end-time',
      'planner-location', 'planner-notes',
    ].forEach(id => {
      const element = document.getElementById(id);
      if (element) element.disabled = readOnly || (caldav && id === 'planner-category');
    });
    const account = document.getElementById('planner-account');
    if (account) account.disabled = remote;
    const save = document.getElementById('btn-planner-save');
    const remove = document.getElementById('btn-planner-delete');
    const attach = document.getElementById('btn-planner-attachment-add');
    const attachments = document.querySelector('#planner-editor .planner-attachments-section');
    if (save) save.disabled = readOnly;
    if (remove) remove.disabled = readOnly;
    save?.classList.toggle('hidden', readOnly);
    remove?.classList.toggle('hidden', readOnly || !document.getElementById('planner-event-id')?.value);
    attach?.classList.toggle('hidden', remote);
    attachments?.classList.toggle('hidden', remote);
  }

  function openNewEvent(date = state.selected, startMinutes = null) {
    if (state.caldavWriteBusy) return;
    const day = startOfDay(date || new Date());
    document.getElementById('planner-event-id').value = '';
    document.getElementById('planner-editor-title').textContent = t('planner.newEvent');
    document.getElementById('planner-title').value = '';
    document.getElementById('planner-account').value = state.filterAccountId || '';
    populateCategorySelect('');
    document.getElementById('planner-all-day').checked = false;
    if (Number.isFinite(startMinutes)) setTimedRangeFromMinutes(day, startMinutes);
    else {
      document.getElementById('planner-start-date').value = dateKey(day);
      document.getElementById('planner-start-time').value = '09:00';
      document.getElementById('planner-end-date').value = dateKey(day);
      document.getElementById('planner-end-time').value = '10:00';
    }
    document.getElementById('planner-location').value = '';
    document.getElementById('planner-notes').value = '';
    resetPlannerAttachments();
    document.getElementById('planner-form-error').textContent = '';
    setRemoteEditorMode(null);
    syncEditorTargetMode();
    document.getElementById('btn-planner-delete').classList.add('hidden');
    setEditorAllDay(false);
    syncEndConstraints(false);
    document.getElementById('planner-editor').classList.remove('hidden');
    document.getElementById('planner-title').focus();
  }

  function openEditor(event) {
    if (state.caldavWriteBusy) return;
    const start = new Date(Number(event.startAt));
    let end = new Date(Number(event.endAt));
    if (event.allDay) end = addDays(end, -1);
    document.getElementById('planner-event-id').value = String(event.id);
    document.getElementById('planner-editor-title').textContent = t('planner.editEvent');
    document.getElementById('planner-title').value = event.title || '';
    const target = event.remoteCalendarId ? `${caldavEvent(event) ? 'caldav' : 'google'}:${Number(event.remoteCalendarId)}` : (event.accountId || '');
    if (event.remoteCalendarId) ensureRemoteEditorOption(target, event.remoteCalendarName);
    document.getElementById('planner-account').value = target;
    populateCategorySelect(event.categoryId || '');
    document.getElementById('planner-all-day').checked = Boolean(event.allDay);
    document.getElementById('planner-start-date').value = dateKey(start);
    document.getElementById('planner-start-time').value = timeValue(start);
    document.getElementById('planner-end-date').value = dateKey(end);
    document.getElementById('planner-end-time').value = timeValue(end);
    document.getElementById('planner-location').value = event.location || '';
    document.getElementById('planner-notes').value = event.notes || '';
    state.pendingAttachments = [];
    state.editorAttachments = [];
    renderPlannerAttachments();
    if (!caldavEvent(event)) loadPlannerAttachments(event.id);
    document.getElementById('planner-form-error').textContent = '';
    setRemoteEditorMode(event);
    if (!event.remoteCalendarId) document.getElementById('btn-planner-delete').classList.remove('hidden');
    setEditorAllDay(Boolean(event.allDay));
    syncEndConstraints(false);
    document.getElementById('planner-editor').classList.remove('hidden');
  }

  function syncEndConstraints(adjustTime = true) {
    const startDateInput = document.getElementById('planner-start-date');
    const startTimeInput = document.getElementById('planner-start-time');
    const endDateInput = document.getElementById('planner-end-date');
    const endTimeInput = document.getElementById('planner-end-time');
    const allDay = document.getElementById('planner-all-day')?.checked;
    if (!startDateInput || !endDateInput || !startDateInput.value) return;
    endDateInput.min = startDateInput.value;
    if (!endDateInput.value || endDateInput.value < startDateInput.value) endDateInput.value = startDateInput.value;
    if (allDay || !adjustTime || endDateInput.value !== startDateInput.value) return;
    const startAt = parseLocalDateTime(startDateInput.value, startTimeInput.value || '00:00');
    const endAt = parseLocalDateTime(endDateInput.value, endTimeInput.value || '00:00');
    if (!Number.isFinite(startAt)) return;
    if (!Number.isFinite(endAt) || endAt <= startAt) {
      const suggested = new Date(startAt + 60 * 60 * 1000);
      endDateInput.value = dateKey(suggested);
      endDateInput.min = startDateInput.value;
      endTimeInput.value = timeValue(suggested);
    }
  }

  function editorPayload() {
    const allDay = document.getElementById('planner-all-day').checked;
    const title = document.getElementById('planner-title').value.trim();
    if (!title) throw new Error(t('planner.titleRequired'));
    const startDate = document.getElementById('planner-start-date').value;
    const endDate = document.getElementById('planner-end-date').value || startDate;
    let startAt, endAt;
    if (allDay) {
      startAt = parseLocalDateTime(startDate, '00:00');
      const endDay = parseDateKey(endDate);
      endAt = endDay ? addDays(endDay, 1).getTime() : NaN;
    } else {
      startAt = parseLocalDateTime(startDate, document.getElementById('planner-start-time').value);
      endAt = parseLocalDateTime(endDate, document.getElementById('planner-end-time').value);
    }
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) throw new Error(t('planner.invalidDate'));
    if (endAt <= startAt) throw new Error(t('planner.invalidRange'));
    const accountValue = document.getElementById('planner-account').value || '';
    const remoteCalendarId = googleTargetId(accountValue);
    const remoteCalendar = remoteCalendarId ? googleCalendarById(remoteCalendarId) : null;
    const accountId = remoteCalendarId ? '' : accountValue;
    const targetColor = remoteCalendar?.color || (accountId ? App.accountColor(accountId) : '');
    return {
      title, startAt, endAt, allDay, accountId, remoteCalendarId,
      categoryId: Number(document.getElementById('planner-category')?.value || 0) || null,
      color: /^#[0-9a-fA-F]{6}$/.test(String(targetColor || '')) ? targetColor : '',
      location: document.getElementById('planner-location').value.trim(),
      notes: document.getElementById('planner-notes').value.trim(),
    };
  }

  function caldavPayload() {
    const { title, startAt, endAt, allDay, location, notes } = editorPayload();
    const original = state.editingCalDav;
    // The existing editor displays minutes, not seconds. Preserve untouched times.
    const restore = (value, old, side) => !allDay && original && !original.allDay
      && document.getElementById(`planner-${side}-date`).value === dateKey(old)
      && document.getElementById(`planner-${side}-time`).value === timeValue(old) ? old : value;
    return { title, startAt: restore(startAt, original?.startAt, 'start'), endAt: restore(endAt, original?.endAt, 'end'), allDay, location, notes };
  }
  function newCalDavOperationId() {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  function caldavWriteMessage(error) {
    const code = /^CalDAV: ([A-Z_]+)/.exec(String(error?.message || ''))?.[1];
    if (code === 'CONFLICT') return ['planner.caldavConflict', true];
    if (code === 'UNSUPPORTED_EVENT' || code === 'ETAG_REQUIRED') return ['planner.caldavUnsupported', true];
    if (code === 'READ_ONLY' || code === 'INVALID_CONNECTION' || code === 'INVALID_SELECTION') return ['planner.caldavReadOnlyEvent', true];
    if (code === 'SYNC_BUSY') return ['planner.caldavBusy', false];
    if (code === 'INVALID_EVENT') return ['planner.caldavInvalidEvent', false];
    if (code === 'AUTHENTICATION_FAILED' || code === 'CREDENTIALS_REQUIRED' || code === 'FORBIDDEN') return ['planner.caldavAuthorization', false];
    // Unknown errors, disconnected RPC and WRITE_UNCERTAIN are not safe to retry blindly.
    return ['planner.caldavUncertain', true];
  }
  async function caldavEditorAction(action) {
    const errorElement = document.getElementById('planner-form-error');
    if (state.caldavWriteBusy || state.caldavWriteBlocked) return;
    const existing = state.editingCalDav;
    const target = caldavTargetId();
    const id = Number(document.getElementById('planner-event-id').value || 0) || null;
    if ((id && (!existing || existing.id !== id || existing.remoteCalendarId !== target)) || (!id && existing)) {
      errorElement.textContent = t('planner.caldavMoveUnsupported'); return;
    }
    if (!target || (existing && !state.editingRemoteWritable) || !writableCalDavCalendars().some(c => Number(c.id) === target)) {
      errorElement.textContent = t('planner.caldavReadOnlyEvent'); return;
    }
    const params = { remoteCalendarId: target };
    if (existing) Object.assign(params, { id: existing.id, expectedEtag: existing.expectedEtag });
    if (action !== 'remove') {
      try { params.event = caldavPayload(); } catch (error) { errorElement.textContent = error.message; return; }
      if (!existing) {
        try { state.caldavOperationId ||= newCalDavOperationId(); }
        catch (_) { errorElement.textContent = t('planner.caldavUnavailable'); return; }
        params.operationId = state.caldavOperationId;
      }
    } else params.confirmed = true; // only called after the existing confirmation dialog
    state.caldavWriteBusy = true;
    const controls = [...document.querySelectorAll('#planner-editor input, #planner-editor select, #planner-editor textarea, #planner-editor button')];
    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    let success = false;
    try {
      const result = await App.rpc(`calendar.caldav.event.${action}`, params);
      if (action === 'remove') {
        if (result?.removed !== true || Number(result.id) !== id) throw new Error('Unconfirmed CalDAV response');
      } else {
        const saved = result?.event;
        if (!saved?.id || Number(saved.remoteCalendarId) !== target || !Number.isFinite(saved.startAt) || (existing && Number(saved.id) !== id)) throw new Error('Unconfirmed CalDAV response');
        state.selected = startOfDay(new Date(saved.startAt));
        state.anchor = startOfDay(state.selected);
      }
      success = true;
    } catch (error) {
      const [key, block] = caldavWriteMessage(error);
      state.caldavWriteBlocked = block;
      errorElement.textContent = t(key);
    } finally {
      controls.forEach((control, i) => { control.disabled = disabled[i]; });
      state.caldavWriteBusy = false;
    }
    if (success) {
      closeEditor();
      await loadEvents();
      App.status(t(action === 'remove' ? 'planner.deleted' : existing ? 'planner.updated' : 'planner.created'), 'success');
    } else if (state.caldavWriteBlocked) {
      document.getElementById('btn-planner-save').disabled = true;
      document.getElementById('btn-planner-delete').disabled = true;
      document.getElementById('planner-account').disabled = true;
      // Keep the form and its contents. No automatic replay or conversion to a local event.
    }
  }
  async function saveEvent() {
    if (state.caldavWriteBusy || state.caldavWriteBlocked) return;
    const errorElement = document.getElementById('planner-form-error');
    errorElement.textContent = '';
    if (state.editingCalDav || caldavTargetId()) return caldavEditorAction(state.editingCalDav ? 'update' : 'create');
    if (state.editingRemoteEvent && !state.editingRemoteWritable) {
      errorElement.textContent = t('planner.googleReadOnlyEvent');
      return;
    }
    const button = document.getElementById('btn-planner-save');
    button.disabled = true;
    try {
      const id = Number(document.getElementById('planner-event-id').value || 0) || null;
      const saved = await App.rpc('calendar.save', { id, event: editorPayload() });
      if (saved?.googleConflict) {
        await loadEvents();
        if (saved.googleRemoved) {
          closeEditor();
          App.status(t('planner.googleConflictRemoved'), 'info');
        } else {
          errorElement.textContent = t('planner.googleConflictUpdate');
        }
        return;
      }
      document.getElementById('planner-event-id').value = String(saved.id);
      if (state.pendingAttachments.length) {
        try {
          const result = await App.rpc('calendar.attachments.addPaths', {
            eventId: saved.id,
            paths: state.pendingAttachments.map(item => item.path),
          });
          state.pendingAttachments = [];
          state.editorAttachments = result?.attachments || [];
        } catch (attachmentError) {
          document.getElementById('planner-editor-title').textContent = t('planner.editEvent');
          renderPlannerAttachments();
          throw new Error(t('planner.attachmentAddFailed', { error: attachmentError.message }));
        }
      }
      state.selected = startOfDay(new Date(saved.startAt));
      state.anchor = startOfDay(state.selected);
      closeEditor();
      await loadEvents();
      App.status(t(id ? 'planner.updated' : 'planner.created'), 'success');
    } catch (error) {
      errorElement.textContent = error.message;
    } finally { button.disabled = false; }
  }

  async function deleteEvent() {
    if (state.caldavWriteBusy || state.caldavWriteBlocked) return;
    if (state.editingRemoteEvent && !state.editingRemoteWritable) {
      App.status(t(state.editingCalDav ? 'planner.caldavReadOnlyEvent' : 'planner.googleReadOnlyEvent'), 'info');
      return;
    }
    const id = Number(document.getElementById('planner-event-id').value || 0);
    if (!id) return;
    const openingCalDav = state.editingCalDav;
    const accepted = await plannerConfirm({
      title: t('planner.deleteTitle'),
      message: t('planner.deleteConfirm'),
      confirmLabel: t('planner.delete'),
      icon: 'fa-trash',
      danger: true,
      note: state.editingCalDav ? t('planner.caldavDeleteNote') : state.editingRemoteEvent
        ? t('planner.googleDeleteNote')
        : t('planner.deleteNote'),
    });
    if (!accepted || Number(document.getElementById('planner-event-id').value || 0) !== id || state.editingCalDav !== openingCalDav) return;
    if (state.editingCalDav) return caldavEditorAction('remove');
    try {
      const result = await App.rpc('calendar.remove', { id });
      if (result?.conflict) {
        await loadEvents();
        if (result.googleRemoved) {
          closeEditor();
          App.status(t('planner.googleConflictRemoved'), 'info');
          return;
        }
        const latest = state.events.find(item => Number(item.id) === id);
        if (latest) openEditor(latest);
        App.status(t('planner.googleConflictDelete'), 'info');
        return;
      }
      closeEditor();
      await loadEvents();
      App.status(t('planner.deleted'), 'success');
    } catch (error) { App.status(`${t('error')} : ${error.message}`, 'error'); }
  }

  function plannerPaneCollapsed() {
    return localStorage.getItem('libramail.plannerPaneCollapsed') === '1';
  }

  function setPlannerPaneCollapsed(collapsed) {
    const app = document.getElementById('app');
    const button = document.getElementById('btn-planner-pane-toggle');
    const value = Boolean(collapsed);
    app?.classList.toggle('planner-pane-collapsed', value);
    localStorage.setItem('libramail.plannerPaneCollapsed', value ? '1' : '0');
    button?.setAttribute('aria-expanded', value ? 'false' : 'true');
    button?.setAttribute('title', t(value ? 'planner.expandPane' : 'planner.collapsePane'));
  }

  function paneDayLabel(date) {
    const today = startOfDay(new Date());
    const day = startOfDay(date);
    const delta = Math.round((day.getTime() - today.getTime()) / 86400000);
    if (delta === 0) return t('planner.today');
    if (delta === 1) return t('planner.tomorrow');
    return day.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' }).replace('.', '');
  }

  function paneEventHtml(event) {
    return `<button class="planner-main-event" type="button" data-planner-summary-event="${Number(event.id)}" style="--event-color:${esc(eventColor(event))}" title="${esc(event.title)}">
      <span class="planner-main-event-time">${esc(event.allDay ? t('planner.allDayShort') : formatTime(event.startAt))}</span>
      <span class="planner-main-event-main"><strong>${eventCategoryIcon(event)}${eventAttachmentIcon(event)}${esc(event.title)}</strong><small>${esc(eventDetailLabel(event))}</small></span>
    </button>`;
  }

  function wireSummaryEventButtons(root, events) {
    root?.querySelectorAll('[data-planner-summary-event]').forEach(button => {
      button.addEventListener('click', () => {
        const event = events.find(item => Number(item.id) === Number(button.dataset.plannerSummaryEvent));
        if (event) openSummaryEvent(event);
      });
    });
  }

  async function openSummaryEvent(event) {
    state.selected = startOfDay(new Date(event.startAt));
    state.anchor = startOfDay(state.selected);
    await openPlanner();
    const item = state.events.find(candidate => Number(candidate.id) === Number(event.id));
    if (item) openEditor(item);
  }

  function renderPlannerSummary(events = []) {
    const now = Date.now();
    // Le volet doit rester strictement chronologique. sortedEvents() privilégie les
    // événements sur toute la journée, ce qui est utile dans une case du calendrier
    // mais ferait passer tous les jours fériés futurs avant les rendez-vous horaires.
    const upcoming = events
      .filter(event => Number(event.endAt) > now)
      .slice()
      .sort((a, b) => Number(a.startAt) - Number(b.startAt)
        || Number(b.allDay) - Number(a.allDay)
        || String(a.title).localeCompare(String(b.title), locale()));
    const today = startOfDay(new Date());
    const todayEvents = upcoming.filter(event => eventOverlapsDay(event, today));
    const laterEvents = upcoming.filter(event => !eventOverlapsDay(event, today)).slice(0, 14);
    const todayRoot = document.getElementById('planner-pane-today');
    const upcomingRoot = document.getElementById('planner-pane-upcoming');
    const empty = document.getElementById('planner-pane-empty');
    const todayDate = document.getElementById('planner-pane-today-date');
    if (todayDate) todayDate.textContent = today.toLocaleDateString(locale(), { day: 'numeric', month: 'short' }).replace('.', '');
    if (todayRoot) {
      todayRoot.innerHTML = todayEvents.length ? todayEvents.map(paneEventHtml).join('') : `<div class="planner-main-date-separator">${esc(t('planner.noEventsToday'))}</div>`;
      wireSummaryEventButtons(todayRoot, todayEvents);
    }
    if (upcomingRoot) {
      let lastKey = '';
      upcomingRoot.innerHTML = laterEvents.map(event => {
        const key = dateKey(new Date(event.startAt));
        const separator = key !== lastKey ? `<div class="planner-main-date-separator">${esc(paneDayLabel(new Date(event.startAt)))}</div>` : '';
        lastKey = key;
        return separator + paneEventHtml(event);
      }).join('');
      wireSummaryEventButtons(upcomingRoot, laterEvents);
    }
    const hasAny = upcoming.length > 0;
    empty?.classList.toggle('hidden', hasAny || todayEvents.length > 0);
    const badge = document.getElementById('planner-count');
    badge?.classList.toggle('hidden', !hasAny);
    badge?.setAttribute('aria-hidden', hasAny ? 'false' : 'true');
    const plannerButton = document.getElementById('btn-planner');
    if (plannerButton) {
      if (hasAny) {
        const next = upcoming[0];
        const when = next.allDay
          ? paneDayLabel(new Date(next.startAt))
          : `${paneDayLabel(new Date(next.startAt))} ${formatTime(next.startAt)}`;
        plannerButton.title = t('planner.nextEventTooltip', { when, title: next.title });
      } else plannerButton.title = t('planner.title');
    }
  }

  async function refreshSummary() {
    try {
      const events = await App.rpc('calendar.list', { from: Date.now(), limit: 250 });
      renderPlannerSummary(events || []);
    } catch {}
  }

  function subscriptionAccountOptions(selected = '') {
    return [
      `<option value="">${esc(t('planner.localCalendar'))}</option>`,
      ...App.accounts.map(account => `<option value="${esc(account.id)}" ${String(account.id) === String(selected) ? 'selected' : ''}>${esc(account.displayName || account.email)}</option>`),
    ].join('');
  }

  function subscriptionStatus(message = '', type = '') {
    const element = document.getElementById('planner-subscription-status');
    if (!element) return;
    element.textContent = message;
    element.className = `planner-subscription-status ${type || ''}`.trim();
  }

  function plannerRefreshStatus(message = '', type = 'info', { sticky = false } = {}) {
    const element = document.getElementById('planner-refresh-summary');
    if (!element) return;
    if (state.refreshNoticeTimer) { clearTimeout(state.refreshNoticeTimer); state.refreshNoticeTimer = null; }
    if (!message) { element.className = 'planner-refresh-summary hidden'; return; }
    const icon = element.querySelector('i');
    const text = element.querySelector('span');
    if (text) text.textContent = message;
    if (icon) icon.className = type === 'busy'
      ? 'fa-solid fa-rotate'
      : type === 'success'
        ? 'fa-solid fa-circle-check'
        : type === 'error'
          ? 'fa-solid fa-triangle-exclamation'
          : 'fa-solid fa-circle-info';
    element.className = `planner-refresh-summary ${type || 'info'}`.trim();
    if (!sticky) state.refreshNoticeTimer = setTimeout(() => {
      element.className = 'planner-refresh-summary hidden';
      state.refreshNoticeTimer = null;
    }, 10000);
  }

  function subscriptionSyncSummary(resultOrResults, { name = '' } = {}) {
    const results = (Array.isArray(resultOrResults) ? resultOrResults : [resultOrResults]).filter(Boolean);
    if (!results.length) return { text: t('planner.syncSummaryNoSubscriptions'), type: 'info' };
    let created = 0;
    let updated = 0;
    let removed = 0;
    let unchangedCalendars = 0;
    let errors = 0;
    let successes = 0;
    for (const result of results) {
      if (result?.error) { errors += 1; continue; }
      successes += 1;
      const itemCreated = Math.max(0, Number(result?.created) || 0);
      const itemUpdated = Math.max(0, Number(result?.updated) || 0);
      const itemRemoved = Math.max(0, Number(result?.removed) || 0);
      created += itemCreated;
      updated += itemUpdated;
      removed += itemRemoved;
      if (result?.notModified || (itemCreated + itemUpdated + itemRemoved) === 0) unchangedCalendars += 1;
    }
    const quantityText = (count, singularKey, pluralKey) => t(count === 1 ? singularKey : pluralKey, { count });
    const parts = [];
    if (created) parts.push(quantityText(created, 'planner.syncSummaryAddedOne', 'planner.syncSummaryAddedMany'));
    if (updated) parts.push(quantityText(updated, 'planner.syncSummaryUpdatedOne', 'planner.syncSummaryUpdatedMany'));
    if (removed) parts.push(quantityText(removed, 'planner.syncSummaryRemovedOne', 'planner.syncSummaryRemovedMany'));
    if (results.length > 1 && unchangedCalendars && unchangedCalendars < results.length) {
      parts.push(quantityText(unchangedCalendars, 'planner.syncSummaryUnchangedOne', 'planner.syncSummaryUnchangedMany'));
    }
    if (errors) parts.push(quantityText(errors, 'planner.syncSummaryErrorsOne', 'planner.syncSummaryErrorsMany'));

    let body;
    if (parts.length) body = parts.join(' · ');
    else if (results.length > 1 && unchangedCalendars === results.length) {
      body = t('planner.syncSummaryNoChangesMany', { count: results.length });
    } else body = t('planner.syncSummaryNoChanges');

    const text = name
      ? t('planner.syncSummaryNamed', { name, summary: body })
      : t(errors ? 'planner.syncSummaryAllWithErrors' : 'planner.syncSummaryAll', { summary: body });
    return { text, type: errors && !successes ? 'error' : errors ? 'info' : 'success' };
  }

  function subscriptionHost(value) {
    try { return new URL(value).hostname; } catch { return value; }
  }

  function formatLastSync(timestamp) {
    if (!Number(timestamp)) return t('planner.neverSynced');
    return new Date(Number(timestamp)).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function formatRefreshInterval(minutes) {
    const value = Math.max(0, Number(minutes) || 0);
    if (!value) return t('planner.refreshManualShort');
    if (value < 60) return t('planner.refreshEveryMinutes', { count: value });
    if (value % 1440 === 0) return t('planner.refreshEveryDays', { count: value / 1440 });
    if (value % 60 === 0) return t('planner.refreshEveryHours', { count: value / 60 });
    return t('planner.refreshEveryMinutes', { count: value });
  }

  function googleStatus(message = '', type = '') {
    const element = document.getElementById('planner-google-status');
    if (!element) return;
    element.textContent = message;
    element.className = `planner-subscription-status ${type || ''}`.trim();
  }

  function googleRoleLabel(role = '') {
    if (role === 'owner') return t('planner.googleRoleOwner');
    if (role === 'writer') return t('planner.googleRoleWriter');
    if (role === 'writerWithoutPrivateAccess') return t('planner.googleRoleWriterPrivate');
    return t('planner.googleRoleReader');
  }

  function googleConnectionLabel(connection = {}) {
    return connection.displayName || connection.email || t('planner.googleCalendar');
  }

  function setGoogleOAuthBusy(busy) {
    const connect = document.getElementById('btn-planner-google-connect');
    const cancel = document.getElementById('btn-planner-google-cancel');
    const clientId = document.getElementById('planner-google-client-id');
    const hint = document.getElementById('planner-google-login-hint');
    if (connect) connect.disabled = Boolean(busy);
    if (clientId) clientId.disabled = Boolean(busy);
    if (hint) hint.disabled = Boolean(busy);
    cancel?.classList.toggle('hidden', !busy);
  }

  function stopGoogleOAuthPolling() {
    if (state.googleOAuthPollTimer) clearInterval(state.googleOAuthPollTimer);
    state.googleOAuthPollTimer = null;
  }

  async function loadGoogleConnections() {
    try {
      state.googleConnections = (await App.rpc('calendar.connections.list') || [])
        .filter(connection => connection.provider === 'google');
      const calendars = {};
      for (const connection of state.googleConnections) {
        calendars[connection.id] = await App.rpc('calendar.remoteCalendars.list', {
          connectionId: connection.id,
        }) || [];
      }
      state.googleCalendars = calendars;
      const clientId = document.getElementById('planner-google-client-id');
      const managed = await App.rpc('calendar.google.oauth.config').catch(() => ({ clientId: '' }));
      const managedId = String(managed?.clientId || '').trim();
      if (managedId && clientId) clientId.value = managedId;
      else if (clientId && !clientId.value && state.googleConnections[0]?.oauthClientId) {
        clientId.value = state.googleConnections[0].oauthClientId;
      }
      document.querySelector('.planner-google-client-id')?.classList.toggle('hidden', Boolean(managedId));
      document.querySelector('.planner-google-client-secret')?.classList.toggle('hidden', Boolean(managedId));
      document.getElementById('planner-google-managed-help')?.classList.toggle('hidden', !managedId);
      document.querySelector('.planner-google-help')?.classList.toggle('hidden', Boolean(managedId));
      renderGoogleConnections();
      populateAccountSelects();
    } catch (error) {
      googleStatus(`${t('error')} : ${error.message}`, 'error');
    }
  }

  function renderGoogleConnections() {
    const root = document.getElementById('planner-google-connections');
    const empty = document.getElementById('planner-google-empty');
    if (!root || !empty) return;
    empty.classList.toggle('hidden', state.googleConnections.length > 0);
    root.classList.toggle('hidden', state.googleConnections.length === 0);
    root.innerHTML = state.googleConnections.map(connection => {
      const calendars = state.googleCalendars[connection.id] || [];
      const status = String(connection.lastStatus || '');
      const error = status === 'error';
      const partial = status === 'partial';
      const meta = error || partial
        ? (connection.lastError || t('planner.lastSync', { date: formatLastSync(connection.lastSyncAt) }))
        : t('planner.lastSync', { date: formatLastSync(connection.lastSyncAt) });
      const calendarRows = calendars.length ? calendars.map(calendar => {
        const color = /^#[0-9a-fA-F]{6}$/.test(String(calendar.color || '')) ? calendar.color : '#4F8BD6';
        const badges = [
          calendar.primary ? `<span class="planner-google-badge">${esc(t('planner.googlePrimary'))}</span>` : '',
          `<span class="planner-google-badge">${esc(googleRoleLabel(calendar.accessRole))}</span>`,
        ].filter(Boolean).join('');
        const name = calendar.name || calendar.remoteId;
        return `<label class="planner-google-calendar-row">
          <input type="checkbox" data-google-calendar-select="${Number(calendar.id)}" ${calendar.selected ? 'checked' : ''} aria-label="${esc(t('planner.googleCalendarEnable', { name }))}">
          <span class="planner-google-calendar-name"><i class="planner-google-calendar-swatch" style="--calendar-color:${esc(color)}"></i><span title="${esc(name)}">${esc(name)}</span></span>
          <span class="planner-google-calendar-badges">${badges}</span>
        </label>`;
      }).join('') : `<div class="planner-google-empty"><i class="fa-regular fa-calendar-xmark"></i><span>${esc(t('planner.googleNoCalendars'))}</span></div>`;
      return `<div class="planner-google-connection" data-google-connection-id="${Number(connection.id)}">
        <div class="planner-google-connection-head">
          <div class="planner-google-connection-main">
            <div class="planner-google-connection-title"><i class="fa-brands fa-google"></i><strong>${esc(googleConnectionLabel(connection))}</strong></div>
            ${connection.email && connection.email !== connection.displayName ? `<small>${esc(connection.email)}</small>` : ''}
            <span class="planner-google-connection-meta"><i class="fa-solid ${error ? 'fa-circle-exclamation error' : partial ? 'fa-triangle-exclamation partial' : 'fa-circle-check ok'}"></i><span title="${esc(meta)}">${esc(meta)}</span></span>
          </div>
          <div class="planner-google-connection-actions">
            <button class="iconbtn" type="button" data-google-sync="${Number(connection.id)}" title="${esc(t('planner.googleSync'))}"><i class="fa-solid fa-rotate"></i></button>
            <button class="iconbtn danger-hover" type="button" data-google-remove="${Number(connection.id)}" title="${esc(t('planner.googleDisconnect'))}"><i class="fa-solid fa-link-slash"></i></button>
          </div>
        </div>
        <div class="planner-google-calendars">${calendarRows}</div>
      </div>`;
    }).join('');

    root.querySelectorAll('[data-google-sync]').forEach(button => button.addEventListener('click', () => syncGoogleConnection(Number(button.dataset.googleSync), button)));
    root.querySelectorAll('[data-google-remove]').forEach(button => button.addEventListener('click', () => disconnectGoogleConnection(Number(button.dataset.googleRemove))));
    root.querySelectorAll('[data-google-calendar-select]').forEach(input => input.addEventListener('change', () => setGoogleCalendarSelected(Number(input.dataset.googleCalendarSelect), input.checked, input)));
  }

  function renderGoogleMockStatus() {
    const box = document.getElementById('planner-google-mock');
    const status = document.getElementById('planner-google-mock-status');
    const connect = document.getElementById('btn-planner-google-mock-connect');
    const advance = document.getElementById('btn-planner-google-mock-advance');
    const expire = document.getElementById('btn-planner-google-mock-expire');
    const conflict = document.getElementById('btn-planner-google-mock-conflict');
    const reset = document.getElementById('btn-planner-google-mock-reset');
    if (!box) return;
    const enabled = Boolean(state.googleMock?.enabled);
    box.classList.toggle('hidden', !enabled);
    if (!enabled) return;
    const connected = Boolean(state.googleMock?.connected);
    if (connect) connect.disabled = connected;
    if (advance) advance.disabled = !connected;
    if (expire) expire.disabled = !connected;
    if (conflict) conflict.disabled = !connected;
    if (reset) reset.disabled = !connected;
    if (status) {
      const revision = Number(state.googleMock?.mock?.revision) || 1;
      status.textContent = connected
        ? t('planner.googleMockConnected', { revision })
        : t('planner.googleMockReady');
    }
  }

  async function loadGoogleMockStatus() {
    try {
      state.googleMock = await App.rpc('calendar.google.mock.status') || { enabled: false };
    } catch {
      state.googleMock = { enabled: false, connected: false, connectionId: null, mock: null };
    }
    renderGoogleMockStatus();
  }

  async function runGoogleMockAction(action, button = null) {
    if (!state.googleMock?.enabled) return;
    if (button) button.disabled = true;
    const status = document.getElementById('planner-google-mock-status');
    if (status) status.textContent = t('planner.googleMockRunning');
    try {
      const result = await App.rpc(`calendar.google.mock.${action}`);
      await Promise.all([loadGoogleConnections(), loadGoogleMockStatus(), refreshSummary()]);
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      if (status) {
        const revision = Number(result?.mock?.revision || state.googleMock?.mock?.revision) || 1;
        status.textContent = action === 'expireSyncToken'
          ? t('planner.googleMockExpiredDone')
          : action === 'advance'
            ? t('planner.googleMockAdvanced', { revision })
            : action === 'conflict'
              ? t('planner.googleMockConflictDone', { revision })
              : action === 'reset'
                ? t('planner.googleMockResetDone')
                : t('planner.googleMockConnected', { revision });
      }
    } catch (error) {
      if (status) status.textContent = `${t('error')} : ${error.message}`;
    } finally {
      renderGoogleMockStatus();
      if (button) button.disabled = false;
    }
  }

  async function handleGoogleOAuthFlow(flow) {
    if (!flow || String(flow.id || '') !== String(state.googleOAuthFlowId || '')) return;
    if (flow.status === 'pending') {
      googleStatus(t('planner.googleWaiting'), 'info');
      return;
    }
    if (flow.status === 'completing') {
      googleStatus(t('planner.googleCompleting'), 'info');
      return;
    }
    stopGoogleOAuthPolling();
    state.googleOAuthFlowId = '';
    setGoogleOAuthBusy(false);
    if (flow.status === 'complete') {
      await loadGoogleConnections();
      await refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      const syncError = flow.result?.syncError || '';
      const syncPending = Boolean(flow.result?.syncPending);
      googleStatus(
        syncError
          ? t('planner.googleConnectedWithError', { error: syncError })
          : syncPending
            ? t('planner.googleConnectedSyncing')
            : t('planner.googleConnected'),
        syncError ? 'error' : (syncPending ? 'info' : 'success'),
      );
    } else if (flow.status === 'cancelled') {
      googleStatus(t('planner.googleConnectionCancelled'), 'info');
    } else if (flow.status === 'timeout') {
      googleStatus(t('planner.googleConnectionTimeout'), 'error');
    } else {
      googleStatus(t('planner.googleConnectionError', { error: flow.error || t('error') }), 'error');
    }
  }

  function startGoogleOAuthPolling(flowId) {
    stopGoogleOAuthPolling();
    state.googleOAuthFlowId = String(flowId || '');
    state.googleOAuthPollTimer = setInterval(async () => {
      if (!state.googleOAuthFlowId) return stopGoogleOAuthPolling();
      try {
        const flow = await App.rpc('calendar.google.oauth.status', { flowId: state.googleOAuthFlowId });
        await handleGoogleOAuthFlow(flow);
      } catch (error) {
        stopGoogleOAuthPolling();
        state.googleOAuthFlowId = '';
        setGoogleOAuthBusy(false);
        googleStatus(t('planner.googleConnectionError', { error: error.message }), 'error');
      }
    }, 800);
  }

  async function connectGoogle() {
    const clientId = document.getElementById('planner-google-client-id')?.value.trim() || '';
    const clientSecret = document.getElementById('planner-google-client-secret')?.value.trim() || '';
    const loginHint = document.getElementById('planner-google-login-hint')?.value.trim() || '';
    if (!clientId) {
      googleStatus(t('planner.googleClientIdRequired'), 'error');
      document.getElementById('planner-google-client-id')?.focus();
      return;
    }
    // Le secret n'est pas requis pour un client natif public avec PKCE.
    setGoogleOAuthBusy(true);
    googleStatus(t('planner.googleConnecting'), 'info');
    try {
      const flow = await App.rpc('calendar.google.oauth.begin', { clientId, clientSecret, loginHint });
      state.googleOAuthFlowId = String(flow?.id || '');
      googleStatus(t('planner.googleWaiting'), 'info');
      startGoogleOAuthPolling(state.googleOAuthFlowId);
    } catch (error) {
      setGoogleOAuthBusy(false);
      googleStatus(t('planner.googleConnectionError', { error: error.message }), 'error');
    }
  }

  async function cancelGoogleConnection() {
    const flowId = state.googleOAuthFlowId;
    if (!flowId) return;
    try { await App.rpc('calendar.google.oauth.cancel', { flowId }); } catch {}
    stopGoogleOAuthPolling();
    state.googleOAuthFlowId = '';
    setGoogleOAuthBusy(false);
    googleStatus(t('planner.googleConnectionCancelled'), 'info');
  }

  function googleSyncMessage(result = {}) {
    if (Number(result.failedCalendars) > 0) {
      return t('planner.googleSyncPartial', { count: Number(result.failedCalendars) });
    }
    return t('planner.googleSynced', {
      created: Number(result.created) || 0,
      updated: Number(result.updated) || 0,
      removed: Number(result.removed) || 0,
    });
  }

  async function syncGoogleConnection(id, button = null) {
    if (button) button.disabled = true;
    googleStatus(t('planner.googleSyncing'), 'info');
    plannerRefreshStatus(t('planner.googleSyncing'), 'busy', { sticky: true });
    try {
      const result = await App.rpc('calendar.google.sync', { id });
      await loadGoogleConnections();
      await refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      const message = googleSyncMessage(result);
      const type = Number(result.failedCalendars) > 0 ? 'info' : 'success';
      googleStatus(message, type);
      plannerRefreshStatus(message, type);
      App.status(message, type);
    } catch (error) {
      await loadGoogleConnections();
      googleStatus(`${t('error')} : ${error.message}`, 'error');
      plannerRefreshStatus(`${t('error')} : ${error.message}`, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function syncAllGoogleConnections() {
    const button = document.getElementById('btn-planner-google-sync-all');
    if (button) button.disabled = true;
    googleStatus(t('planner.googleSyncing'), 'info');
    try {
      const results = await App.rpc('calendar.google.syncAll') || [];
      await loadGoogleConnections();
      await refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      const failed = results.filter(item => !item.ok || Number(item.result?.failedCalendars) > 0).length;
      const totals = results.reduce((sum, item) => {
        const value = item.result || {};
        sum.created += Number(value.created) || 0;
        sum.updated += Number(value.updated) || 0;
        sum.removed += Number(value.removed) || 0;
        return sum;
      }, { created: 0, updated: 0, removed: 0 });
      const message = failed
        ? t('planner.googleSyncPartial', { count: failed })
        : t('planner.googleSynced', totals);
      googleStatus(message, failed ? 'info' : 'success');
    } catch (error) {
      googleStatus(`${t('error')} : ${error.message}`, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function setGoogleCalendarSelected(id, selected, input = null) {
    if (input) input.disabled = true;
    try {
      const result = await App.rpc('calendar.remoteCalendars.select', { id, selected });
      await loadGoogleConnections();
      await refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      googleStatus(t(selected ? 'planner.googleCalendarEnabled' : 'planner.googleCalendarDisabled'), selected ? 'info' : 'success');
      return result;
    } catch (error) {
      if (input) input.checked = !selected;
      googleStatus(`${t('error')} : ${error.message}`, 'error');
    } finally {
      if (input) input.disabled = false;
    }
  }

  async function disconnectGoogleConnection(id) {
    const connection = state.googleConnections.find(item => Number(item.id) === Number(id));
    if (!connection) return;
    const name = googleConnectionLabel(connection);
    const accepted = await plannerConfirm({
      title: t('planner.googleDisconnectTitle'),
      message: t('planner.googleDisconnectConfirm', { name }),
      confirmLabel: t('planner.googleDisconnect'),
      icon: 'fa-link-slash',
      danger: true,
      note: t('planner.googleDisconnectNote'),
    });
    if (!accepted) return;
    try {
      await App.rpc('calendar.connections.remove', { id });
      await loadGoogleConnections();
      await refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      googleStatus(t('planner.googleDisconnected'), 'success');
    } catch (error) {
      googleStatus(`${t('error')} : ${error.message}`, 'error');
    }
  }

  function renderSubscriptions() {
    const root = document.getElementById('planner-subscriptions-list');
    const empty = document.getElementById('planner-subscriptions-empty');
    if (!root || !empty) return;
    empty.classList.toggle('hidden', state.subscriptions.length > 0);
    root.classList.toggle('hidden', state.subscriptions.length === 0);
    root.innerHTML = state.subscriptions.map(subscription => {
      const error = subscription.lastStatus === 'error';
      const syncText = t('planner.lastSync', { date: formatLastSync(subscription.lastSyncAt) });
      const statusText = `${error ? subscription.lastError : syncText} · ${formatRefreshInterval(subscription.refreshMinutes)}`;
      const displayColor = /^#[0-9a-fA-F]{6}$/.test(String(subscription.color || '')) ? subscription.color : '#4F8BD6';
      return `<div class="planner-subscription-row ${Number(state.editingSubscriptionId) === Number(subscription.id) ? 'editing' : ''}" data-subscription-id="${Number(subscription.id)}">
        <div class="planner-subscription-main">
          <strong class="planner-subscription-title"><i class="planner-subscription-swatch" style="--subscription-color:${esc(displayColor)}"></i><span>${esc(subscription.name || subscriptionHost(subscription.url))}</span></strong>
          <small>${esc(subscriptionHost(subscription.url))}</small>
          <span class="planner-subscription-meta"><i class="fa-solid ${error ? 'fa-circle-exclamation error' : 'fa-circle-check ok'}"></i><span title="${esc(statusText)}">${esc(statusText)}</span></span>
        </div>
        <div class="planner-subscription-actions">
          <button class="iconbtn" type="button" data-subscription-edit="${Number(subscription.id)}" title="${esc(t('planner.editSubscription'))}"><i class="fa-solid fa-pen"></i></button>
          <button class="iconbtn" type="button" data-subscription-sync="${Number(subscription.id)}" title="${esc(t('planner.syncSubscription'))}"><i class="fa-solid fa-rotate"></i></button>
          <button class="iconbtn danger-hover" type="button" data-subscription-remove="${Number(subscription.id)}" title="${esc(t('planner.removeSubscription'))}"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`;
    }).join('');
    root.querySelectorAll('[data-subscription-edit]').forEach(button => button.addEventListener('click', () => editSubscription(Number(button.dataset.subscriptionEdit))));
    root.querySelectorAll('[data-subscription-sync]').forEach(button => button.addEventListener('click', () => syncSubscription(Number(button.dataset.subscriptionSync), button)));
    root.querySelectorAll('[data-subscription-remove]').forEach(button => button.addEventListener('click', () => removeSubscription(Number(button.dataset.subscriptionRemove))));
  }

  async function loadSubscriptions() {
    try {
      state.subscriptions = await App.rpc('calendar.subscriptions.list') || [];
      renderSubscriptions();
    } catch (error) {
      subscriptionStatus(`${t('error')} : ${error.message}`, 'error');
    }
  }

  function resetSubscriptionEditor() {
    state.editingSubscriptionId = null;
    const url = document.getElementById('planner-subscription-url');
    const name = document.getElementById('planner-subscription-name');
    const account = document.getElementById('planner-subscription-account');
    const color = document.getElementById('planner-subscription-color');
    const refresh = document.getElementById('planner-subscription-refresh');
    const button = document.getElementById('btn-planner-subscription-add');
    const cancel = document.getElementById('btn-planner-subscription-cancel-edit');
    if (url) url.value = '';
    if (name) name.value = '';
    if (account) account.innerHTML = subscriptionAccountOptions(state.filterAccountId || '');
    if (color) color.value = '#4F8BD6';
    if (refresh) refresh.value = '30';
    if (button) button.innerHTML = `<i class="fa-solid fa-link"></i><span>${esc(t('planner.subscribe'))}</span>`;
    cancel?.classList.add('hidden');
    renderSubscriptions();
  }

  function editSubscription(id) {
    const subscription = state.subscriptions.find(item => Number(item.id) === Number(id));
    if (!subscription) return;
    state.editingSubscriptionId = Number(subscription.id);
    const url = document.getElementById('planner-subscription-url');
    const name = document.getElementById('planner-subscription-name');
    const account = document.getElementById('planner-subscription-account');
    const color = document.getElementById('planner-subscription-color');
    const refresh = document.getElementById('planner-subscription-refresh');
    const button = document.getElementById('btn-planner-subscription-add');
    const cancel = document.getElementById('btn-planner-subscription-cancel-edit');
    if (url) url.value = subscription.url || '';
    if (name) name.value = subscription.name || '';
    if (account) account.innerHTML = subscriptionAccountOptions(subscription.accountId || '');
    if (color) color.value = /^#[0-9a-fA-F]{6}$/.test(String(subscription.color || '')) ? subscription.color : '#4F8BD6';
    if (refresh) refresh.value = String(Math.max(0, Number(subscription.refreshMinutes) || 0));
    if (button) button.innerHTML = `<i class="fa-solid fa-floppy-disk"></i><span>${esc(t('planner.saveSubscription'))}</span>`;
    cancel?.classList.remove('hidden');
    subscriptionStatus(t('planner.editingSubscription', { name: subscription.name || subscriptionHost(subscription.url) }));
    renderSubscriptions();
    url?.focus();
  }

  const cdEl = suffix => document.getElementById('planner-caldav-' + suffix);
  const cdBtn = suffix => document.getElementById('btn-planner-caldav-' + suffix);
  const cdProvider = () => document.getElementById('planner-calendar-provider')?.value || 'icloud';
  function cdStatus(key = '', type = '') {
    const el = cdEl('status');
    if (el) { el.textContent = key ? t(key) : ''; el.className = `planner-subscription-status ${type}`.trim(); }
  }
  function cdError(error) {
    const code = /^CalDAV: ([A-Z_]+)/.exec(String(error?.message || ''))?.[1];
    if (code === 'SYNC_BUSY') return 'planner.caldavBusy';
    if (['AUTHENTICATION_FAILED','FORBIDDEN','CREDENTIALS_REQUIRED','INVALID_CREDENTIALS'].includes(code)) return 'planner.caldavAuthorization';
    if (code === 'INVALID_URL' || code === 'CROSS_ORIGIN' || code === 'REDIRECT_BLOCKED') return 'planner.caldavInvalidServer';
    if (code === 'DUPLICATE_CONNECTION') return 'planner.caldavDuplicate';
    if (code === 'INVALID_SELECTION') return 'planner.caldavSelectRequired';
    if (code === 'INVALID_INTERVAL') return 'planner.caldavIntervalHelp';
    if (['NETWORK_ERROR','TIMEOUT'].includes(code)) return 'planner.caldavNetwork';
    if (code === 'RUNTIME_UNAVAILABLE') return 'planner.caldavUnavailable';
    return 'planner.caldavSetupError';
  }
  function cdDiagnostic(code) { return /^[A-Z_]{1,80}$/.test(String(code || '')) ? ` (${code})` : ''; }
  function cdInvalidate() {
    state.caldavDiscovered = [];
    const root = cdEl('discovery');
    if (root) { root.innerHTML = ''; root.classList.add('hidden'); }
    cdBtn('add')?.classList.add('hidden');
  }
  function cdControls() {
    const busy = state.caldavSetupBusy, edit = Boolean(state.caldavPasswordEdit);
    const provider = document.getElementById('planner-calendar-provider');
    if (provider) provider.disabled = busy || edit;
    for (const id of ['user','server','name','refresh']) if (cdEl(id)) cdEl(id).disabled = busy || edit;
    if (cdEl('password')) cdEl('password').disabled = busy;
    const toggle = document.querySelector('[data-password-toggle="planner-caldav-password"]');
    if (toggle) toggle.disabled = busy;
    for (const id of ['test','add','cancel']) if (cdBtn(id)) cdBtn(id).disabled = busy;
    document.querySelectorAll('#planner-caldav-discovery input, #planner-caldav-connections input, #planner-caldav-connections button').forEach(el => { el.disabled = busy || edit; });
    if (cdBtn('test')) cdBtn('test').textContent = t(edit ? 'planner.caldavReplacePassword' : 'planner.caldavTest');
    cdBtn('cancel')?.classList.toggle('hidden', !edit);
  }
  function cdClearPassword() {
    const input = cdEl('password');
    if (input) { input.value = ''; input.type = 'password'; }
    const toggle = document.querySelector('[data-password-toggle="planner-caldav-password"]');
    if (toggle) {
      toggle.title = t('security.showPassword');
      toggle.setAttribute('aria-label', toggle.title);
      const icon = toggle.querySelector('i');
      if (icon) icon.className = 'fa-solid fa-eye';
    }
  }
  function cdReset() {
    state.caldavSetupGeneration++;
    state.caldavPasswordEdit = null;
    for (const id of ['server','user','name']) if (cdEl(id)) cdEl(id).value = '';
    cdClearPassword();
    if (cdEl('refresh')) cdEl('refresh').value = '15';
    cdInvalidate(); cdStatus(); cdControls();
  }
  function cdSwitch() {
    cdReset();
    const provider = cdProvider(), apple = provider === 'icloud';
    document.getElementById('planner-provider-google')?.classList.toggle('hidden', provider !== 'google');
    document.getElementById('planner-provider-ics')?.classList.toggle('hidden', provider !== 'ics');
    document.getElementById('planner-provider-caldav')?.classList.toggle('hidden', !['icloud','caldav'].includes(provider));
    cdEl('server-field')?.classList.toggle('hidden', apple);
    cdEl('apple-help')?.classList.toggle('hidden', !apple);
    if (cdEl('user-label')) cdEl('user-label').textContent = t(apple ? 'planner.caldavAppleId' : 'planner.caldavUsername');
    if (cdEl('password-label')) cdEl('password-label').textContent = t(apple ? 'planner.caldavAppPassword' : 'planner.caldavPassword');
    renderCalDavConnections();
  }
  function cdInput() {
    const provider = cdProvider();
    if (!['icloud','caldav'].includes(provider)) throw new Error('CalDAV: INVALID_OPTIONS');
    const username = cdEl('user')?.value.trim() || '';
    const password = cdEl('password')?.value || '';
    const serverURL = provider === 'icloud' ? 'https://caldav.icloud.com/' : (cdEl('server')?.value.trim() || '');
    const refreshMinutes = Number(cdEl('refresh')?.value);
    if (!username || !password) throw new Error('CalDAV: INVALID_CREDENTIALS');
    if (!serverURL) throw new Error('CalDAV: INVALID_URL');
    if (!Number.isInteger(refreshMinutes) || refreshMinutes < 5 || refreshMinutes > 1440) throw new Error('CalDAV: INVALID_INTERVAL');
    return {provider,username,password,serverURL,refreshMinutes,displayName:cdEl('name')?.value.trim() || ''};
  }
  async function cdRun(task) {
    if (state.caldavSetupBusy) return;
    const generation = state.caldavSetupGeneration;
    const current = () => generation === state.caldavSetupGeneration;
    state.caldavSetupBusy = true; cdControls();
    try { await task(current); }
    catch (error) { if (current()) { cdStatus(cdError(error), 'error'); const code = /^CalDAV: ([A-Z_]+)/.exec(String(error?.message || ''))?.[1]; if (code && cdEl('status')) cdEl('status').textContent += cdDiagnostic(code); } }
    finally { state.caldavSetupBusy = false; cdControls(); }
  }
  function cdRenderDiscovery() {
    const root = cdEl('discovery'); if (!root) return;
    root.innerHTML = `<strong>${esc(t('planner.caldavChooseCalendars'))}</strong>` + state.caldavDiscovered.map((cal,i) =>
      `<div class="planner-caldav-calendar-row"><label><input type="checkbox" data-cd-choice="${i}" checked><span>${esc(cal.name)}</span></label><small>${esc(t(cal.readOnly ? 'planner.caldavReadAccess' : 'planner.caldavWriteAccess'))}</small><input type="color" data-cd-color="${i}" value="#4F8BD6" title="${esc(t('planner.color'))}" aria-label="${esc(t('planner.color'))}"></div>`).join('');
    root.classList.toggle('hidden', !state.caldavDiscovered.length);
    cdBtn('add')?.classList.toggle('hidden', !state.caldavDiscovered.length);
    cdControls();
  }
  async function cdTest() {
    return cdRun(async current => {
      if (state.caldavPasswordEdit) {
        const id = state.caldavPasswordEdit;
        const password = cdEl('password')?.value || '';
        if (!password) throw new Error('CalDAV: INVALID_CREDENTIALS');
        cdStatus('planner.caldavTesting');
        try { await App.rpc('calendar.caldav.replacePassword', {id,password}); }
        finally { if (current()) cdClearPassword(); }
        if (current()) { cdReset(); cdStatus('planner.caldavPasswordUpdated','success'); }
        return;
      }
      cdInvalidate(); cdStatus('planner.caldavTesting');
      const calendars = await App.rpc('calendar.caldav.preview', cdInput());
      if (!current()) return;
      state.caldavDiscovered = Array.isArray(calendars) ? calendars.filter(c => typeof c.url === 'string' && typeof c.name === 'string') : [];
      cdRenderDiscovery();
      cdStatus(state.caldavDiscovered.length ? 'planner.caldavDiscovered' : 'planner.caldavNoCalendars', state.caldavDiscovered.length ? 'success' : 'info');
    });
  }
  async function cdRefreshAfterChange() {
    await loadCalDavConnections(); await refreshSummary();
    if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
  }
  async function cdAdd() {
    return cdRun(async current => {
      const root = cdEl('discovery');
      const selected = [...root.querySelectorAll('[data-cd-choice]:checked')].map(el => Number(el.dataset.cdChoice));
      if (!selected.length || selected.some(i => !state.caldavDiscovered[i])) throw new Error('CalDAV: INVALID_SELECTION');
      const input = cdInput();
      const selectedURLs = selected.map(i => state.caldavDiscovered[i].url);
      const calendarColors = selected.map(i => ({url:state.caldavDiscovered[i].url,color:root.querySelector(`[data-cd-color="${i}"]`)?.value || '#4F8BD6'}));
      cdStatus('planner.caldavAdding');
      let result;
      try { result = await App.rpc('calendar.caldav.add', {...input,selectedURLs,calendarColors}); }
      catch (error) { if(current()) { cdClearPassword(); cdInvalidate(); await loadCalDavConnections(); } throw error; }
      if (current()) { cdClearPassword(); cdInvalidate(); }
      if (!result?.connection?.id) throw new Error('Unconfirmed account');
      const wasOpen = current();
      if (wasOpen) { cdReset(); cdStatus('planner.caldavAdded','success'); }
      const savedGeneration = state.caldavSetupGeneration;
      await cdRefreshAfterChange();
      // Do not repeat the add on a failed first pull: the account is already saved.
      if (!wasOpen || savedGeneration !== state.caldavSetupGeneration) return;
      let synced = false;
      try {
        const sync = await App.rpc('calendar.caldav.sync',{id:result.connection.id});
        synced = !!sync && !sync.failed && !sync.error && sync.synced > 0;
      } catch (_) { /* periodic/manual sync will retry */ }
      await cdRefreshAfterChange();
      if (savedGeneration === state.caldavSetupGeneration) cdStatus(synced ? 'planner.caldavAddedSynced' : 'planner.caldavAddedPending',synced ? 'success' : 'info');
    });
  }
  function cdBeginPassword(connection) {
    if (state.caldavSetupBusy) return;
    cdReset(); state.caldavPasswordEdit = Number(connection.id);
    cdEl('user').value = connection.email || ''; cdEl('server').value = connection.caldavServerURL || '';
    cdEl('name').value = connection.displayName || ''; cdEl('refresh').value = String(connection.caldavRefreshMinutes || 15);
    cdControls(); cdStatus('planner.caldavPasswordEdit'); cdEl('password').focus();
  }
  function cdSyncError(code) {
    return t(/^UNSUPPORTED_EVENT(?:_|$)/.test(String(code || '')) ? 'planner.caldavUnsupportedEvents' : 'planner.caldavSyncFailed') + cdDiagnostic(code);
  }
  function renderCalDavConnections() {
    const root = cdEl('connections'); if (!root) return;
    const provider = cdProvider();
    const connections = state.caldavConnections.filter(c => c.provider === provider);
    root.innerHTML = connections.length ? connections.map(c => {
      const id = Number(c.id);
      const rows = state.caldavCalendars.filter(cal => Number(cal.connectionId) === id);
      const calendars = rows.map(cal => {
        const status = !cal.selected || !c.enabled ? t('planner.caldavInactive') : cal.lastStatus === 'error'
          ? cdSyncError(cal.lastError)
          : t('planner.lastSync',{date:formatLastSync(cal.lastSyncAt)});
        return `<div class="planner-caldav-calendar-row"><label><input type="checkbox" data-cd-select="${Number(cal.id)}" ${cal.selected?'checked':''}><span>${esc(cal.name)}</span></label><small>${esc(status)}</small><small>${esc(t(cal.accessRole === 'caldav-readWrite' ? 'planner.caldavWriteAccess':'planner.caldavReadAccess'))}</small></div>`;
      }).join('');
      const meta = t('planner.lastSync',{date:formatLastSync(c.lastSyncAt)}) + (c.lastStatus === 'error' ? ' · ' + cdSyncError(c.lastError) : '');
      return `<div class="planner-caldav-account" data-cd-account="${id}"><div class="planner-caldav-account-head"><strong>${esc(c.displayName || c.email)}</strong><div class="planner-caldav-actions"><button type="button" class="btn compact" data-cd-sync="${id}">${esc(t('planner.syncSubscription'))}</button><button type="button" class="btn compact" data-cd-password="${id}">${esc(t('planner.caldavReplacePassword'))}</button><button type="button" class="btn compact" data-cd-remove="${id}">${esc(t('planner.caldavRemoveAccount'))}</button></div></div><div class="planner-caldav-meta">${esc(c.email)} · ${esc(meta)}</div><div class="planner-caldav-settings"><label for="cd-interval-${id}">${esc(t('planner.refreshInterval'))}</label><input id="cd-interval-${id}" type="number" min="5" max="1440" value="${Number(c.caldavRefreshMinutes)||15}"><label><input id="cd-enabled-${id}" type="checkbox" ${c.enabled?'checked':''}> ${esc(t('planner.caldavEnabled'))}</label><button type="button" class="btn compact" data-cd-config="${id}">${esc(t('planner.saveSubscription'))}</button></div>${calendars}</div>`;
    }).join('') : `<p class="planner-caldav-meta">${esc(t('planner.caldavNoAccounts'))}</p>`;
    const bind = (key,fn,event='click') => root.querySelectorAll(`[data-cd-${key}]`).forEach(el => el.addEventListener(event,() => fn(el,Number(el.getAttribute('data-cd-'+key)))));
    bind('password',(_,id)=>{const c=connections.find(c=>Number(c.id)===id);if(c) cdBeginPassword(c);});
    bind('sync',(_,id)=>cdRun(async current=>{
      cdStatus('planner.subscriptionSyncing');
      const r=await App.rpc('calendar.caldav.sync',{id});
      await cdRefreshAfterChange();
      const ok = !!r && !r.failed && !r.error;
      if(current()) cdStatus(ok ? 'planner.caldavSynced' : r?.partial ? 'planner.caldavUnsupportedEvents' : 'planner.caldavSyncFailed',ok?'success':'error');
    }));
    bind('config',(_,id)=>cdRun(async current=>{
      const refreshMinutes=Number(document.getElementById(`cd-interval-${id}`)?.value);
      const enabled=Boolean(document.getElementById(`cd-enabled-${id}`)?.checked);
      await App.rpc('calendar.caldav.configure',{id,refreshMinutes,enabled});
      await cdRefreshAfterChange(); if(current()) cdStatus('planner.caldavSettingsSaved','success');
    }));
    bind('select',(el,id)=>cdRun(async current=>{
      const selected=el.checked;
      try {
        if(!selected && !await plannerConfirm({title:t('planner.caldavDeselectTitle'),message:t('planner.caldavDeselectNote'),confirmLabel:t('planner.saveSubscription')})) {el.checked=true;return;}
        if(!current()) return;
        await App.rpc('calendar.remoteCalendars.select',{id,selected});
        await cdRefreshAfterChange();
        if(current()) cdStatus('planner.caldavSettingsSaved','success');
      } catch(e) {el.checked=!selected;throw e;}
    }),'change');
    bind('remove',(_,id)=>cdRun(async current=>{
      if(!await plannerConfirm({title:t('planner.caldavRemoveTitle'),message:t('planner.caldavRemoveNote'),confirmLabel:t('planner.caldavRemoveAccount'),danger:true}))return;
      if(!current())return;
      await App.rpc('calendar.connections.remove',{id}); await cdRefreshAfterChange();
      if(current()) cdStatus('planner.caldavRemoved','success');
    }));
    cdControls();
  }

  function closeSubscriptions() {
    cdReset();
    resetSubscriptionEditor();
    document.getElementById('planner-subscriptions-modal')?.classList.remove('open');
  }

  async function openSubscriptions() {
    resetSubscriptionEditor();
    cdSwitch();
    document.getElementById('planner-subscriptions-modal')?.classList.add('open');
    subscriptionStatus('');
    googleStatus('');
    await Promise.all([loadSubscriptions(), loadGoogleConnections(), loadGoogleMockStatus(), loadCalDavConnections()]);
  }

  async function saveSubscription() {
    const url = document.getElementById('planner-subscription-url')?.value.trim() || '';
    const name = document.getElementById('planner-subscription-name')?.value.trim() || '';
    const accountId = document.getElementById('planner-subscription-account')?.value || '';
    const color = document.getElementById('planner-subscription-color')?.value || '';
    const refreshMinutes = Math.max(0, Number(document.getElementById('planner-subscription-refresh')?.value) || 0);
    if (!url) { subscriptionStatus(t('planner.subscriptionUrlRequired'), 'error'); return; }
    const button = document.getElementById('btn-planner-subscription-add');
    const editingId = Number(state.editingSubscriptionId) || null;
    button.disabled = true;
    subscriptionStatus(t(editingId ? 'planner.subscriptionUpdating' : 'planner.subscriptionAdding'));
    try {
      const result = editingId
        ? await App.rpc('calendar.subscriptions.update', { id: editingId, url, name, accountId, color, refreshMinutes })
        : await App.rpc('calendar.subscriptions.add', { url, name, accountId, color, refreshMinutes });
      resetSubscriptionEditor();
      await loadSubscriptions();
      await refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      const successKey = editingId ? 'planner.subscriptionUpdated' : 'planner.subscriptionAdded';
      const errorKey = editingId ? 'planner.subscriptionUpdatedWithError' : 'planner.subscriptionAddedWithError';
      subscriptionStatus(result?.error ? t(errorKey, { error: result.error }) : t(successKey), result?.error ? 'error' : 'success');
    } catch (error) {
      subscriptionStatus(`${t('planner.subscriptionError')} : ${error.message}`, 'error');
    } finally { button.disabled = false; }
  }

  async function syncSubscription(id, button = null) {
    if (button) button.disabled = true;
    subscriptionStatus(t('planner.subscriptionSyncing'));
    plannerRefreshStatus(t('planner.subscriptionSyncing'), 'busy', { sticky: true });
    const current = state.subscriptions.find(item => Number(item.id) === Number(id));
    const name = current?.name || subscriptionHost(current?.url || '');
    try {
      const result = await App.rpc('calendar.subscriptions.sync', { id });
      await loadSubscriptions();
      await refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      const summary = subscriptionSyncSummary(result, { name });
      subscriptionStatus(summary.text, summary.type);
      plannerRefreshStatus(summary.text, summary.type);
      App.status(summary.text, summary.type);
    } catch (error) {
      await loadSubscriptions();
      subscriptionStatus(`${t('planner.subscriptionError')} : ${error.message}`, 'error');
      plannerRefreshStatus(`${t('planner.subscriptionError')} : ${error.message}`, 'error');
      App.status(`${t('planner.subscriptionError')} : ${error.message}`, 'error');
    } finally { if (button) button.disabled = false; }
  }

  async function syncAllSubscriptions() {
    const buttons = [
      document.getElementById('btn-planner-subscriptions-sync'),
      document.getElementById('btn-planner-refresh'),
    ].filter(Boolean);
    buttons.forEach(button => { button.disabled = true; });
    subscriptionStatus(t('planner.subscriptionSyncing'));
    plannerRefreshStatus(t('planner.subscriptionSyncing'), 'busy', { sticky: true });
    try {
      const results = await App.rpc('calendar.subscriptions.syncAll');
      await loadSubscriptions();
      await refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      const summary = subscriptionSyncSummary(results);
      subscriptionStatus(summary.text, summary.type);
      plannerRefreshStatus(summary.text, summary.type);
      App.status(summary.text, summary.type);
    } catch (error) {
      subscriptionStatus(`${t('planner.subscriptionError')} : ${error.message}`, 'error');
      plannerRefreshStatus(`${t('planner.subscriptionError')} : ${error.message}`, 'error');
      App.status(`${t('planner.subscriptionError')} : ${error.message}`, 'error');
    } finally { buttons.forEach(button => { button.disabled = false; }); }
  }

  async function syncAllExternalCalendars() {
    const button = document.getElementById('btn-planner-refresh');
    if (button) button.disabled = true;
    plannerRefreshStatus(t('planner.externalSyncing'), 'busy', { sticky: true });
    try {
      const [subscriptionsResult, googleResult, caldavResult] = await Promise.allSettled([
        App.rpc('calendar.subscriptions.syncAll'),
        App.rpc('calendar.google.syncAll'),
        App.rpc('calendar.caldav.syncAll'),
      ]);
      await Promise.all([loadSubscriptions(), loadGoogleConnections(), loadCalDavConnections(), refreshSummary()]);
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      let failed = [subscriptionsResult, googleResult, caldavResult].filter(result => result.status === 'rejected').length;
      if (caldavResult.status === 'fulfilled') failed += (caldavResult.value || []).filter(item => !item || item.error || Number(item.failed) > 0).length;
      if (subscriptionsResult.status === 'fulfilled') {
        failed += (subscriptionsResult.value || []).filter(item => item?.error).length;
      }
      if (googleResult.status === 'fulfilled') {
        failed += (googleResult.value || []).filter(item => !item?.ok || Number(item?.result?.failedCalendars) > 0).length;
      }
      const message = failed
        ? `${t('planner.externalSyncDone')} ${t(failed === 1 ? 'planner.syncSummaryErrorsOne' : 'planner.syncSummaryErrorsMany', { count: failed })}`
        : t('planner.externalSyncDone');
      plannerRefreshStatus(message, failed ? 'info' : 'success');
      App.status(message, failed ? 'info' : 'success');
    } catch (error) {
      plannerRefreshStatus(`${t('error')} : ${error.message}`, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function removeSubscription(id) {
    const subscription = state.subscriptions.find(item => Number(item.id) === Number(id));
    if (!subscription) return;
    const name = subscription.name || subscriptionHost(subscription.url);
    const accepted = await plannerConfirm({
      title: t('planner.removeSubscriptionTitle', { name }),
      message: t('planner.removeSubscriptionConfirm', { name }),
      confirmLabel: t('planner.removeSubscriptionAction'),
      icon: 'fa-link-slash',
      danger: true,
      note: t('planner.removeSubscriptionNote'),
    });
    if (!accepted) return;
    try {
      await App.rpc('calendar.subscriptions.remove', { id });
      if (Number(state.editingSubscriptionId) === Number(id)) resetSubscriptionEditor();
      await loadSubscriptions();
      await refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      subscriptionStatus(t('planner.subscriptionRemoved'), 'success');
    } catch (error) {
      subscriptionStatus(`${t('planner.subscriptionError')} : ${error.message}`, 'error');
    }
  }

  function readFileText(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error(t('planner.importReadError')));
      reader.readAsText(file);
    });
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || state.importing) return;
    state.importing = true;
    const button = document.getElementById('btn-planner-import');
    if (button) button.disabled = true;
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let recurringSeries = 0;
    let truncated = false;
    let importedFiles = 0;
    const accountId = state.filterAccountId || '';
    const accountColor = accountId ? App.accountColor(accountId) : '';
    try {
      for (const file of files) {
        const text = await readFileText(file);
        const result = await App.rpc('calendar.import', {
          text,
          fileName: file.name || '',
          accountId,
          color: /^#[0-9a-fA-F]{6}$/.test(String(accountColor || '')) ? accountColor : '',
          locale: locale(),
        });
        created += Number(result.created) || 0;
        updated += Number(result.updated) || 0;
        skipped += Number(result.skipped) || 0;
        recurringSeries += Number(result.recurringSeries) || 0;
        truncated = truncated || Boolean(result.truncated);
        importedFiles += 1;
      }
      await loadEvents();
      const importMessage = t('planner.importDone', { files: importedFiles, created, updated, skipped });
      const recurringMessage = recurringSeries
        ? `${importMessage} · ${t('planner.recurringSeries', { count: recurringSeries })}`
        : importMessage;
      App.status(
        truncated ? `${recurringMessage} · ${t('planner.importTruncated')}` : recurringMessage,
        truncated ? 'info' : 'success',
      );
    } catch (error) {
      App.status(`${t('planner.importError')} : ${error.message}`, 'error');
    } finally {
      state.importing = false;
      if (button) button.disabled = false;
      const input = document.getElementById('planner-import-file');
      if (input) input.value = '';
    }
  }

  function navigate(direction) {
    if (state.view === 'month') {
      state.anchor = addMonthsPreserveDay(state.anchor, direction);
      state.selected = addMonthsPreserveDay(state.selected, direction);
    } else if (state.view === 'year') {
      state.anchor = addYearsPreserveDay(state.anchor, direction);
      state.selected = addYearsPreserveDay(state.selected, direction);
    } else {
      state.anchor = addDays(state.anchor, direction * 7);
      state.selected = addDays(state.selected, direction * 7);
    }
    loadEvents();
  }

  function normalizeSelectionForView() {
    if (state.view !== 'workweek') return;
    const weekday = state.selected.getDay();
    if (weekday === 0 || weekday === 6) state.selected = mondayOnOrBefore(state.selected);
  }

  function setView(view) {
    if (!['month', 'week', 'workweek', 'year'].includes(view) || state.view === view) return;
    state.view = view;
    normalizeSelectionForView();
    state.anchor = startOfDay(state.selected);
    closeEditor();
    loadEvents();
  }

  async function openPlanner() {
    plannerRefreshStatus('');
    populateAccountSelects();
    state.anchor = startOfDay(state.selected || new Date());
    document.getElementById('planner-modal')?.classList.add('open');
    closeEditor();
    await Promise.all([loadCategories(), loadGoogleConnections(), loadCalDavConnections(), loadEvents()]);
  }

  function wire() {
    document.getElementById('btn-planner')?.addEventListener('click', openPlanner);
    document.getElementById('btn-planner-new')?.addEventListener('click', () => openNewEvent(state.selected));
    document.getElementById('btn-planner-pane-toggle')?.addEventListener('click', () => setPlannerPaneCollapsed(!document.getElementById('app')?.classList.contains('planner-pane-collapsed')));
    document.getElementById('btn-planner-pane-open')?.addEventListener('click', openPlanner);
    document.getElementById('btn-planner-pane-open-full')?.addEventListener('click', openPlanner);
    document.getElementById('btn-planner-pane-new')?.addEventListener('click', async () => { await openPlanner(); openNewEvent(new Date()); });
    document.getElementById('btn-planner-import')?.addEventListener('click', () => document.getElementById('planner-import-file')?.click());
    document.getElementById('btn-planner-subscriptions')?.addEventListener('click', openSubscriptions);
    document.getElementById('planner-calendar-provider')?.addEventListener('change', cdSwitch);
    for (const id of ['server','user','password']) cdEl(id)?.addEventListener('input', cdInvalidate);
    cdBtn('test')?.addEventListener('click', cdTest);
    cdBtn('add')?.addEventListener('click', cdAdd);
    cdBtn('cancel')?.addEventListener('click', cdReset);
    cdBtn('apple')?.addEventListener('click', () => App.openExternal('https://account.apple.com/'));
    const calendarModal = document.getElementById('planner-subscriptions-modal');
    if (calendarModal && typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => { if (!calendarModal.classList.contains('open')) cdReset(); }).observe(calendarModal,{attributes:true,attributeFilter:['class']});
    }

    document.getElementById('btn-planner-refresh')?.addEventListener('click', syncAllExternalCalendars);
    document.getElementById('btn-planner-google-connect')?.addEventListener('click', connectGoogle);
    document.getElementById('btn-planner-google-cancel')?.addEventListener('click', cancelGoogleConnection);
    document.getElementById('btn-planner-google-sync-all')?.addEventListener('click', syncAllGoogleConnections);
    document.getElementById('btn-planner-google-mock-connect')?.addEventListener('click', event => runGoogleMockAction('connect', event.currentTarget));
    document.getElementById('btn-planner-google-mock-advance')?.addEventListener('click', event => runGoogleMockAction('advance', event.currentTarget));
    document.getElementById('btn-planner-google-mock-expire')?.addEventListener('click', event => runGoogleMockAction('expireSyncToken', event.currentTarget));
    document.getElementById('btn-planner-google-mock-conflict')?.addEventListener('click', event => runGoogleMockAction('conflict', event.currentTarget));
    document.getElementById('btn-planner-google-mock-reset')?.addEventListener('click', event => runGoogleMockAction('reset', event.currentTarget));
    document.getElementById('btn-close-planner-subscriptions')?.addEventListener('click', closeSubscriptions);
    document.getElementById('btn-close-planner-subscriptions-footer')?.addEventListener('click', closeSubscriptions);
    document.getElementById('planner-import-file')?.addEventListener('change', event => importFiles(event.target.files));
    document.getElementById('btn-planner-subscription-add')?.addEventListener('click', saveSubscription);
    document.getElementById('btn-planner-subscription-cancel-edit')?.addEventListener('click', () => { resetSubscriptionEditor(); subscriptionStatus(''); });
    document.getElementById('btn-planner-subscriptions-sync')?.addEventListener('click', syncAllSubscriptions);
    document.getElementById('btn-planner-add-day')?.addEventListener('click', () => openNewEvent(state.selected));
    document.getElementById('btn-planner-close-editor')?.addEventListener('click', closeEditor);
    document.getElementById('btn-planner-cancel')?.addEventListener('click', closeEditor);
    document.getElementById('btn-planner-save')?.addEventListener('click', saveEvent);
    document.getElementById('btn-planner-delete')?.addEventListener('click', deleteEvent);
    document.getElementById('btn-planner-attachment-add')?.addEventListener('click', selectPlannerAttachments);
    document.getElementById('planner-account')?.addEventListener('change', () => syncEditorTargetMode({ clearPending: true }));
    document.getElementById('planner-all-day')?.addEventListener('change', event => setEditorAllDay(event.target.checked));
    document.getElementById('planner-start-date')?.addEventListener('change', () => syncEndConstraints(true));
    document.getElementById('planner-start-time')?.addEventListener('change', () => syncEndConstraints(true));
    document.getElementById('planner-end-date')?.addEventListener('change', () => syncEndConstraints(true));
    document.getElementById('btn-planner-prev')?.addEventListener('click', () => navigate(-1));
    document.getElementById('btn-planner-next')?.addEventListener('click', () => navigate(1));
    document.getElementById('btn-planner-today')?.addEventListener('click', () => {
      state.selected = startOfDay(new Date());
      normalizeSelectionForView();
      state.anchor = startOfDay(state.selected);
      loadEvents();
    });
    document.getElementById('planner-filter-account')?.addEventListener('change', event => {
      state.filterAccountId = event.target.value || '';
      loadEvents();
    });
    document.querySelectorAll('[data-planner-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.plannerView)));

    const grid = document.getElementById('planner-grid');
    grid?.addEventListener('dragover', event => {
      if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); grid.classList.add('drag-import'); }
    });
    grid?.addEventListener('dragleave', () => grid.classList.remove('drag-import'));
    grid?.addEventListener('drop', event => {
      grid.classList.remove('drag-import');
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      importFiles(event.dataTransfer.files);
    });
    window.addEventListener('resize', () => syncWeekLayout());
    setPlannerPaneCollapsed(plannerPaneCollapsed());
    if (state.summaryTimer) clearInterval(state.summaryTimer);
    state.summaryTimer = setInterval(() => refreshSummary(), 60 * 1000);
    setTimeout(() => refreshSummary(), 1000);
  }

  function onEngineEvent(event, data = {}) {
    if (event === 'security.locked') {
      cdReset();
    } else if (event === 'calendar.changed') {
      refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) loadEvents();
    } else if (event === 'calendar.categories.changed') {
      loadCategories();
      refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) loadEvents();
    } else if (event === 'calendar.subscriptions.changed') {
      if (document.getElementById('planner-subscriptions-modal')?.classList.contains('open')) loadSubscriptions();
    } else if (event === 'calendar.caldav.changed') {
      if (!state.caldavSetupBusy && (document.getElementById('planner-modal')?.classList.contains('open') || document.getElementById('planner-subscriptions-modal')?.classList.contains('open'))) loadCalDavConnections();
    } else if (event === 'calendar.google.changed') {
      refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) loadEvents();
      if (document.getElementById('planner-subscriptions-modal')?.classList.contains('open')) {
        loadGoogleConnections();
        loadGoogleMockStatus();
      }
    } else if (event === 'calendar.google.sync.started') {
      if (document.getElementById('planner-subscriptions-modal')?.classList.contains('open')) {
        googleStatus(t('planner.googleSyncDiagnosticDiscovery'), 'info');
      }
    } else if (event === 'calendar.google.sync.progress') {
      if (document.getElementById('planner-subscriptions-modal')?.classList.contains('open')) {
        const phase = String(data.phase || '');
        if (phase === 'calendar-start' || phase === 'calendar-done') {
          googleStatus(t('planner.googleSyncDiagnosticCalendar', {
            current: Number(data.calendarIndex) || 0,
            total: Number(data.calendarTotal) || 0,
          }), 'info');
        } else if (phase === 'full-resync') {
          googleStatus(t('planner.googleSyncDiagnosticResync'), 'info');
        }
      }
    } else if (event === 'calendar.google.sync.done') {
      if (document.getElementById('planner-subscriptions-modal')?.classList.contains('open')) {
        googleStatus(t('planner.googleSyncDiagnosticDone', {
          duration: `${((Number(data.durationMs) || 0) / 1000).toFixed(1)} s`,
        }), 'success');
      }
    } else if (event === 'calendar.google.sync.error') {
      if (document.getElementById('planner-subscriptions-modal')?.classList.contains('open')) {
        googleStatus(`${t('error')} : ${data.error || t('error')}`, 'error');
      }
    } else if (event === 'calendar.google.oauth.changed') {
      handleGoogleOAuthFlow(data);
    }
  }

  window.PlannerUI = { open: openPlanner, refresh: loadEvents, refreshSummary, onEngineEvent };
  window.addEventListener('DOMContentLoaded', wire);
})();
