/* LibraMail — Liste virtualisée avec conversations dépliables et groupes temporels. */
'use strict';
class VirtualMailList {
  constructor(container, { onOpen, onOpenTab, onQuickAction, onSelectionChange }) {
    this.container = container;
    this.onOpen = onOpen;
    this.onOpenTab = onOpenTab;
    this.onQuickAction = onQuickAction;
    this.onSelectionChange = onSelectionChange;
    this.sourceRows = [];
    this.rows = [];
    this.groupByDate = false;
    this.collapsedGroups = new Set();
    this.expandedThread = null;
    this.expandedMessages = [];
    this.selectedKey = null;
    this.selectedKeys = new Set();
    this.selectionAnchorKey = null;
    this.positions = [];
    this.rendered = new Map();

    this.spacer = document.createElement('div');
    this.spacer.id = 'mail-spacer';
    container.appendChild(this.spacer);
    container.addEventListener('scroll', () => this.render());
    container.setAttribute('tabindex', '0');
    container.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        this.selectAll();
      } else if (event.key === 'Escape' && this.selectedKeys.size) {
        event.preventDefault();
        this.clearSelection();
      }
    });
    new ResizeObserver(() => this.render()).observe(container);
  }

  setData(rows, {
    groupByDate = false,
    preserveExpansion = false,
    preservePosition = false,
    preserveActive = false,
    preserveSelection = false,
  } = {}) {
    const previousScrollTop = this.container.scrollTop;
    const previousSelectedKey = this.selectedKey;
    const previousSelectedKeys = new Set(this.selectedKeys);
    const previousSelectionAnchorKey = this.selectionAnchorKey;

    this.sourceRows = Array.isArray(rows) ? rows : [];
    this.groupByDate = Boolean(groupByDate);
    if (!preserveActive) this.selectedKey = null;
    if (!preserveSelection) this.clearSelection({ notify: false, render: false });

    // Conserve l'état replié pendant les actualisations, mais retire les
    // périodes qui n'existent plus dans la liste courante.
    const availableGroups = new Set(this.sourceRows.map(row => dateGroupKey(row.date)));
    this.collapsedGroups = new Set(
      [...this.collapsedGroups].filter(group => availableGroups.has(group))
    );
    if (!preserveExpansion || !this.sourceRows.some(row => row.thread_key === this.expandedThread)) {
      this.expandedThread = null;
      this.expandedMessages = [];
    }

    this.rebuild();

    const availableKeys = new Set(
      [...this.sourceRows, ...this.expandedMessages]
        .filter(row => row && row._type !== 'group')
        .map(rowKey)
    );
    if (preserveActive) {
      this.selectedKey = availableKeys.has(previousSelectedKey) ? previousSelectedKey : null;
    }
    if (preserveSelection) {
      this.selectedKeys = new Set(
        [...previousSelectedKeys].filter(key => availableKeys.has(key))
      );
      this.selectionAnchorKey = availableKeys.has(previousSelectionAnchorKey)
        ? previousSelectionAnchorKey
        : null;
    }

    const totalHeight = this.positions.length
      ? this.positions[this.positions.length - 1].top + this.positions[this.positions.length - 1].height
      : 0;
    this.container.scrollTop = preservePosition
      ? Math.min(previousScrollTop, Math.max(0, totalHeight - this.container.clientHeight))
      : 0;
    this.render(true);
    this.notifySelection();
  }

  selectionDescriptor(row) {
    if (!row || row._type === 'group') return null;
    const isThread = Boolean(row.is_thread && !row.is_thread_child);
    return {
      key: rowKey(row),
      type: isThread ? 'thread' : 'message',
      id: row.id,
      threadKey: isThread ? row.thread_key : null,
      folderRole: row.folder_role || '',
      isSpam: Boolean(row.is_spam),
      seen: isThread ? Number(row.thread_unread || 0) === 0 : Boolean(row.seen),
      flagged: Boolean(row.flagged),
      count: isThread ? Number(row.thread_count || 1) : 1,
    };
  }

  selectableRows() {
    return this.sourceRows.filter(row => row && row._type !== 'group');
  }

  rowByKey(key) {
    return [...this.sourceRows, ...this.expandedMessages].find(row => rowKey(row) === key) || null;
  }

  selectedItems() {
    const items = [];
    for (const key of this.selectedKeys) {
      const descriptor = this.selectionDescriptor(this.rowByKey(key));
      if (descriptor) items.push(descriptor);
    }
    return items;
  }

  notifySelection() {
    if (typeof this.onSelectionChange !== 'function') return;
    const selectable = this.selectableRows();
    const selected = this.selectedItems();
    this.onSelectionChange(selected, {
      total: selectable.length,
      allSelected: selectable.length > 0 && selectable.every(row => this.selectedKeys.has(rowKey(row))),
    });
  }

  clearSelection({ notify = true, render = true } = {}) {
    this.selectedKeys.clear();
    this.selectionAnchorKey = null;
    if (render) this.render(true);
    if (notify) this.notifySelection();
  }

  selectAll() {
    const rows = this.selectableRows();
    const allSelected = rows.length > 0 && rows.every(row => this.selectedKeys.has(rowKey(row)));
    this.selectedKeys.clear();
    if (!allSelected) {
      for (const row of rows) this.selectedKeys.add(rowKey(row));
      this.selectionAnchorKey = rows.length ? rowKey(rows[rows.length - 1]) : null;
    } else {
      this.selectionAnchorKey = null;
    }
    this.render(true);
    this.notifySelection();
  }

  removeConflictingSelection(row) {
    if (row.is_thread && !row.is_thread_child) {
      for (const key of [...this.selectedKeys]) {
        const selected = this.rowByKey(key);
        if (selected?.is_thread_child && selected.parent_thread_key === row.thread_key) {
          this.selectedKeys.delete(key);
        }
      }
    } else if (row.is_thread_child) {
      this.selectedKeys.delete(`thread:${row.parent_thread_key || row.thread_key}`);
    }
  }

  toggleSelection(row, { range = false } = {}) {
    if (!row || row._type === 'group') return;
    const key = rowKey(row);
    if (range && this.selectionAnchorKey) {
      const candidates = this.rows.filter(item => item && item._type !== 'group');
      const anchorIndex = candidates.findIndex(item => rowKey(item) === this.selectionAnchorKey);
      const currentIndex = candidates.findIndex(item => rowKey(item) === key);
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const [start, end] = anchorIndex < currentIndex
          ? [anchorIndex, currentIndex]
          : [currentIndex, anchorIndex];
        for (const candidate of candidates.slice(start, end + 1)) {
          this.removeConflictingSelection(candidate);
          this.selectedKeys.add(rowKey(candidate));
        }
      } else {
        this.selectedKeys.add(key);
      }
    } else {
      this.removeConflictingSelection(row);
      if (this.selectedKeys.has(key)) this.selectedKeys.delete(key);
      else this.selectedKeys.add(key);
      this.selectionAnchorKey = key;
    }
    this.render(true);
    this.notifySelection();
  }

  setGrouping(enabled) {
    this.groupByDate = Boolean(enabled);
    this.rebuild();
  }

  isThreadExpanded(threadKey) {
    return this.expandedThread === threadKey;
  }

  isGroupCollapsed(group) {
    return this.collapsedGroups.has(group);
  }

  toggleGroup(group) {
    if (!group) return;
    if (this.collapsedGroups.has(group)) this.collapsedGroups.delete(group);
    else this.collapsedGroups.add(group);
    this.rebuild();
  }

  expandThread(threadKey, messages, activeId = null) {
    this.expandedThread = threadKey;
    this.expandedMessages = Array.isArray(messages) ? messages.map((message, index) => ({
      ...message,
      is_thread_child: true,
      parent_thread_key: threadKey,
      thread_depth: index === 0 ? 0 : 1,
    })) : [];
    if (activeId != null) this.selectedKey = `message:${activeId}`;
    this.rebuild();
  }

  collapseThread(threadKey) {
    if (this.expandedThread !== threadKey) return;
    this.expandedThread = null;
    this.expandedMessages = [];
    this.rebuild();
  }

  setActiveMessage(id) {
    this.selectedKey = `message:${id}`;
    this.render(true);
  }

  patchRow(id, patch) {
    let changed = false;
    for (const row of this.sourceRows) {
      if (!row.is_thread && row.id === id) { Object.assign(row, patch); changed = true; }
    }
    for (const row of this.expandedMessages) {
      if (row.id === id) { Object.assign(row, patch); changed = true; }
    }
    if (changed) this.rebuild(false);
  }

  patchThread(threadKey, patch) {
    const row = this.sourceRows.find(item => item.thread_key === threadKey);
    if (row) {
      Object.assign(row, patch);
      this.rebuild(false);
    }
  }

  patchConversationMessage(threadKey, id, patch) {
    const child = this.expandedMessages.find(item => item.parent_thread_key === threadKey && item.id === id);
    if (child) Object.assign(child, patch);
    const parent = this.sourceRows.find(item => item.thread_key === threadKey);
    if (parent) {
      const unread = this.expandedMessages.filter(item => !item.seen).length;
      parent.thread_unread = unread;
      parent.seen = unread ? 0 : 1;
    }
    this.rebuild(false);
  }

  removeRow(id) {
    const removedKeys = [...this.sourceRows, ...this.expandedMessages]
      .filter(row => row.id === id)
      .map(rowKey);
    for (const key of removedKeys) this.selectedKeys.delete(key);
    this.sourceRows = this.sourceRows.filter(row => row.id !== id);
    this.expandedMessages = this.expandedMessages.filter(row => row.id !== id);
    this.rebuild();
    this.notifySelection();
  }

  rebuild(clearRendered = true) {
    const output = [];
    let lastGroup = null;
    let groupHeader = null;

    for (const row of this.sourceRows) {
      if (this.groupByDate) {
        const group = dateGroupKey(row.date);
        if (group !== lastGroup) {
          groupHeader = {
            _type: 'group',
            group,
            id: `group:${group}`,
            count: 0,
            unread: 0,
            collapsed: this.isGroupCollapsed(group),
          };
          output.push(groupHeader);
          lastGroup = group;
        }

        groupHeader.count += 1;
        const unread = row.is_thread ? Number(row.thread_unread) > 0 : !row.seen;
        if (unread) groupHeader.unread += 1;

        // Le titre de période reste visible, mais son contenu disparaît.
        if (groupHeader.collapsed) continue;
      }

      output.push(row);
      if (row.is_thread && row.thread_key === this.expandedThread) {
        output.push(...this.expandedMessages);
      }
    }
    this.rows = output;
    this.positions = [];
    let top = 0;
    for (const row of this.rows) {
      const height = this.rowHeight(row);
      this.positions.push({ top, height });
      top += height;
    }
    this.spacer.style.height = `${top}px`;
    if (clearRendered) this.clearRendered();
    this.render(true);
  }

  rowHeight(row) {
    if (row?._type === 'group') return 34;
    if (row?.is_thread_child) return 58;
    return 68;
  }

  clearRendered() {
    for (const element of this.rendered.values()) element.remove();
    this.rendered.clear();
  }

  render(force = false) {
    const top = this.container.scrollTop;
    const bottom = top + this.container.clientHeight;
    const visible = [];
    for (let index = 0; index < this.rows.length; index++) {
      const position = this.positions[index];
      if (position.top + position.height < top - 250) continue;
      if (position.top > bottom + 250) break;
      visible.push(index);
    }
    const visibleSet = new Set(visible);
    for (const [index, element] of this.rendered) {
      if (!visibleSet.has(index)) {
        element.remove();
        this.rendered.delete(index);
      }
    }
    for (const index of visible) {
      const row = this.rows[index];
      const wantedType = row._type === 'group' ? 'group' : 'mail';
      let element = this.rendered.get(index);
      if (!element || element.dataset.rowType !== wantedType) {
        if (element) element.remove();
        element = wantedType === 'group' ? this.buildGroupRow() : this.buildMailRow();
        element.dataset.rowType = wantedType;
        this.container.appendChild(element);
        this.rendered.set(index, element);
      }
      this.fillRow(element, row, index);
    }
  }

  buildGroupRow() {
    const element = document.createElement('div');
    element.className = 'mail-group-header';
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    element.innerHTML = `
      <i class="mail-group-chevron fa-solid fa-chevron-down"></i>
      <span class="mail-group-title"></span>
      <span class="mail-group-unread hidden"></span>
      <span class="mail-group-count"></span>`;

    const toggle = () => this.toggleGroup(element._row?.group);
    element.addEventListener('click', toggle);
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
    return element;
  }

  buildMailRow() {
    const element = document.createElement('div');
    element.className = 'mail-row';
    element.innerHTML = `
      <div class="read-state-dot"></div>
      <button class="mail-select" data-act="select" type="button"><i class="fa-regular fa-square"></i></button>
      <button class="thread-toggle hidden" data-act="toggle-thread"><i class="fa-solid fa-chevron-right"></i></button>
      <div class="avatar"></div>
      <div class="from">
        <span class="account-dot"></span>
        <span class="name"></span>
        <span class="sent-account hidden"></span>
        <span class="thread-count hidden"></span>
      </div>
      <div class="subject"><span class="subj"></span> <span class="snippet"></span></div>
      <div class="quick">
        <button class="iconbtn" data-act="reply"><i class="fa-solid fa-reply"></i></button>
        <button class="iconbtn" data-act="seen"><i class="fa-regular fa-envelope-open"></i></button>
        <button class="iconbtn" data-act="label"><i class="fa-solid fa-tag"></i></button>
        <button class="iconbtn" data-act="spam"><i class="fa-solid fa-ban"></i></button>
        <button class="iconbtn" data-act="flag"><i class="fa-regular fa-star"></i></button>
        <button class="iconbtn del" data-act="delete"><i class="fa-solid fa-trash"></i></button>
      </div>
      <div class="meta"><span class="date"></span><span class="icons"></span></div>`;

    element.addEventListener('click', event => {
      const action = event.target.closest('[data-act]');
      if (action) {
        event.stopPropagation();
        if (action.dataset.act === 'select') {
          this.toggleSelection(element._row, { range: event.shiftKey });
        } else {
          this.onQuickAction(element._row, action.dataset.act, action);
        }
        return;
      }
      const row = element._row;
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        event.preventDefault();
        this.toggleSelection(row, { range: event.shiftKey });
        return;
      }
      // Le clic simple reste immédiat. Retarder l'ouverture pour attendre un
      // éventuel double-clic s'est montré peu fiable sous WebKitGTK.
      this.selectedKey = rowKey(row);
      Promise.resolve(this.onOpen(row)).catch(error => console.error('[LibraMail] Ouverture du message :', error));
      this.render(true);
    });
    element.addEventListener('dblclick', event => {
      if (event.target.closest('[data-act]')) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      const row = element._row;
      this.selectedKey = rowKey(row);
      const open = typeof this.onOpenTab === 'function' ? this.onOpenTab : this.onOpen;
      Promise.resolve(open(row)).catch(error => console.error('[LibraMail] Ouverture de l’onglet :', error));
      this.render(true);
    });
    return element;
  }

  fillRow(element, row, index) {
    const position = this.positions[index];
    element.style.top = `${position.top}px`;
    element.style.height = `${position.height}px`;

    if (row._type === 'group') {
      element._row = row;
      element.classList.toggle('collapsed', Boolean(row.collapsed));
      element.setAttribute('aria-expanded', row.collapsed ? 'false' : 'true');
      element.title = t(row.collapsed ? 'group.expandPeriod' : 'group.collapsePeriod');
      element.querySelector('.mail-group-chevron').className = row.collapsed
        ? 'mail-group-chevron fa-solid fa-chevron-right'
        : 'mail-group-chevron fa-solid fa-chevron-down';
      element.querySelector('.mail-group-title').textContent = t(`group.${row.group}`);
      element.querySelector('.mail-group-count').textContent = row.count || 0;

      const unread = element.querySelector('.mail-group-unread');
      unread.textContent = row.unread || '';
      unread.classList.toggle('hidden', !row.unread);
      unread.title = row.unread ? `${row.unread} ${t('stats.unread').toLowerCase()}` : '';
      return;
    }

    element._row = row;
    element.title = t('tabs.doubleClickHint');
    const unread = row.is_thread ? Number(row.thread_unread) > 0 : !row.seen;
    const threadCount = Number(row.thread_count || 1);
    const isConversation = Boolean(row.is_thread && threadCount > 1);
    const isChild = Boolean(row.is_thread_child);
    const isReply = isChild && Number(row.thread_depth) > 0;

    element.className = 'mail-row';
    element.classList.toggle('unread', unread);
    const selectionKey = rowKey(row);
    const bulkSelected = this.selectedKeys.has(selectionKey);
    element.classList.toggle('active-message', selectionKey === this.selectedKey);
    element.classList.toggle('bulk-selected', bulkSelected);
    element.classList.toggle('conversation-row', isConversation);
    element.classList.toggle('thread-child', isChild);
    element.classList.toggle('thread-origin', isChild && !isReply);
    element.classList.toggle('thread-reply', isReply);

    const outgoing = row.folder_role === 'sent' || row.display_mode === 'sent';
    const sender = row.contact_name || row.from_name || row.from_addr || '?';
    const recipient = row.to_addr || '?';
    const displayName = outgoing
      ? t('mail.to', { recipient })
      : (row.is_thread && row.participants ? row.participants : sender);
    const avatarSource = outgoing ? recipient : sender;
    const avatarAddress = outgoing ? recipient : (row.from_addr || sender);
    const avatarData = App.contactAvatar(avatarAddress);
    const avatar = element.querySelector('.avatar');
    avatar.style.backgroundColor = colorFrom(avatarAddress);
    avatar.style.backgroundImage = avatarData ? `url("${avatarData}")` : 'none';
    avatar.textContent = avatarData ? '' : (avatarSource.trim()[0]?.toUpperCase() || '?');
    avatar.classList.toggle('has-avatar', Boolean(avatarData));

    const accountEmail = App.accountEmail(row.account_id);
    const dot = element.querySelector('.account-dot');
    dot.style.background = App.accountColor(row.account_id);
    dot.title = accountEmail;
    element.querySelector('.name').textContent = displayName;
    const sentAccount = element.querySelector('.sent-account');
    sentAccount.textContent = outgoing ? t('sent.viaAccount', { account: accountEmail }) : '';
    sentAccount.classList.toggle('hidden', !outgoing);

    const count = element.querySelector('.thread-count');
    count.textContent = isConversation ? threadCount : '';
    count.classList.toggle('hidden', !isConversation);
    count.title = isConversation ? t('conversation.messages', { count: threadCount }) : '';

    const toggle = element.querySelector('.thread-toggle');
    toggle.classList.toggle('hidden', !isConversation);
    toggle.querySelector('i').className = this.isThreadExpanded(row.thread_key)
      ? 'fa-solid fa-chevron-down'
      : 'fa-solid fa-chevron-right';
    toggle.title = this.isThreadExpanded(row.thread_key) ? t('conversation.collapse') : t('conversation.expand');

    const displayedSubject = row.is_thread ? stripReplyPrefixes(row.subject) : row.subject;
    element.querySelector('.subj').textContent = displayedSubject || t('mail.noSubject');
    element.querySelector('.snippet').textContent = row.snippet ? ' — ' + row.snippet : '';
    element.querySelector('.date').textContent = fmtDate(row.date);

    const icons = [];
    if (isConversation) icons.push('<i class="fa-solid fa-comments"></i>');
    if (row.contact_name) icons.push(`<i class="fa-solid ${row.contact_trusted ? 'fa-shield-halved' : 'fa-address-book'}" title="${escAttr(t(row.contact_trusted ? 'contacts.trustedContact' : 'contacts.knownContact'))}"></i>`);
    if (row.has_attach) icons.push('<i class="fa-solid fa-paperclip"></i>');
    if (row.flagged) icons.push('<i class="fa-solid fa-star" style="color:var(--accent)"></i>');

    let labels = '';
    try {
      const unique = new Map();
      for (const label of JSON.parse(row.labels || '[]')) {
        if (label?.name) unique.set(label.name, label);
      }
      for (const label of unique.values()) {
        labels += `<span class="label-chip" style="background:${escAttr(label.color)}">${esc(label.name)}</span> `;
      }
    } catch {}
    element.querySelector('.icons').innerHTML = labels + icons.join(' ');

    const selectButton = element.querySelector('[data-act=select]');
    selectButton.setAttribute('aria-pressed', bulkSelected ? 'true' : 'false');
    selectButton.title = t(row.is_thread && !row.is_thread_child
      ? 'selection.selectConversation'
      : 'selection.selectMessage');
    selectButton.querySelector('i').className = bulkSelected
      ? 'fa-solid fa-square-check'
      : 'fa-regular fa-square';

    element.querySelector('[data-act=flag] i').className = row.flagged ? 'fa-solid fa-star' : 'fa-regular fa-star';
    element.querySelector('[data-act=seen] i').className = unread ? 'fa-regular fa-envelope-open' : 'fa-solid fa-envelope';
    element.querySelector('[data-act=reply]').title = t('action.reply');
    element.querySelector('[data-act=seen]').title = unread ? t('action.markRead') : t('action.markUnread');
    element.querySelector('[data-act=label]').title = t('action.label');
    const spamButton = element.querySelector('[data-act=spam]');
    spamButton.classList.toggle('hidden', ['sent', 'trash'].includes(row.folder_role));
    spamButton.disabled = Boolean(row.contact_trusted && !row.is_spam);
    spamButton.title = row.contact_trusted && !row.is_spam
      ? t('contacts.trustedCannotSpam')
      : t(row.is_spam ? 'action.notspam' : 'action.spam');
    element.querySelector('[data-act=flag]').title = t('action.flag');
    element.querySelector('[data-act=delete]').title = t(row.folder_role === 'trash' ? 'trash.deletePermanent' : 'trash.move');
  }
}

