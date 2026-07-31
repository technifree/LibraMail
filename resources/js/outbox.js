/* LibraMail 0.2.24 — interface des brouillons et envois différés */
'use strict';
(function () {
  let currentKind = 'draft';
  let loading = false;

  const t = (key, vars = {}) => {
    if (typeof window.t === 'function') return window.t(key, vars);
    if (window.I18N?.translate) return window.I18N.translate(key, vars);
    return key;
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));

  function localDateTimeValue(timestamp) {
    const date = timestamp ? new Date(Number(timestamp)) : new Date(Date.now() + 60 * 60 * 1000);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(window.I18N?.locale || 'fr', {
      dateStyle: 'short', timeStyle: 'short',
    });
  }

  function accountName(accountId) {
    const account = (window.App?.accounts || []).find(item => String(item.id) === String(accountId));
    return account?.displayName || account?.email || '';
  }

  function setCount(id, value) {
    const element = document.getElementById(id);
    if (!element) return;
    const count = Number(value) || 0;
    element.textContent = count ? String(count) : '';
    element.classList.toggle('hidden', !count);
  }

  async function refreshCounts() {
    try {
      const counts = await App.rpc('outbox.counts');
      setCount('count-drafts', counts?.drafts);
      setCount('count-scheduled', counts?.scheduled);
      return counts;
    } catch {
      return { drafts: 0, scheduled: 0 };
    }
  }

  function modalElement() {
    return document.getElementById('outbox-modal');
  }

  function openModal() {
    modalElement()?.classList.add('open');
  }

  function closeModal() {
    modalElement()?.classList.remove('open');
  }

  function statusClass(item) {
    if (item.kind !== 'scheduled') return '';
    return ` ${esc(item.status || 'pending')}`;
  }

  function renderList(items) {
    const list = document.getElementById('outbox-list');
    const empty = document.getElementById('outbox-empty');
    if (!list || !empty) return;
    const rows = Array.isArray(items) ? items : [];
    list.classList.toggle('hidden', !rows.length);
    empty.classList.toggle('hidden', Boolean(rows.length));
    empty.querySelector('span').textContent = t(currentKind === 'draft' ? 'drafts.empty' : 'scheduled.empty');
    if (!rows.length) {
      list.innerHTML = '';
      return;
    }

    list.innerHTML = rows.map(item => {
      const title = item.subject || t('mail.noSubject');
      const recipient = item.recipients || t('outbox.noRecipient');
      const date = currentKind === 'scheduled'
        ? formatDate(item.sendAt)
        : formatDate(item.updatedAt);
      const account = accountName(item.accountId);
      const error = item.error
        ? `<div class="outbox-row-error"><i class="fa-solid fa-triangle-exclamation"></i>${esc(item.error)}</div>`
        : '';
      const sendNow = currentKind === 'scheduled'
        ? `<button class="btn compact" type="button" data-outbox-send-now="${Number(item.id)}">
             <i class="fa-solid fa-paper-plane"></i><span>${esc(t('scheduled.sendNow'))}</span>
           </button>`
        : '';
      return `<article class="outbox-row${statusClass(item)}" data-outbox-id="${Number(item.id)}">
        <span class="outbox-row-icon"><i class="fa-solid ${currentKind === 'draft' ? 'fa-file-pen' : 'fa-clock'}"></i></span>
        <span class="outbox-row-main">
          <strong>${esc(title)}</strong>
          <span>${esc(recipient)}</span>
          <small>${esc(account)}${account && date ? ' · ' : ''}${esc(date)}</small>
          ${error}
        </span>
        <span class="outbox-row-actions">
          <button class="btn compact primary" type="button" data-outbox-edit="${Number(item.id)}">
            <i class="fa-solid fa-pen"></i><span>${esc(t('edit'))}</span>
          </button>
          ${sendNow}
          <button class="iconbtn danger-hover" type="button" data-outbox-delete="${Number(item.id)}" title="${esc(t('delete'))}">
            <i class="fa-solid fa-trash"></i>
          </button>
        </span>
      </article>`;
    }).join('');

    list.querySelectorAll('[data-outbox-edit]').forEach(button => {
      button.onclick = () => editItem(Number(button.dataset.outboxEdit));
    });
    list.querySelectorAll('[data-outbox-delete]').forEach(button => {
      button.onclick = () => deleteItem(Number(button.dataset.outboxDelete));
    });
    list.querySelectorAll('[data-outbox-send-now]').forEach(button => {
      button.onclick = () => sendNow(Number(button.dataset.outboxSendNow));
    });
  }

  async function refreshList() {
    if (loading) return;
    loading = true;
    const list = document.getElementById('outbox-list');
    if (list) list.innerHTML = `<div class="outbox-loading"><i class="fa-solid fa-rotate fa-spin"></i>${esc(t('loading'))}</div>`;
    try {
      const response = await App.rpc('outbox.list', { kind: currentKind });
      renderList(response?.items || []);
      await refreshCounts();
    } catch (error) {
      if (list) list.innerHTML = `<div class="error-inline">${esc(error.message)}</div>`;
    } finally {
      loading = false;
    }
  }

  async function showManager(kind) {
    currentKind = kind === 'scheduled' ? 'scheduled' : 'draft';
    const title = document.getElementById('outbox-modal-title');
    const icon = document.getElementById('outbox-modal-icon');
    if (title) title.textContent = t(currentKind === 'draft' ? 'drafts.title' : 'scheduled.title');
    if (icon) icon.className = `fa-solid ${currentKind === 'draft' ? 'fa-file-pen' : 'fa-clock'}`;
    openModal();
    await refreshList();
  }

  async function editItem(id) {
    try {
      const item = await App.rpc('outbox.get', { id, kind: currentKind });
      if (!item) throw new Error(t('outbox.notFound'));
      closeModal();
      App.loadComposeState(item.state || {}, {
        draftId: currentKind === 'draft' ? item.id : null,
        scheduledId: currentKind === 'scheduled' ? item.id : null,
        sendAt: item.sendAt || null,
      });
    } catch (error) {
      App.status(`${t('error')} : ${error.message}`, 'error');
    }
  }

  async function deleteItem(id) {
    if (!window.confirm(t(currentKind === 'draft' ? 'drafts.deleteConfirm' : 'scheduled.deleteConfirm'))) return;
    try {
      await App.rpc('outbox.remove', { id, kind: currentKind });
      await refreshList();
    } catch (error) {
      App.status(`${t('error')} : ${error.message}`, 'error');
    }
  }

  async function sendNow(id) {
    const button = document.querySelector(`[data-outbox-send-now="${id}"]`);
    if (button) button.disabled = true;
    try {
      const result = await App.rpc('scheduled.sendNow', { id });
      App.status(result?.sentCopyWarning ? t('compose.sentCopyWarning') : `✓ ${t('compose.sent')}`,
        result?.sentCopyWarning ? 'error' : 'success');
      await refreshList();
    } catch (error) {
      App.status(`${t('error')} : ${error.message}`, 'error');
      await refreshList();
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function saveDraft() {
    const button = document.getElementById('btn-save-draft');
    if (button) button.disabled = true;
    try {
      const state = App.composeState();
      const context = App.composeContext();
      const result = await App.rpc('drafts.save', {
        id: context.draftId || null,
        state,
        removeScheduledId: context.scheduledId || null,
      });
      App.setComposeContext({ draftId: result?.item?.id || null, scheduledId: null });
      App.closeModals();
      App.status(`✓ ${t('drafts.saved')}`, 'success');
      await refreshCounts();
    } catch (error) {
      App.status(`${t('error')} : ${error.message}`, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function toggleScheduleControls(force = null) {
    const checkbox = document.getElementById('compose-send-later');
    const panel = document.getElementById('compose-schedule-fields');
    const sendText = document.querySelector('#btn-send [data-i18n="compose.send"]');
    if (!checkbox || !panel) return;
    if (force !== null) checkbox.checked = Boolean(force);
    panel.classList.toggle('hidden', !checkbox.checked);
    if (checkbox.checked) {
      const input = document.getElementById('compose-send-at');
      if (input && !input.value) input.value = localDateTimeValue();
    }
    if (sendText) sendText.textContent = t(checkbox.checked ? 'scheduled.scheduleButton' : 'compose.send');
  }

  function onEngineEvent(event, data) {
    if (!['outbox.updated', 'scheduled.sent', 'scheduled.failed'].includes(event)) return;
    refreshCounts();
    if (modalElement()?.classList.contains('open')) refreshList();
    if (event === 'scheduled.sent') {
      App.status(`✓ ${t('scheduled.sent', { subject: data?.subject || t('mail.noSubject') })}`, 'success');
    } else if (event === 'scheduled.failed') {
      App.status(t('scheduled.failed', { error: data?.error || t('error') }), 'error');
    }
  }

  function wire() {
    document.querySelectorAll('[data-outbox-kind]').forEach(button => {
      button.addEventListener('click', () => showManager(button.dataset.outboxKind));
    });
    document.getElementById('btn-save-draft')?.addEventListener('click', saveDraft);
    document.getElementById('compose-send-later')?.addEventListener('change', () => toggleScheduleControls());
    document.getElementById('btn-outbox-refresh')?.addEventListener('click', refreshList);
    document.getElementById('compose-modal')?.addEventListener('transitionend', () => {
      if (!document.getElementById('compose-modal')?.classList.contains('open')) toggleScheduleControls(false);
    });
    toggleScheduleControls(false);
    refreshCounts();
  }

  window.OutboxUI = {
    refresh: refreshCounts,
    refreshCounts,
    showManager,
    toggleScheduleControls,
    localDateTimeValue,
    onEngineEvent,
  };

  window.addEventListener('DOMContentLoaded', wire);
})();
