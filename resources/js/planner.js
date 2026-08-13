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
    loading: false,
    importing: false,
    filterAccountId: '',
    subscriptions: [],
    summaryTimer: null,
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
    if (/^#[0-9a-fA-F]{6}$/.test(String(event?.color || ''))) return event.color;
    return event?.accountId ? (App.accountColor(event.accountId) || 'var(--accent)') : 'var(--accent)';
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
      editor.innerHTML = [
        `<option value="">${esc(t('planner.localCalendar'))}</option>`,
        ...App.accounts.map(account => `<option value="${esc(account.id)}">${esc(account.displayName || account.email)}</option>`),
      ].join('');
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
          <span class="planner-event-time">${esc(eventLabel(event))}</span><span>${esc(event.title)}</span>
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
        <button class="planner-event-chip" type="button" data-planner-event="${Number(event.id)}" style="--event-color:${esc(eventColor(event))}" title="${esc(event.title)}"><span>${esc(event.title)}</span></button>`).join('')}${events.length > 4 ? `<span class="planner-week-more">+${events.length - 4}</span>` : ''}</div>`;
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
            <span>${esc(formatTime(clip.startAt))}</span><strong>${esc(event.title)}</strong>${event.location ? `<small>${esc(event.location)}</small>` : ''}
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
        <span class="planner-day-event-main"><strong>${esc(event.title)}</strong><small>${esc(accountLabel(event.accountId))}${event.location ? ` · ${esc(event.location)}` : ''}</small></span>
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

  function closeEditor() {
    document.getElementById('planner-editor')?.classList.add('hidden');
    const error = document.getElementById('planner-form-error');
    if (error) error.textContent = '';
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

  function openNewEvent(date = state.selected, startMinutes = null) {
    const day = startOfDay(date || new Date());
    document.getElementById('planner-event-id').value = '';
    document.getElementById('planner-editor-title').textContent = t('planner.newEvent');
    document.getElementById('planner-title').value = '';
    document.getElementById('planner-account').value = state.filterAccountId || '';
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
    document.getElementById('planner-form-error').textContent = '';
    document.getElementById('btn-planner-delete').classList.add('hidden');
    setEditorAllDay(false);
    syncEndConstraints(false);
    document.getElementById('planner-editor').classList.remove('hidden');
    document.getElementById('planner-title').focus();
  }

  function openEditor(event) {
    const start = new Date(Number(event.startAt));
    let end = new Date(Number(event.endAt));
    if (event.allDay) end = addDays(end, -1);
    document.getElementById('planner-event-id').value = String(event.id);
    document.getElementById('planner-editor-title').textContent = t('planner.editEvent');
    document.getElementById('planner-title').value = event.title || '';
    document.getElementById('planner-account').value = event.accountId || '';
    document.getElementById('planner-all-day').checked = Boolean(event.allDay);
    document.getElementById('planner-start-date').value = dateKey(start);
    document.getElementById('planner-start-time').value = timeValue(start);
    document.getElementById('planner-end-date').value = dateKey(end);
    document.getElementById('planner-end-time').value = timeValue(end);
    document.getElementById('planner-location').value = event.location || '';
    document.getElementById('planner-notes').value = event.notes || '';
    document.getElementById('planner-form-error').textContent = '';
    document.getElementById('btn-planner-delete').classList.remove('hidden');
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
    const accountId = document.getElementById('planner-account').value || '';
    const accountColor = accountId ? App.accountColor(accountId) : '';
    return {
      title, startAt, endAt, allDay, accountId,
      color: /^#[0-9a-fA-F]{6}$/.test(String(accountColor || '')) ? accountColor : '',
      location: document.getElementById('planner-location').value.trim(),
      notes: document.getElementById('planner-notes').value.trim(),
    };
  }

  async function saveEvent() {
    const errorElement = document.getElementById('planner-form-error');
    errorElement.textContent = '';
    const button = document.getElementById('btn-planner-save');
    button.disabled = true;
    try {
      const id = Number(document.getElementById('planner-event-id').value || 0) || null;
      const saved = await App.rpc('calendar.save', { id, event: editorPayload() });
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
    const id = Number(document.getElementById('planner-event-id').value || 0);
    if (!id || !window.confirm(t('planner.deleteConfirm'))) return;
    try {
      await App.rpc('calendar.remove', { id });
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
    const source = event.location || accountLabel(event.accountId);
    return `<button class="planner-main-event" type="button" data-planner-summary-event="${Number(event.id)}" style="--event-color:${esc(eventColor(event))}" title="${esc(event.title)}">
      <span class="planner-main-event-time">${esc(event.allDay ? t('planner.allDayShort') : formatTime(event.startAt))}</span>
      <span class="planner-main-event-main"><strong>${esc(event.title)}</strong><small>${esc(source)}</small></span>
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
    const upcoming = sortedEvents(events.filter(event => Number(event.endAt) > now));
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

  function subscriptionHost(value) {
    try { return new URL(value).hostname; } catch { return value; }
  }

  function formatLastSync(timestamp) {
    if (!Number(timestamp)) return t('planner.neverSynced');
    return new Date(Number(timestamp)).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function renderSubscriptions() {
    const root = document.getElementById('planner-subscriptions-list');
    const empty = document.getElementById('planner-subscriptions-empty');
    if (!root || !empty) return;
    empty.classList.toggle('hidden', state.subscriptions.length > 0);
    root.classList.toggle('hidden', state.subscriptions.length === 0);
    root.innerHTML = state.subscriptions.map(subscription => {
      const error = subscription.lastStatus === 'error';
      const statusText = error ? subscription.lastError : t('planner.lastSync', { date: formatLastSync(subscription.lastSyncAt) });
      return `<div class="planner-subscription-row" data-subscription-id="${Number(subscription.id)}">
        <div class="planner-subscription-main">
          <strong>${esc(subscription.name || subscriptionHost(subscription.url))}</strong>
          <small>${esc(subscriptionHost(subscription.url))}</small>
          <span class="planner-subscription-meta"><i class="fa-solid ${error ? 'fa-circle-exclamation error' : 'fa-circle-check ok'}"></i><span title="${esc(statusText)}">${esc(statusText)}</span></span>
        </div>
        <div class="planner-subscription-actions">
          <button class="iconbtn" type="button" data-subscription-sync="${Number(subscription.id)}" title="${esc(t('planner.syncSubscription'))}"><i class="fa-solid fa-rotate"></i></button>
          <button class="iconbtn danger-hover" type="button" data-subscription-remove="${Number(subscription.id)}" title="${esc(t('planner.removeSubscription'))}"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`;
    }).join('');
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

  function closeSubscriptions() {
    document.getElementById('planner-subscriptions-modal')?.classList.remove('open');
  }

  async function openSubscriptions() {
    const account = document.getElementById('planner-subscription-account');
    if (account) account.innerHTML = subscriptionAccountOptions(state.filterAccountId || '');
    document.getElementById('planner-subscriptions-modal')?.classList.add('open');
    subscriptionStatus('');
    await loadSubscriptions();
  }

  async function addSubscription() {
    const url = document.getElementById('planner-subscription-url')?.value.trim() || '';
    const name = document.getElementById('planner-subscription-name')?.value.trim() || '';
    const accountId = document.getElementById('planner-subscription-account')?.value || '';
    const color = document.getElementById('planner-subscription-color')?.value || '';
    if (!url) { subscriptionStatus(t('planner.subscriptionUrlRequired'), 'error'); return; }
    const button = document.getElementById('btn-planner-subscription-add');
    button.disabled = true;
    subscriptionStatus(t('planner.subscriptionAdding'));
    try {
      const result = await App.rpc('calendar.subscriptions.add', { url, name, accountId, color });
      document.getElementById('planner-subscription-url').value = '';
      document.getElementById('planner-subscription-name').value = '';
      await loadSubscriptions();
      await refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      subscriptionStatus(result?.error ? t('planner.subscriptionAddedWithError', { error: result.error }) : t('planner.subscriptionAdded'), result?.error ? 'error' : 'success');
    } catch (error) {
      subscriptionStatus(`${t('planner.subscriptionError')} : ${error.message}`, 'error');
    } finally { button.disabled = false; }
  }

  async function syncSubscription(id, button = null) {
    if (button) button.disabled = true;
    subscriptionStatus(t('planner.subscriptionSyncing'));
    try {
      await App.rpc('calendar.subscriptions.sync', { id });
      await loadSubscriptions();
      await refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      subscriptionStatus(t('planner.subscriptionSynced'), 'success');
    } catch (error) {
      await loadSubscriptions();
      subscriptionStatus(`${t('planner.subscriptionError')} : ${error.message}`, 'error');
    } finally { if (button) button.disabled = false; }
  }

  async function syncAllSubscriptions() {
    const button = document.getElementById('btn-planner-subscriptions-sync');
    button.disabled = true;
    subscriptionStatus(t('planner.subscriptionSyncing'));
    try {
      await App.rpc('calendar.subscriptions.syncAll');
      await loadSubscriptions();
      await refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) await loadEvents();
      subscriptionStatus(t('planner.subscriptionSynced'), 'success');
    } catch (error) {
      subscriptionStatus(`${t('planner.subscriptionError')} : ${error.message}`, 'error');
    } finally { button.disabled = false; }
  }

  async function removeSubscription(id) {
    const subscription = state.subscriptions.find(item => Number(item.id) === Number(id));
    if (!subscription || !window.confirm(t('planner.removeSubscriptionConfirm', { name: subscription.name || subscriptionHost(subscription.url) }))) return;
    try {
      await App.rpc('calendar.subscriptions.remove', { id });
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
      App.status(recurringSeries ? `${importMessage} · ${t('planner.recurringSeries', { count: recurringSeries })}` : importMessage, truncated ? 'info' : 'success');
      if (truncated) window.alert(t('planner.importTruncated'));
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
    populateAccountSelects();
    state.anchor = startOfDay(state.selected || new Date());
    document.getElementById('planner-modal')?.classList.add('open');
    closeEditor();
    await loadEvents();
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
    document.getElementById('btn-close-planner-subscriptions')?.addEventListener('click', closeSubscriptions);
    document.getElementById('btn-close-planner-subscriptions-footer')?.addEventListener('click', closeSubscriptions);
    document.getElementById('planner-import-file')?.addEventListener('change', event => importFiles(event.target.files));
    document.getElementById('btn-planner-subscription-add')?.addEventListener('click', addSubscription);
    document.getElementById('btn-planner-subscriptions-sync')?.addEventListener('click', syncAllSubscriptions);
    document.getElementById('btn-planner-add-day')?.addEventListener('click', () => openNewEvent(state.selected));
    document.getElementById('btn-planner-close-editor')?.addEventListener('click', closeEditor);
    document.getElementById('btn-planner-cancel')?.addEventListener('click', closeEditor);
    document.getElementById('btn-planner-save')?.addEventListener('click', saveEvent);
    document.getElementById('btn-planner-delete')?.addEventListener('click', deleteEvent);
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

  function onEngineEvent(event) {
    if (event === 'calendar.changed') {
      refreshSummary();
      if (document.getElementById('planner-modal')?.classList.contains('open')) loadEvents();
    } else if (event === 'calendar.subscriptions.changed') {
      if (document.getElementById('planner-subscriptions-modal')?.classList.contains('open')) loadSubscriptions();
    }
  }

  window.PlannerUI = { open: openPlanner, refresh: loadEvents, refreshSummary, onEngineEvent };
  window.addEventListener('DOMContentLoaded', wire);
})();
