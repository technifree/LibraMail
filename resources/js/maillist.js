/* LibraMail — liste virtuelle de messages */
'use strict';
class VirtualMailList {
  constructor(element, callbacks = {}) {
    this.element = element;
    this.callbacks = callbacks;
    this.rows = [];
    this.visibleRows = [];
    this.expandedThreads = new Map();
    this.collapsedGroups = new Set();
    this.selectedKeys = new Set();
    this.activeMessageId = null;
    this.rowHeight = 64;
    this.groupHeight = 32;
  }

  setData(rows = [], options = {}) {
    this.options = { ...(this.options || {}), ...options };
    const scrollTop = this.element?.scrollTop || 0;
    if (!options.preserveExpansion) this.expandedThreads.clear();
    if (!options.preserveSelection) this.selectedKeys.clear();
    if (!options.preserveActive) this.activeMessageId = null;
    this.rows = Array.isArray(rows) ? rows : [];
    this.render(Boolean(options.preservePosition));
    if (options.preservePosition && this.element) this.element.scrollTop = scrollTop;
  }

  render(preservePosition = false) {
    if (!this.element) return;
    const scrollTop = this.element.scrollTop;
    const items = this.buildVisibleItems();
    this.visibleRows = items.filter(item => item.type === 'row').map(item => item.row);
    const totalHeight = items.reduce((sum, item) => sum + item.height, 0);
    this.element.innerHTML = `<div id="mail-spacer" style="height:${totalHeight}px"></div>`;

    let top = 0;
    for (const item of items) {
      if (item.type === 'group') {
        this.element.appendChild(this.renderGroup(item, top));
      } else {
        this.element.appendChild(this.renderRow(item.row, top));
      }
      top += item.height;
    }
    if (preservePosition) this.element.scrollTop = scrollTop;
    this.emitSelection();
  }

  buildVisibleItems() {
    const rows = [];
    const source = [...this.rows];
    if (!this.options?.groupByDate) {
      for (const row of source) this.pushRowWithChildren(rows, row);
      return rows;
    }

    const groups = new Map();
    for (const row of source) {
      const key = this.dateGroupKey(row.date || row.thread_last_date || row.created_at);
      if (!groups.has(key.id)) groups.set(key.id, { key, rows: [] });
      groups.get(key.id).rows.push(row);
    }
    for (const group of groups.values()) {
      rows.push({ type: 'group', key: group.key, count: group.rows.length, unread: group.rows.filter(row => this.isUnread(row)).length, height: this.groupHeight });
      if (!this.collapsedGroups.has(group.key.id)) {
        for (const row of group.rows) this.pushRowWithChildren(rows, row);
      }
    }
    return rows;
  }

  pushRowWithChildren(target, row) {
    target.push({ type: 'row', row, height: this.rowHeight });
    if (row?.is_thread && !row.is_thread_child && this.expandedThreads.has(row.thread_key)) {
      const state = this.expandedThreads.get(row.thread_key) || {};
      for (const child of state.messages || []) {
        target.push({ type: 'row', row: { ...child, is_thread_child: true, parent_thread_key: row.thread_key }, height: this.rowHeight });
      }
    }
  }

