/* LibraMail 0.2.24 — lecteur de message, contenus distants et liens sécurisés */
'use strict';
(function () {
  const esc = value => String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));

  const REMOTE_ATTRS = new Set(['src', 'href', 'poster', 'background', 'xlink:href']);
  function isRemoteUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
  }
  function isSafeInteractiveUrl(value) {
    return /^(?:https?:\/\/|mailto:)/i.test(String(value || '').trim());
  }
  function remoteDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./i, ''); }
    catch { return ''; }
  }
  function resourceType(tag, attr, url) {
    const lowerTag = String(tag || '').toLowerCase();
    const lowerAttr = String(attr || '').toLowerCase();
    if (lowerTag === 'a' && lowerAttr === 'href') return 'link';
    if (lowerAttr === 'href' && lowerTag === 'link') return 'stylesheet';
    if (/\.(css)(?:[?#].*)?$/i.test(url)) return 'stylesheet';
    if (lowerTag === 'img' || lowerTag === 'image' || lowerTag === 'source'
        || /\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:[?#].*)?$/i.test(url)) return 'image';
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



  // LibraMail 0.2.24 UI v21 — liens externes neutralisés dans le lecteur
  function messageAppApi() {
    try {
      if (typeof App !== 'undefined') return App;
    } catch {}
    return window.App || null;
  }

  function normalizeMessageExternalUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : '';
    } catch {
      return '';
    }
  }

  // LibraMail 0.2.24 UI v23 — pont de liens isolé dans l'iframe sandboxée.
  // Dans WebKitGTK, href="#" hérite de l'URL de l'application et rechargeait
  // LibraMail à l'intérieur de LibraMail quand l'interception échouait.
  function neutralizeMessageLinks(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    template.content.querySelectorAll('script, iframe, object, embed, applet, base, meta[http-equiv]').forEach(node => node.remove());
    template.content.querySelectorAll('*').forEach(element => {
      for (const attr of [...element.attributes]) {
        if (/^on/i.test(attr.name)) element.removeAttribute(attr.name);
      }
    });
    template.content.querySelectorAll('a, area').forEach(link => {
      const sourceUrl = link.getAttribute('data-libramail-link')
        || link.getAttribute('data-libramail-external-url')
        || link.getAttribute('href')
        || '';
      const url = normalizeMessageExternalUrl(sourceUrl);
      link.removeAttribute('href');
      link.removeAttribute('target');
      link.removeAttribute('download');
      link.removeAttribute('ping');
      link.setAttribute('rel', 'noopener noreferrer');
      if (url) {
        link.setAttribute('data-libramail-link', url);
        link.setAttribute('role', 'link');
        if (link.tagName.toLowerCase() === 'a') link.setAttribute('tabindex', '0');
        link.removeAttribute('aria-disabled');
      } else {
        link.removeAttribute('data-libramail-link');
        link.setAttribute('aria-disabled', 'true');
        link.removeAttribute('tabindex');
      }
      link.removeAttribute('data-libramail-external-url');
    });
    template.content.querySelectorAll('form').forEach(form => {
      form.removeAttribute('action');
      form.removeAttribute('method');
      form.setAttribute('data-libramail-disabled-form', '1');
    });
    return template.innerHTML;
  }

  const Viewer = {
    current: null,
    mode: 'html',
    remoteResources: [],
    allowedRemote: new Set(),

    show(message) {
      this.current = message || null;
      this.mode = message?.html ? 'html' : 'text';
      this.allowedRemote = new Set(
        Array.isArray(message?.remoteAllowedUrls)
          ? message.remoteAllowedUrls.map(url => String(url || '').trim()).filter(Boolean)
          : []
      );
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
      return this.remoteResources.map(item => {
        const allowed = this.allowedRemote.has(item.url);
        return { ...item, allowed, loaded: allowed };
      });
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
            addResource(map, value, {
              ...info,
              type: resourceType(tag, name, value),
              label: element.getAttribute('alt')
                || element.getAttribute('title')
                || (tag === 'a' ? element.textContent.trim() : ''),
            });
          }
          if (name === 'srcset') {
            for (const url of urlsFromSrcset(value)) {
              const info = trackerInfo(url, element);
              addResource(map, url, {
                ...info,
                type: 'image',
                label: element.getAttribute('alt') || '',
              });
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
        if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|css)(?:[?#].*)?$/i.test(url)
            || /track|pixel|beacon|open/i.test(url)) {
          addResource(map, url, { ...trackerInfo(url), type: resourceType('', '', url) });
        }
      }
      return [...map.values()].sort((a, b) =>
        String(a.domain).localeCompare(String(b.domain))
        || String(a.url).localeCompare(String(b.url)));
    },

    render() {
      const frame = document.getElementById('mail-frame');
      const banner = document.getElementById('remote-banner');
      const count = document.getElementById('remote-count');
      if (!frame) return;
      const message = this.current;
      if (!message) {
        frame.onload = null;
        frame.srcdoc = '';
        banner?.classList.remove('visible');
        return;
      }
      const html = this.mode === 'text' || !message.html
        ? `<pre style="white-space:pre-wrap;font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;margin:0">${esc(message.text || message.meta?.snippet || '')}</pre>`
        : this.prepareHtml(message.html);
      const safeHtml = window.DOMPurify?.sanitize ? window.DOMPurify.sanitize(html) : html;
      frame.classList.toggle('textmode', this.mode === 'text' || !message.html);
      frame.onload = null;
      const bridgedHtml = neutralizeMessageLinks(safeHtml);
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{margin:0;padding:16px;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#111;background:#fff;overflow-wrap:anywhere}
        img{max-width:100%;height:auto}
        a[data-libramail-link]{color:#2563eb;cursor:pointer;text-decoration:underline}
        a[data-libramail-blocked="1"],a[aria-disabled="true"],area[aria-disabled="true"]{cursor:not-allowed;opacity:.72}
        blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:12px;color:#555}
        pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      </style></head><body>${bridgedHtml}<script>
        (function () {
          'use strict';
          var SOURCE = 'libramail-mail-frame-v23';
          function findLink(node) {
            if (node && node.nodeType !== 1) node = node.parentElement;
            while (node && node !== document.documentElement) {
              if (node.matches && node.matches('a[data-libramail-link], area[data-libramail-link], a[aria-disabled="true"], area[aria-disabled="true"]')) return node;
              node = node.parentElement;
            }
            return null;
          }
          function payload(link) {
            return {
              source: SOURCE,
              url: link ? String(link.getAttribute('data-libramail-link') || '') : '',
              blocked: link ? link.getAttribute('data-libramail-blocked') === '1' : false,
              disabled: link ? link.getAttribute('aria-disabled') === 'true' : true,
              displayText: link ? String(link.textContent || link.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 500) : ''
            };
          }
          function cancel(event) {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
          }
          function activate(event) {
            var link = findLink(event.target);
            if (!link) return;
            cancel(event);
            var data = payload(link);
            data.type = data.disabled || !data.url ? 'invalid-link' : (data.blocked ? 'blocked-link' : 'open-link');
            parent.postMessage(data, '*');
          }
          document.addEventListener('click', activate, true);
          document.addEventListener('auxclick', activate, true);
          document.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (findLink(event.target)) activate(event);
          }, true);
          document.addEventListener('mouseover', function (event) {
            var link = findLink(event.target);
            if (!link) return;
            var data = payload(link);
            if (!data.url) return;
            data.type = 'preview-link';
            parent.postMessage(data, '*');
          }, true);
          document.addEventListener('mouseout', function (event) {
            var link = findLink(event.target);
            if (!link) return;
            var next = findLink(event.relatedTarget);
            if (next !== link) parent.postMessage({ source: SOURCE, type: 'clear-link' }, '*');
          }, true);
          document.addEventListener('submit', function (event) { cancel(event); }, true);
        })();
      <\/script></body></html>`;
      const blocked = this.remoteResources.filter(item => !this.allowedRemote.has(item.url));
      if (count) count.textContent = String(blocked.length);
      if (banner) banner.classList.toggle('visible', blocked.length > 0);
    },

    prepareHtml(html) {
      const blockRemote = messageAppApi()?.config?.blockRemoteImages !== false;
      const template = document.createElement('template');
      template.innerHTML = String(html || '');
      template.content.querySelectorAll('*').forEach(element => {
        const tag = element.tagName.toLowerCase();

        if (tag === 'a') {
          const href = String(element.getAttribute('href') || '').trim();
          if (isSafeInteractiveUrl(href)) {
            const remote = isRemoteUrl(href);
            const allowed = !remote || !blockRemote || this.allowedRemote.has(href);
            element.setAttribute('data-libramail-link', href);
            element.setAttribute('data-libramail-blocked', allowed ? '0' : '1');
            element.removeAttribute('href');
            element.removeAttribute('target');
            element.removeAttribute('rel');
            element.classList.add(allowed ? 'libramail-link-enabled' : 'libramail-link-blocked');
            if (!allowed) element.setAttribute('aria-disabled', 'true');
          } else {
            element.removeAttribute('href');
          }
        }

        for (const attr of [...element.attributes]) {
          const name = attr.name.toLowerCase();
          const value = attr.value || '';
          if (tag === 'a' && (name === 'href' || name.startsWith('data-libramail-'))) continue;
          if (REMOTE_ATTRS.has(name) && isRemoteUrl(value) && blockRemote && !this.allowedRemote.has(value)) {
            element.setAttribute(`data-libramail-remote-${name.replace(':', '-')}`, value);
            element.removeAttribute(attr.name);
          }
          if (name === 'srcset') {
            const urls = urlsFromSrcset(value);
            if (blockRemote && urls.some(url => !this.allowedRemote.has(url))) {
              element.setAttribute('data-libramail-remote-srcset', value);
              element.removeAttribute(attr.name);
            }
          }
          if (name === 'style') {
            const urls = styleUrls(value);
            if (blockRemote && urls.some(url => !this.allowedRemote.has(url))) {
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


  // LibraMail 0.2.24 UI v23 — réception sécurisée des clics de l'iframe.
  window.addEventListener('message', event => {
    const frame = document.getElementById('mail-frame');
    const data = event.data;
    if (!frame || event.source !== frame.contentWindow) return;
    if (!data || data.source !== 'libramail-mail-frame-v23') return;

    const api = messageAppApi();
    if (!api) return;
    const url = normalizeMessageExternalUrl(data.url || '');
    if (data.type === 'preview-link') {
      if (url) api.previewExternalTarget?.(url);
      return;
    }
    if (data.type === 'clear-link') {
      api.clearExternalTarget?.();
      return;
    }
    if (data.type === 'blocked-link') {
      api.status?.(
        typeof window.t === 'function' ? window.t('remote.linkStillBlocked') : 'Ce lien reste bloqué tant qu’il n’est pas autorisé.',
        'error',
      );
      return;
    }
    if (data.type === 'invalid-link' || !url) {
      api.status?.(
        typeof window.t === 'function' ? window.t('link.blockedInvalid') : 'Lien invalide ou bloqué.',
        'error',
      );
      return;
    }
    if (data.type === 'open-link') {
      api.openExternal?.(url, { displayText: String(data.displayText || '') });
    }
  });

  window.Viewer = Viewer;
})();
