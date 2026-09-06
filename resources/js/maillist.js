/* LibraMail — liste virtuelle de messages */
'use strict';
// LibraMail 0.2.25 v2 — restauration complète des conversations
class VirtualMailList {
  constructor(element, callbacks = {}) {
    this.element = element;
    this.callbacks = callbacks;
    this.rows = [];
    this.visibleRows = [];
    this.expandedThreads = new Map();
    this.collapsedGroups = new Set();
    this.selectedKeys = new Set();
    // 0.5.0 — sélection globale de la vue, indépendante des lignes chargées.
    this.allViewSelectionItems = null;
    this.selectionAnchorKey = null;
    this.activeMessageId = null;
    this.rowHeight = 64;
    this.groupHeight = 32;
  }

  setData(rows = [], options = {}) {
    this.options = { ...(this.options || {}), ...options };
    const scrollTop = this.element?.scrollTop || 0;
    if (!options.preserveExpansion) this.expandedThreads.clear();
    if (!options.preserveSelection) {
      this.selectedKeys.clear();
      this.allViewSelectionItems = null;
      this.selectionAnchorKey = null;
    }
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
    div.classList.toggle('bulk-selected', Boolean(this.allViewSelectionItems) || this.selectedKeys.has(key));
    div.classList.toggle('active-message', String(row.id) === String(this.activeMessageId));
    div.dataset.messageId = row.id || '';
    div.dataset.threadKey = row.thread_key || row.parent_thread_key || '';
    // Le drag de classement est géré par Pointer Events. Cela évite de
    // dépendre du moteur HTML5 DnD de WebKitGTK, tout en restant indépendant
    // du drag & drop natif Neutralino utilisé par les pièces jointes.
    div.draggable = false;

    const sender = this.senderLabel(row);
    const subject = row.subject || window.t?.('mail.noSubject') || '(sans objet)';
    const snippet = row.snippet || '';
    const date = this.formatDate(row.date || row.thread_last_date);
    const count = Number(row.thread_count || 0);
    const isThread = row.is_thread && !row.is_thread_child && count > 1;
    const expanded = isThread && this.isThreadExpanded(row.thread_key);
    const labelsHtml = this.labelsHtml(row);

    div.innerHTML = `
      <span class="read-state-dot"></span>
      ${isThread ? `<button class="thread-toggle" type="button" aria-expanded="${expanded ? 'true' : 'false'}"><i class="fa-solid fa-chevron-${expanded ? 'down' : 'right'}"></i></button>` : ''}
      <button class="mail-select" type="button" title="${this.escape(window.t?.('selection.select') || 'Sélectionner')}">
        <i class="${(this.allViewSelectionItems || this.selectedKeys.has(key)) ? 'fa-solid fa-square-check' : 'fa-regular fa-square'}"></i>
      </button>
      ${this.avatarHtml(row, sender)}
      <span class="from"><span class="name">${this.escape(sender)}</span>${isThread ? `<span class="thread-count"><i class="fa-solid fa-comments"></i> ${count}</span>` : ''}</span>
      <span class="subject"><span class="subject-text"><span class="subj">${this.escape(subject)}</span>${snippet ? ` <span class="snippet">— ${this.escape(snippet)}</span>` : ''}</span>${labelsHtml}</span>
      <span class="quick">
        ${row.folder_role === 'trash' ? `<button class="iconbtn restore" type="button" data-action="restore" title="${typeof window.t === 'function' ? window.t('trash.restoreConversation') : 'Restore conversation'}" aria-label="${typeof window.t === 'function' ? window.t('trash.restoreConversation') : 'Restore conversation'}"><i class="fa-solid fa-rotate-left"></i></button>` : ''}
        <button class="iconbtn" data-action="seen" type="button"><i class="${this.isUnread(row) ? 'fa-regular fa-envelope-open' : 'fa-solid fa-envelope'}"></i></button>
        <button class="iconbtn" data-action="flag" type="button"><i class="${row.flagged ? 'fa-solid' : 'fa-regular'} fa-star"></i></button>
        <button class="iconbtn" data-action="label" type="button"><i class="fa-solid fa-tag"></i></button>
        <button class="iconbtn" data-action="local-folder" type="button"
                title="${this.escapeAttr(window.t?.('localFolder.classify') || 'Classer dans un dossier local')}"
                aria-label="${this.escapeAttr(window.t?.('localFolder.classify') || 'Classer dans un dossier local')}">
          <i class="fa-solid fa-folder-open"></i>
        </button>
        <button class="iconbtn" data-action="spam" type="button"><i class="fa-solid fa-ban"></i></button>
        <button class="iconbtn del" data-action="delete" type="button"><i class="fa-solid fa-trash"></i></button>
      </span>
      <span class="meta"><span>${this.escape(date)}</span>${row.has_attach ? '<i class="fa-solid fa-paperclip"></i>' : ''}${row.flagged ? '<i class="fa-solid fa-star"></i>' : ''}</span>`;

    div.querySelector('.mail-select')?.addEventListener('click', event => {
      event.stopPropagation();
      this.toggleSelection(row, event.shiftKey);
    });
    // LibraMail 0.2.24 UI v18 — la flèche est une vraie bascule.
    // Elle ne doit jamais ouvrir la ligne, ouvrir un onglet ou laisser un
    // double-clic remonter jusqu'au conteneur du message.
    const threadToggle = div.querySelector('.thread-toggle');
    threadToggle?.addEventListener('pointerdown', event => {
      event.stopPropagation();
    });
    threadToggle?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.callbacks.onQuickAction?.(row, 'toggle-thread', threadToggle);
    });
    threadToggle?.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    });
    div.querySelectorAll('.quick [data-action]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        this.callbacks.onQuickAction?.(row, button.dataset.action, button);
      });
    });
    // LibraMail 0.4.4 — drag interne dossiers locaux compatible WebKit.
    const localFolderDragPayload = () => {
      const currentItem = this.selectionItem(row);
      const currentKey = this.itemKey(currentItem);
      const items = this.selectedKeys.has(currentKey)
        ? (this.allViewSelectionItems
            ? this.allViewSelectionItems
            : this.visibleRows
                .map(visibleRow => this.selectionItem(visibleRow))
                .filter(item => this.selectedKeys.has(this.itemKey(item))))
        : [currentItem];
      return items.map(item => ({
        type: item.type,
        id: Number(item.id),
        threadKey: item.threadKey || undefined,
      })).filter(item => Number.isInteger(item.id) && item.id > 0);
    };

    let pointerDrag = null;
    let suppressOpenAfterPointerDrag = false;

    div.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      if (event.target.closest?.('button, input, select, textarea, a')) return;

      // LibraMail 0.4.7 — double-clic sur toute la ligne, détecté dès pointerdown.
      //
      // Le premier clic peut re-rendre la ligne pour la preview. On mémorise
      // donc le clic sur l'instance VirtualMailList, pas sur le noeud DOM.
      // Le second pointerdown sur la même ligne ouvre le lecteur modal avant
      // qu'un nouveau rerender ne puisse casser le double-clic.
      const openPointerNow = Date.now();
      const previousOpenPointerKey = String(this._lastOpenPointerKey || '');
      const previousOpenPointerAt = Number(this._lastOpenPointerAt || 0);
      const openAsDoubleClick = previousOpenPointerKey === key
        && previousOpenPointerAt > 0
        && openPointerNow - previousOpenPointerAt <= 450;

      if (openAsDoubleClick) {
        this._lastOpenPointerKey = '';
        this._lastOpenPointerAt = 0;
        this._suppressNextOpenClickKey = key;
        this._suppressNextOpenClickUntil = openPointerNow + 900;
        pointerDrag = null;
        event.preventDefault();
        event.stopPropagation();
        this.callbacks.onOpenTab?.(row);
        return;
      }

      this._lastOpenPointerKey = key;
      this._lastOpenPointerAt = openPointerNow;

      const items = localFolderDragPayload();
      if (!items.length) return;
      pointerDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        started: false,
        items,
      };
      try { div.setPointerCapture?.(event.pointerId); } catch {}
    });

    div.addEventListener('pointermove', event => {
      if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
      const distance = Math.hypot(
        event.clientX - pointerDrag.startX,
        event.clientY - pointerDrag.startY
      );
      if (!pointerDrag.started && distance < 7) return;

      if (!pointerDrag.started) {
        pointerDrag.started = true;
        try { window.getSelection?.()?.removeAllRanges?.(); } catch {}
        div.classList.add('local-folder-drag-source');
        document.dispatchEvent(new CustomEvent('libramail:local-folder-drag-start', {
          detail: { items: pointerDrag.items, x: event.clientX, y: event.clientY },
        }));
      }

      event.preventDefault();
      document.dispatchEvent(new CustomEvent('libramail:local-folder-drag-move', {
        detail: { items: pointerDrag.items, x: event.clientX, y: event.clientY },
      }));
    });

    const finishPointerDrag = (event, cancelled = false) => {
      if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
      const drag = pointerDrag;
      pointerDrag = null;
      try { div.releasePointerCapture?.(event.pointerId); } catch {}

      if (!drag.started) return;

      suppressOpenAfterPointerDrag = true;
      div.classList.remove('local-folder-drag-source');
      event.preventDefault();
      event.stopPropagation();

      document.dispatchEvent(new CustomEvent(
        cancelled ? 'libramail:local-folder-drag-cancel' : 'libramail:local-folder-drop',
        { detail: { items: drag.items, x: event.clientX, y: event.clientY } }
      ));
    };

    div.addEventListener('pointerup', event => finishPointerDrag(event, false));
    div.addEventListener('pointercancel', event => finishPointerDrag(event, true));
    div.addEventListener('click', event => {
      const suppressModalFollowup = String(this._suppressNextOpenClickKey || '') === key
        && Date.now() <= Number(this._suppressNextOpenClickUntil || 0);

      if (suppressModalFollowup) {
        this._suppressNextOpenClickKey = '';
        this._suppressNextOpenClickUntil = 0;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (suppressOpenAfterPointerDrag) {
        suppressOpenAfterPointerDrag = false;
        this._lastOpenPointerKey = '';
        this._lastOpenPointerAt = 0;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      this.callbacks.onOpen?.(row);
    });
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
    this.selectionAnchorKey = null;
    this.render(true);
  }

  setAllViewSelection(items = []) {
    const normalized = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!normalized.length) {
      this.clearSelection();
      return;
    }
    this.allViewSelectionItems = normalized;
    this.selectedKeys.clear();
    for (const row of this.visibleRows) {
      this.selectedKeys.add(this.itemKey(this.selectionItem(row)));
    }
    this.selectionAnchorKey = null;
    this.render(true);
  }

  clearSelection() {
    this.selectedKeys.clear();
    this.allViewSelectionItems = null;
    this.selectionAnchorKey = null;
    this.render(true);
  }

  toggleSelection(row, extendRange = false) {
    if (this.allViewSelectionItems) {
      // Dès qu'une case est modifiée individuellement, on revient à la
      // sélection explicite des lignes actuellement chargées.
      this.selectedKeys.clear();
      for (const visible of this.visibleRows) {
        this.selectedKeys.add(this.itemKey(this.selectionItem(visible)));
      }
      this.allViewSelectionItems = null;
    }
    const key = this.itemKey(this.selectionItem(row));
    if (extendRange && this.selectionAnchorKey) {
      const anchorIndex = this.visibleRows.findIndex(item =>
        this.itemKey(this.selectionItem(item)) === this.selectionAnchorKey);
      const currentIndex = this.visibleRows.findIndex(item =>
        this.itemKey(this.selectionItem(item)) === key);
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        for (let index = start; index <= end; index++) {
          this.selectedKeys.add(this.itemKey(this.selectionItem(this.visibleRows[index])));
        }
        this.render(true);
        return;
      }
    }
    if (this.selectedKeys.has(key)) this.selectedKeys.delete(key);
    else this.selectedKeys.add(key);
    this.selectionAnchorKey = key;
    this.render(true);
  }

  emitSelection() {
    if (this.allViewSelectionItems) {
      this.callbacks.onSelectionChange?.([...this.allViewSelectionItems], {
        total: this.allViewSelectionItems.length,
        allSelected: true,
        allView: true,
      });
      return;
    }

    const selected = this.visibleRows.map(row => this.selectionItem(row)).filter(item => this.selectedKeys.has(this.itemKey(item)));
    this.callbacks.onSelectionChange?.(selected, {
      total: this.visibleRows.length,
      allSelected: this.visibleRows.length > 0 && selected.length === this.visibleRows.length,
      allView: false,
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

  // LibraMail 0.4.4 — dates d'archives avec année.
  // Pour l'année courante, on conserve l'affichage compact jour/mois.
  // Pour un message plus ancien (ou futur), l'année devient explicite.
  formatDate(value) {
    const date = new Date(value || '');
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const options = { day: '2-digit', month: '2-digit' };
    if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
    return date.toLocaleDateString(window.I18N?.locale || 'fr', options);
  }

  dateGroupKey(value) {
    const date = new Date(value || Date.now());
    const now = new Date();
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const diff = Math.round((today - day) / 86400000);

    if (diff === 0) return { id: 'today', label: window.t?.('group.today') || 'Aujourd’hui' };
    if (diff === 1) return { id: 'yesterday', label: window.t?.('group.yesterday') || 'Hier' };
    if (diff > 1 && diff < 7) return { id: 'week', label: window.t?.('group.thisWeek') || 'Cette semaine' };
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
      return { id: 'month', label: window.t?.('group.thisMonth') || 'Ce mois-ci' };
    }
    return { id: 'older', label: window.t?.('group.older') || 'Plus ancien' };
  }


  // LibraMail 0.4.7 — mise à jour locale des messages d'une discussion dépliée.
  patchExpandedThreadMessages(threadKey, updater) {
    const key = String(threadKey || '');
    if (!key || typeof updater !== 'function') return false;

    const state = this.expandedThreads.get(key);
    if (!state || !Array.isArray(state.messages)) return false;

    const messages = state.messages.map(message => {
      const candidate = updater({ ...message });
      return candidate && typeof candidate === 'object' ? candidate : message;
    });

    this.expandedThreads.set(key, { ...state, messages });
    this.render(true);
    return true;
  }

  labelsHtml(row) {
    const allLabels = this.labelList(row);
    const labels = allLabels.slice(0, 3);
    if (!labels.length) return '';
    const more = Math.max(0, allLabels.length - labels.length);
    const chips = labels.map(label => {
      const name = label?.name || label?.label || '';
      if (!name) return '';
      const color = label?.color || '#8b7dd8';
      return `<span class="mail-label-chip" style="--label-color:${this.escapeAttr(color)}" title="${this.escapeAttr(name)}">${this.escape(name)}</span>`;
    }).join('');
    return `<span class="mail-labels">${chips}${more ? `<span class="mail-label-chip more">+${more}</span>` : ''}</span>`;
  }

  labelList(row) {
    const raw = row?.labels;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter(label => label && (label.name || label.label));
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return [];
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.filter(label => label && (label.name || label.label));
      } catch (_) {
        return trimmed.split(',').map(name => ({ name: name.trim(), color: '#8b7dd8' })).filter(label => label.name);
      }
    }
    return [];
  }

  avatarHtml(row, sender) {
    const icon = row?.sender_icon_data || row?.sender_icon_url || row?.sender_icon || row?.avatar_url || row?.contact_avatar_data || row?.contact_avatar || row?.provider_icon || row?.account_icon || '';
    const label = sender || row?.from_name || row?.from_addr || row?.to_name || row?.to_addr || '?';
    const initials = this.initials(label);
    const bg = this.colorFrom(label);
    const safeBg = this.escapeAttr(bg);
    const safeLabel = this.escapeAttr(label);
    const safeInitials = this.escape(initials);

    if (icon) {
      const safeIcon = this.escapeAttr(icon);
      return `<span class="avatar sender-avatar avatar-image" style="--avatar-bg:${safeBg};background:${safeBg}" title="${safeLabel}"><img src="${safeIcon}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false;"><span hidden>${safeInitials}</span></span>`;
    }

    return `<span class="avatar sender-avatar avatar-provider" style="--avatar-bg:${safeBg};background:${safeBg}" title="${safeLabel}"><span>${safeInitials}</span></span>`;
  }

  escapeAttr(value) {
    return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  initials(value) {
    const words = String(value || '?').trim().split(/[\s@._-]+/).filter(Boolean);
    return (words[0]?.[0] || '?').toUpperCase() + (words[1]?.[0] || '').toUpperCase();
  }
  colorFrom(value) { let hue = 0; for (const ch of String(value || '')) hue = (hue * 31 + ch.charCodeAt(0)) % 360; return `hsl(${hue} 42% 46%)`; }
  escape(value) { return String(value || '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character])); }
}
window.VirtualMailList = VirtualMailList;