  renderGroup(item, top) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mail-group-header';
    if (this.collapsedGroups.has(item.key.id)) button.classList.add('collapsed');
    button.style.top = `${top}px`;
    button.style.height = `${item.height}px`;
    button.innerHTML = `<i class="fa-solid fa-chevron-down mail-group-chevron"></i>
      <span class="mail-group-title">${this.escape(item.key.label)}</span>
      <span class="mail-group-count">${item.count}</span>
      ${item.unread ? `<span class="mail-group-unread">${item.unread}</span>` : ''}`;
    button.onclick = () => {
      if (this.collapsedGroups.has(item.key.id)) this.collapsedGroups.delete(item.key.id);
      else this.collapsedGroups.add(item.key.id);
      this.render(true);
    };
    return button;
  }

  renderRow(row, top) {
    const item = this.selectionItem(row);
    const key = this.itemKey(item);
    const div = document.createElement('div');
    div.className = 'mail-row';
    div.style.top = `${top}px`;
    div.classList.toggle('unread', this.isUnread(row));
    div.classList.toggle('conversation-row', Boolean(row.is_thread && !row.is_thread_child));
    div.classList.toggle('thread-child', Boolean(row.is_thread_child));
    div.classList.toggle('thread-reply', Boolean(row.is_thread_child));
    div.classList.toggle('bulk-selected', this.selectedKeys.has(key));
    div.classList.toggle('active-message', String(row.id) === String(this.activeMessageId));
    div.dataset.messageId = row.id || '';
    div.dataset.threadKey = row.thread_key || row.parent_thread_key || '';

    const sender = this.senderLabel(row);
    const subject = row.subject || window.t?.('mail.noSubject') || '(sans objet)';
    const snippet = row.snippet || '';
    const date = this.formatDate(row.date || row.thread_last_date);
    const count = Number(row.thread_count || 0);
    const isThread = row.is_thread && !row.is_thread_child && count > 1;
    const expanded = isThread && this.isThreadExpanded(row.thread_key);

    div.innerHTML = `
      <span class="read-state-dot"></span>
      ${isThread ? `<button class="thread-toggle" type="button"><i class="fa-solid fa-chevron-${expanded ? 'down' : 'right'}"></i></button>` : ''}
      <button class="mail-select" type="button" title="${this.escape(window.t?.('selection.select') || 'Sélectionner')}">
        <i class="${this.selectedKeys.has(key) ? 'fa-solid fa-square-check' : 'fa-regular fa-square'}"></i>
      </button>
      <span class="avatar" style="background:${this.colorFrom(sender)}">${this.initials(sender)}</span>
      <span class="from"><span class="name">${this.escape(sender)}</span>${isThread ? `<span class="thread-count"><i class="fa-solid fa-comments"></i> ${count}</span>` : ''}</span>
      <span class="subject"><span class="subj">${this.escape(subject)}</span>${snippet ? ` <span class="snippet">— ${this.escape(snippet)}</span>` : ''}</span>
      <span class="quick">
        <button class="iconbtn" data-action="seen" type="button"><i class="${this.isUnread(row) ? 'fa-regular fa-envelope-open' : 'fa-solid fa-envelope'}"></i></button>
        <button class="iconbtn" data-action="flag" type="button"><i class="${row.flagged ? 'fa-solid' : 'fa-regular'} fa-star"></i></button>
        <button class="iconbtn" data-action="label" type="button"><i class="fa-solid fa-tag"></i></button>
        <button class="iconbtn" data-action="spam" type="button"><i class="fa-solid fa-ban"></i></button>
        <button class="iconbtn del" data-action="delete" type="button"><i class="fa-solid fa-trash"></i></button>
      </span>
      <span class="meta"><span>${this.escape(date)}</span>${row.has_attach ? '<i class="fa-solid fa-paperclip"></i>' : ''}${row.flagged ? '<i class="fa-solid fa-star"></i>' : ''}</span>`;

    div.querySelector('.mail-select')?.addEventListener('click', event => {
      event.stopPropagation();
      this.toggleSelection(row);
    });
    div.querySelector('.thread-toggle')?.addEventListener('click', event => {
      event.stopPropagation();
      this.callbacks.onOpen?.(row);
    });
    div.querySelectorAll('.quick [data-action]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        this.callbacks.onQuickAction?.(row, button.dataset.action, button);
      });
    });
    div.addEventListener('click', () => this.callbacks.onOpen?.(row));
    div.addEventListener('dblclick', event => {
      event.preventDefault();
      this.callbacks.onOpenTab?.(row);
    });
    return div;
  }

  selectAll() {
    if (this.visibleRows.length && this.visibleRows.every(row => this.selectedKeys.has(this.itemKey(this.selectionItem(row))))) {
      this.selectedKeys.clear();
    } else {
      for (const row of this.visibleRows) this.selectedKeys.add(this.itemKey(this.selectionItem(row)));
    }
    this.render(true);
  }

  clearSelection() {
    this.selectedKeys.clear();
    this.render(true);
  }

  toggleSelection(row) {
    const key = this.itemKey(this.selectionItem(row));
    if (this.selectedKeys.has(key)) this.selectedKeys.delete(key);
    else this.selectedKeys.add(key);
    this.render(true);
  }

  emitSelection() {
    const selected = this.visibleRows.map(row => this.selectionItem(row)).filter(item => this.selectedKeys.has(this.itemKey(item)));
    this.callbacks.onSelectionChange?.(selected, {
      total: this.visibleRows.length,
      allSelected: this.visibleRows.length > 0 && selected.length === this.visibleRows.length,
    });
  }

  selectionItem(row) {
    const isThread = Boolean(row?.is_thread && !row?.is_thread_child);
    return {
      type: isThread ? 'thread' : 'message',
      id: Number(row?.id || 0),
      threadKey: row?.thread_key || row?.parent_thread_key || '',
      count: isThread ? Math.max(1, Number(row?.thread_count || 1)) : 1,
      folderRole: row?.folder_role || row?.folderRole || '',
      isSpam: Boolean(row?.is_spam || row?.isSpam),
      flagged: Boolean(row?.flagged),
      row,
    };
  }

  itemKey(item) { return item.type === 'thread' ? `thread:${item.threadKey}` : `message:${item.id}`; }
  isUnread(row) { return row?.is_thread && !row?.is_thread_child ? Number(row.thread_unread || 0) > 0 : !row?.seen; }
  isThreadExpanded(threadKey) { return this.expandedThreads.has(threadKey); }
  expandThread(threadKey, messages = [], activeId = null) { this.expandedThreads.set(threadKey, { messages, activeId }); this.activeMessageId = activeId || this.activeMessageId; this.render(true); }
  collapseThread(threadKey) { this.expandedThreads.delete(threadKey); this.render(true); }
  setActiveMessage(id) { this.activeMessageId = id; this.render(true); }
  patchRow(id, patch = {}) { const row = this.rows.find(item => Number(item.id) === Number(id)); if (row) Object.assign(row, patch); this.render(true); }
  patchThread(threadKey, patch = {}) { const row = this.rows.find(item => item.thread_key === threadKey); if (row) Object.assign(row, patch); this.render(true); }
  patchConversationMessage(threadKey, id, patch = {}) { const state = this.expandedThreads.get(threadKey); const row = state?.messages?.find(item => Number(item.id) === Number(id)); if (row) Object.assign(row, patch); this.render(true); }

  senderLabel(row) {
    if (row?.display_mode === 'sent' || row?.folder_role === 'sent') return row.to_addr || row.to_name || window.t?.('mail.unknownRecipient') || 'Destinataire inconnu';
    return row?.contact_name || row?.from_name || row?.from_addr || window.t?.('mail.unknownSender') || 'Expéditeur inconnu';
  }

  formatDate(value) {
    const date = new Date(value || '');
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(window.I18N?.locale || 'fr', { day: '2-digit', month: '2-digit' });
  }

  dateGroupKey(value) {
    const date = new Date(value || Date.now());
    const now = new Date();
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const diff = Math.round((today - day) / 86400000);
    let id = date.toISOString().slice(0, 10);
    let label = date.toLocaleDateString(window.I18N?.locale || 'fr', { weekday: 'long', day: 'numeric', month: 'long' });
    if (diff === 0) { id = 'today'; label = window.t?.('group.today') || 'Aujourd’hui'; }
    else if (diff > 0 && diff < 7) { id = 'week'; label = window.t?.('group.week') || 'Cette semaine'; }
    else if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) { id = 'month'; label = window.t?.('group.month') || 'Ce mois'; }
    return { id, label };
  }

  initials(value) {
    const words = String(value || '?').trim().split(/[\s@._-]+/).filter(Boolean);
    return (words[0]?.[0] || '?').toUpperCase() + (words[1]?.[0] || '').toUpperCase();
  }
  colorFrom(value) { let hue = 0; for (const ch of String(value || '')) hue = (hue * 31 + ch.charCodeAt(0)) % 360; return `hsl(${hue} 42% 46%)`; }
  escape(value) { return String(value || '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character])); }
}
window.VirtualMailList = VirtualMailList;
