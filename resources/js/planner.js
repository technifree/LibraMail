/* LibraMail 0.3.0 — planning local */
'use strict';
(function () {
  const state = {
    month: firstOfMonth(new Date()),
    selected: startOfDay(new Date()),
    events: [],
    loading: false,
    filterAccountId: '',
  };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));

  const locale = () => window.I18N?.locale || 'fr';
  function firstOfMonth(date) { const d = new Date(date); return new Date(d.getFullYear(), d.getMonth(), 1); }
  function startOfDay(date) { const d = new Date(date); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
  function addMonths(date, months) { return new Date(date.getFullYear(), date.getMonth() + months, 1); }
  function mondayOnOrBefore(date) { const d = startOfDay(date); return addDays(d, -((d.getDay() + 6) % 7)); }

  function dateKey(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function parseDateKey(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function parseLocalDateTime(dateValue, timeValue = '00:00') {
    const d = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const t = String(timeValue || '00:00').match(/^(\d{2}):(\d{2})$/);
    if (!d || !t) return NaN;
    return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), 0, 0).getTime();
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

  function renderWeekdays() {
    const root = document.getElementById('planner-weekdays');
    if (!root) return;
    const monday = new Date(2026, 7, 10);
    root.innerHTML = Array.from({ length: 7 }, (_, index) => {
      const label = addDays(monday, index).toLocaleDateString(locale(), { weekday: 'short' }).replace('.', '');
      return `<span>${esc(label)}</span>`;
    }).join('');
  }

  function renderCalendar() {
    const root = document.getElementById('planner-grid');
    if (!root) return;
    document.getElementById('planner-month-title').textContent = formatMonth(state.month);
    renderWeekdays();
    const gridStart = mondayOnOrBefore(state.month);
    const todayKey = dateKey(new Date());
    const selectedKey = dateKey(state.selected);
    const monthIndex = state.month.getMonth();
    root.innerHTML = Array.from({ length: 42 }, (_, index) => {
      const day = addDays(gridStart, index);
      const key = dateKey(day);
      const dayEvents = state.events.filter(event => eventOverlapsDay(event, day));
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
      cell.addEventListener('click', event => { if (!event.target.closest('[data-planner-event]')) select(); });
      cell.addEventListener('dblclick', event => { if (!event.target.closest('[data-planner-event]')) { select(); openNewEvent(state.selected); } });
      cell.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(); } });
    });
    root.querySelectorAll('[data-planner-event]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        const item = state.events.find(candidate => Number(candidate.id) === Number(button.dataset.plannerEvent));
        if (!item) return;
        state.selected = startOfDay(new Date(item.startAt));
        renderCalendar();
        renderSelectedDay();
        openEditor(item);
      });
    });
    root.querySelectorAll('[data-planner-day-more]').forEach(button => {
      button.addEventListener('click', event => { event.stopPropagation(); selectDay(parseDateKey(button.dataset.plannerDayMore)); });
    });
  }

  function renderSelectedDay() {
    document.getElementById('planner-selected-date').textContent = formatSelectedDate(state.selected);
    const list = document.getElementById('planner-day-events');
    const empty = document.getElementById('planner-day-empty');
    const events = state.events.filter(event => eventOverlapsDay(event, state.selected));
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
  function render() { renderCalendar(); renderSelectedDay(); }
  function visibleRange() { const from = mondayOnOrBefore(state.month); return { from: from.getTime(), to: addDays(from, 42).getTime() }; }

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
    renderCalendar();
    renderSelectedDay();
  }
  function closeEditor() {
    document.getElementById('planner-editor')?.classList.add('hidden');
    const error = document.getElementById('planner-form-error');
    if (error) error.textContent = '';
  }
  function setEditorAllDay(allDay) {
    document.querySelectorAll('#planner-editor .planner-time-field').forEach(field => field.classList.toggle('hidden', Boolean(allDay)));
  }
  function openNewEvent(date = state.selected) {
    const day = startOfDay(date || new Date());
    document.getElementById('planner-event-id').value = '';
    document.getElementById('planner-editor-title').textContent = t('planner.newEvent');
    document.getElementById('planner-title').value = '';
    document.getElementById('planner-account').value = state.filterAccountId || '';
    document.getElementById('planner-all-day').checked = false;
    document.getElementById('planner-start-date').value = dateKey(day);
    document.getElementById('planner-start-time').value = '09:00';
    document.getElementById('planner-end-date').value = dateKey(day);
    document.getElementById('planner-end-time').value = '10:00';
    document.getElementById('planner-location').value = '';
    document.getElementById('planner-notes').value = '';
    document.getElementById('planner-form-error').textContent = '';
    document.getElementById('btn-planner-delete').classList.add('hidden');
    setEditorAllDay(false);
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
    document.getElementById('planner-start-time').value = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
    document.getElementById('planner-end-date').value = dateKey(end);
    document.getElementById('planner-end-time').value = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
    document.getElementById('planner-location').value = event.location || '';
    document.getElementById('planner-notes').value = event.notes || '';
    document.getElementById('planner-form-error').textContent = '';
    document.getElementById('btn-planner-delete').classList.remove('hidden');
    setEditorAllDay(Boolean(event.allDay));
    document.getElementById('planner-editor').classList.remove('hidden');
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
      state.month = firstOfMonth(state.selected);
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
  async function openPlanner() {
    populateAccountSelects();
    state.month = firstOfMonth(state.selected || new Date());
    document.getElementById('planner-modal')?.classList.add('open');
    closeEditor();
    await loadEvents();
  }
  function wire() {
    document.getElementById('btn-planner')?.addEventListener('click', openPlanner);
    document.getElementById('btn-planner-new')?.addEventListener('click', () => openNewEvent(state.selected));
    document.getElementById('btn-planner-add-day')?.addEventListener('click', () => openNewEvent(state.selected));
    document.getElementById('btn-planner-close-editor')?.addEventListener('click', closeEditor);
    document.getElementById('btn-planner-cancel')?.addEventListener('click', closeEditor);
    document.getElementById('btn-planner-save')?.addEventListener('click', saveEvent);
    document.getElementById('btn-planner-delete')?.addEventListener('click', deleteEvent);
    document.getElementById('planner-all-day')?.addEventListener('change', event => setEditorAllDay(event.target.checked));
    document.getElementById('btn-planner-prev')?.addEventListener('click', () => { state.month = addMonths(state.month, -1); loadEvents(); });
    document.getElementById('btn-planner-next')?.addEventListener('click', () => { state.month = addMonths(state.month, 1); loadEvents(); });
    document.getElementById('btn-planner-today')?.addEventListener('click', () => { state.selected = startOfDay(new Date()); state.month = firstOfMonth(state.selected); loadEvents(); });
    document.getElementById('planner-filter-account')?.addEventListener('change', event => { state.filterAccountId = event.target.value || ''; loadEvents(); });
  }
  window.PlannerUI = { open: openPlanner, refresh: loadEvents };
  window.addEventListener('DOMContentLoaded', wire);
})();
