/* LibraMail — lecteur de message et blocage des contenus distants */
'use strict';
(function () {
  const esc = value => String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));

  const REMOTE_ATTRS = new Set(['src', 'href', 'poster', 'background', 'xlink:href']);
  const RESOURCE_TAGS = new Set(['img', 'image', 'source', 'link', 'script', 'iframe', 'embed', 'object', 'audio', 'video']);

  function isRemoteUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
  }

  function remoteDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./i, ''); }
    catch { return ''; }
  }

  function resourceType(tag, attr, url) {
    const lowerTag = String(tag || '').toLowerCase();
    const lowerAttr = String(attr || '').toLowerCase();
    if (lowerAttr === 'href' && lowerTag === 'link') return 'stylesheet';
    if (/\.(css)(?:[?#].*)?$/i.test(url)) return 'stylesheet';
    if (lowerTag === 'img' || lowerTag === 'image' || lowerTag === 'source' || /\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:[?#].*)?$/i.test(url)) return 'image';
    if (lowerAttr === 'style') return 'background';
    return 'resource';
  }

  function trackerInfo(url, element = null) {
    const lower = String(url || '').toLowerCase();
    if (/track|tracking|pixel|beacon|open|read|analytics|utm_|newsletter|mailchimp|sendgrid|brevo|sibforms|mandrill|postmark/.test(lower)) {
      return { suspectedTracker: true, trackerReason: 'address' };
    }
    const width = Number(element?.getAttribute?.('width') || 0);
    const height = Number(element?.getAttribute?.('height') || 0);
    if ((width > 0 && width <= 2) || (height > 0 && height <= 2)) {
      return { suspectedTracker: true, trackerReason: 'dimensions', width, height };
    }
    return { suspectedTracker: false, trackerReason: '', width, height };
  }

  function addResource(map, url, details = {}) {
    if (!isRemoteUrl(url)) return;
    const normalized = String(url).trim();
    const current = map.get(normalized) || {
      url: normalized,
      domain: remoteDomain(normalized),
      label: '',
      type: 'resource',
      occurrences: 0,
      suspectedTracker: false,
      trackerReason: '',
      width: 0,
      height: 0,
    };
    current.occurrences += 1;
    current.type = details.type || current.type;
    current.label = details.label || current.label || current.domain || normalized;
    if (details.suspectedTracker) current.suspectedTracker = true;
    if (details.trackerReason) current.trackerReason = details.trackerReason;
    if (details.width) current.width = details.width;
    if (details.height) current.height = details.height;
    map.set(normalized, current);
  }

  function urlsFromSrcset(value) {
    return String(value || '').split(',')
      .map(part => part.trim().split(/\s+/)[0])
      .filter(isRemoteUrl);
  }

  function styleUrls(value) {
    const urls = [];
    const regex = /url\(\s*(['"]?)(https?:\/\/[^)'"\s]+)\1\s*\)/gi;
    let match;
    while ((match = regex.exec(String(value || '')))) urls.push(match[2]);
    return urls;
  }

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
      const template = document.createElement('template');
      template.innerHTML = String(html || '');

      template.content.querySelectorAll('*').forEach(element => {
        const tag = element.tagName.toLowerCase();
        for (const attr of [...element.attributes]) {
          const name = attr.name.toLowerCase();
          const value = attr.value || '';
          if (REMOTE_ATTRS.has(name) && isRemoteUrl(value)) {
            const info = trackerInfo(value, element);
            addResource(map, value, { ...info, type: resourceType(tag, name, value), label: element.getAttribute('alt') || element.getAttribute('title') || '' });
          }
          if (name === 'srcset') {
            for (const url of urlsFromSrcset(value)) {
              const info = trackerInfo(url, element);
              addResource(map, url, { ...info, type: 'image', label: element.getAttribute('alt') || '' });
            }
          }
          if (name === 'style') {
            for (const url of styleUrls(value)) {
              const info = trackerInfo(url, element);
              addResource(map, url, { ...info, type: 'background' });
            }
          }
        }
      });

      for (const match of String(html || '').matchAll(/https?:\/\/[^\s"'<>)]*/gi)) {
        const url = match[0].replace(/[.,;:!?]+$/, '');
        if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|css)(?:[?#].*)?$/i.test(url) || /track|pixel|beacon|open/i.test(url)) {
          addResource(map, url, { ...trackerInfo(url), type: resourceType('', '', url) });
        }
      }

      return [...map.values()].sort((a, b) => String(a.domain).localeCompare(String(b.domain)) || String(a.url).localeCompare(String(b.url)));
    },

    render() {
      const frame = document.getElementById('mail-frame');
      const banner = document.getElementById('remote-banner');
      const count = document.getElementById('remote-count');
      if (!frame) return;
      const message = this.current;
      if (!message) {
        frame.srcdoc = '';
        banner?.classList.remove('visible');
        return;
      }

      const html = this.mode === 'text' || !message.html
        ? `<pre style="white-space:pre-wrap;font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;margin:0">${esc(message.text || message.meta?.snippet || '')}</pre>`
        : this.prepareHtml(message.html);

      const safeHtml = window.DOMPurify?.sanitize ? window.DOMPurify.sanitize(html) : html;
      frame.classList.toggle('textmode', this.mode === 'text' || !message.html);
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
        body{margin:0;padding:16px;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#111;background:#fff;overflow-wrap:anywhere}
        img{max-width:100%;height:auto} a{color:#2563eb} blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:12px;color:#555}
        pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      </style></head><body>${safeHtml}</body></html>`;

      const blocked = this.remoteResources.filter(item => !this.allowedRemote.has(item.url));
      if (count) count.textContent = String(blocked.length);
      if (banner) banner.classList.toggle('visible', blocked.length > 0);
    },

    prepareHtml(html) {
      const blockRemote = window.App?.config?.blockRemoteImages !== false;
      if (!blockRemote) return String(html || '');

      const template = document.createElement('template');
      template.innerHTML = String(html || '');
      template.content.querySelectorAll('*').forEach(element => {
        for (const attr of [...element.attributes]) {
          const name = attr.name.toLowerCase();
          const value = attr.value || '';
          if (REMOTE_ATTRS.has(name) && isRemoteUrl(value) && !this.allowedRemote.has(value)) {
            element.setAttribute(`data-libramail-remote-${name.replace(':', '-')}`, value);
            element.removeAttribute(attr.name);
          }
          if (name === 'srcset') {
            const urls = urlsFromSrcset(value);
            if (urls.some(url => !this.allowedRemote.has(url))) {
              element.setAttribute('data-libramail-remote-srcset', value);
              element.removeAttribute(attr.name);
            }
          }
          if (name === 'style') {
            const urls = styleUrls(value);
            if (urls.some(url => !this.allowedRemote.has(url))) {
              let nextStyle = value;
              for (const url of urls) {
                if (!this.allowedRemote.has(url)) nextStyle = nextStyle.replaceAll(url, '');
              }
              element.setAttribute('style', nextStyle);
            }
          }
        }
      });
      return template.innerHTML;
    },
  };

  window.Viewer = Viewer;
})();
