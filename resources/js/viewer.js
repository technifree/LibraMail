/* LibraMail — lecteur de message */
'use strict';
(function () {
  const REMOTE_URL_RE = /\b(?:src|href)\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi;
  const esc = value => String(value || '').replace(/[&<>"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[character]));

  const Viewer = {
    current: null,
    mode: 'html',
    remoteResources: [],
    allowedRemote: new Set(),

    show(message) {
      this.current = message || null;
      this.mode = message?.html ? 'html' : 'text';
      this.allowedRemote = new Set();
      this.remoteResources = this.extractRemoteResources(message?.html || '');
      this.render();
    },

    toggleMode() {
      if (!this.current) return this.mode;
      this.mode = this.mode === 'html' ? 'text' : 'html';
      this.render();
      return this.mode;
    },

    getRemoteResources() {
      return this.remoteResources.map(item => ({ ...item, loaded: this.allowedRemote.has(item.url) }));
    },

    allowRemote(urls = []) {
      for (const url of urls) this.allowedRemote.add(String(url));
      this.render();
    },

    allowAllRemote() {
      for (const resource of this.remoteResources) this.allowedRemote.add(resource.url);
      this.render();
    },

    extractRemoteResources(html) {
      const map = new Map();
      let match;
      while ((match = REMOTE_URL_RE.exec(String(html || '')))) {
        const url = match[2];
        const item = map.get(url) || {
          url,
          occurrences: 0,
          suspectedTracker: false,
          trackerReason: '',
          width: 0,
          height: 0,
        };
        item.occurrences += 1;
        if (/track|pixel|beacon|open/i.test(url)) {
          item.suspectedTracker = true;
          item.trackerReason = 'address';
        }
        map.set(url, item);
      }
      return [...map.values()];
    },

    render() {
      const frame = document.getElementById('mail-frame');
      const banner = document.getElementById('remote-banner');
      const count = document.getElementById('remote-count');
      if (!frame) return;
      const message = this.current;
      if (!message) {
        frame.srcdoc = '';
        banner?.classList.remove('show');
        return;
      }

      const html = this.mode === 'text' || !message.html
        ? `<pre style="white-space:pre-wrap;font:14px/1.55 system-ui, sans-serif;margin:0">${esc(message.text || message.meta?.snippet || '')}</pre>`
        : this.prepareHtml(message.html);

      const safeHtml = window.DOMPurify?.sanitize ? window.DOMPurify.sanitize(html) : html;
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
        body{margin:0;padding:16px;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#111;background:#fff;overflow-wrap:anywhere}
        img{max-width:100%;height:auto} a{color:#2563eb} blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:12px;color:#555}
        pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      </style></head><body>${safeHtml}</body></html>`;

      const blocked = this.remoteResources.filter(item => !this.allowedRemote.has(item.url));
      if (count) count.textContent = String(blocked.length);
      if (banner) banner.classList.toggle('show', blocked.length > 0);
    },

    prepareHtml(html) {
      const blockRemote = window.App?.config?.blockRemoteImages !== false;
      if (!blockRemote) return String(html || '');
      return String(html || '').replace(/\bsrc\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi, (full, quote, url) => {
        if (this.allowedRemote.has(url)) return full;
        return `data-libramail-remote-src=${quote}${esc(url)}${quote}`;
      });
    },
  };

  window.Viewer = Viewer;
})();