function rowKey(row) {
  if (row?.is_thread && !row?.is_thread_child) return `thread:${row.thread_key}`;
  return `message:${row?.id}`;
}

function stripReplyPrefixes(subject) {
  return String(subject || '').replace(/^\s*((re|fw|fwd|tr|aw|sv)\s*:\s*)+/gi, '').trim();
}

function dateGroupKey(timestamp) {
  const date = new Date(Number(timestamp));
  const now = new Date();
  if (Number.isNaN(date.getTime())) return 'older';
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startYesterday = new Date(startToday); startYesterday.setDate(startYesterday.getDate() - 1);
  const startWeek = new Date(startToday);
  const day = startWeek.getDay() || 7;
  startWeek.setDate(startWeek.getDate() - day + 1);
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  if (date >= startToday) return 'today';
  if (date >= startYesterday) return 'yesterday';
  if (date >= startWeek) return 'thisWeek';
  if (date >= startMonth) return 'thisMonth';
  return 'older';
}

function fmtDate(timestamp) {
  const date = new Date(Number(timestamp));
  const now = new Date();
  if (Number.isNaN(date.getTime())) return '';
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(I18N.locale, { day: 'numeric', month: 'short' });
  }
  return date.toLocaleDateString(I18N.locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function colorFrom(value) {
  let hue = 0;
  for (const char of String(value || '')) hue = (hue * 31 + char.codePointAt(0)) % 360;
  return `hsl(${hue} 42% 46%)`;
}

function esc(value) {
  return String(value || '').replace(/[&<>"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[char]));
}

function escAttr(value) {
  return String(value || '').replace(/[^#a-zA-Z0-9(),.%\s-]/g, '');
}
