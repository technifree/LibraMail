/* LibraMail — Lecteur sécurisé
 * Les contenus distants restent bloqués tant que l'utilisateur n'a pas choisi
 * précisément les ressources à charger. La liste détaillée est exposée à App
 * pour affichage dans une fenêtre intégrée, sans confirm() natif.
 */
'use strict';
const Viewer = (() => {
  let current = null;
  let mode = 'html';
  let remoteResources = [];
  let allowedRemoteUrls = new Set();
  const VIEWER_NONCE = 'libramail-viewer';

  function htmlEscape(value) {
    return String(value ?? '').replace(/[&<>\"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function attrEscape(value) {
    return htmlEscape(value).replace(/`/g, '&#96;');
  }


  const frame = () => document.getElementById('mail-frame');
  const banner = () => document.getElementById('remote-banner');

  function normalizedRemoteUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      return /^https?:$/i.test(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  }

  function resourceDomain(url) {
    try { return new URL(url).hostname || url; }
    catch { return url; }
  }

  function resourceOrigin(url) {
    try { return new URL(url).origin; }
    catch { return ''; }
  }

  function filenameFromUrl(url) {
    try {
      const pathname = decodeURIComponent(new URL(url).pathname || '');
      const name = pathname.split('/').filter(Boolean).pop();
      return name || resourceDomain(url);
    } catch {
      return resourceDomain(url);
    }
  }

  function trackerReason(url, width, height) {
    const dimensions = [Number(width) || 0, Number(height) || 0];
    if (dimensions[0] > 0 && dimensions[1] > 0 && dimensions[0] <= 2 && dimensions[1] <= 2) {
      return 'dimensions';
    }
    const value = String(url || '').toLowerCase();
    if (/(?:^|[\/_?&=.-])(pixel|beacon|track(?:er|ing)?|open(?:ed)?|spy|webbug|1x1)(?:[\/_?&=.-]|$)/i.test(value)) {
      return 'address';
    }
    return '';
  }

  function addResource(resources, details) {
    const url = normalizedRemoteUrl(details.url);
    if (!url) return null;

    const type = details.type || 'image';
    const key = `${type}\u0000${url}`;
    let resource = resources.find(item => item.key === key);
    if (resource) {
      resource.occurrences += 1;
      if (!resource.trackerReason) {
        resource.trackerReason = trackerReason(url, details.width, details.height);
        resource.suspectedTracker = Boolean(resource.trackerReason);
      }
      return resource;
    }

    const reason = trackerReason(url, details.width, details.height);
    resource = {
      id: `lm-remote-${resources.length + 1}`,
      key,
      type,
      url,
      domain: resourceDomain(url),
      origin: resourceOrigin(url),
      label: details.label || filenameFromUrl(url),
      width: Number(details.width) || 0,
      height: Number(details.height) || 0,
      occurrences: 1,
      trackerReason: reason,
      suspectedTracker: Boolean(reason),
    };
    resources.push(resource);
    return resource;
  }

  function replaceCssRemoteUrls(cssText, resources, type, label) {
    const source = String(cssText || '');
    const ids = [];
    const template = source.replace(/url\(\s*(['"]?)(https?:\/\/[^)]*?)\1\s*\)/gi,
      (whole, quote, rawUrl) => {
        const resource = addResource(resources, {
          type,
          url: String(rawUrl || '').trim().replace(/^['"]|['"]$/g, ''),
          label,
        });
        if (!resource) return 'none';
        ids.push(resource.id);
        return `url("__LM_REMOTE_${resource.id}__")`;
      });
    return { template, ids };
  }

  function csp(allowedUrls) {
    const origins = [...new Set([...allowedUrls].map(resourceOrigin).filter(Boolean))];
    const imageSources = ['data:', 'cid:', ...origins].join(' ');
    const fontSources = ['data:', ...origins].join(' ');
    return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; font-src ${fontSources}; script-src 'nonce-${VIEWER_NONCE}'; media-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'">`
      + '<meta name="referrer" content="no-referrer">';
  }

  function sanitize(html) {
    const clean = DOMPurify.sanitize(html, {
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'video', 'audio', 'meta', 'link', 'base'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'srcset', 'ping', 'formaction'],
      WHOLE_DOCUMENT: false,
    });
    const doc = new DOMParser().parseFromString(clean, 'text/html');
    const resources = [];

    // Images HTML distantes, pixels espions compris.
    doc.querySelectorAll('img[src]').forEach(image => {
      const src = image.getAttribute('src') || '';
      const resource = addResource(resources, {
        type: 'image',
        url: src,
        label: image.getAttribute('alt')?.trim() || filenameFromUrl(src),
        width: image.getAttribute('width') || image.width,
        height: image.getAttribute('height') || image.height,
      });
      if (!resource) return;
      image.setAttribute('data-lm-remote-id', resource.id);
      image.setAttribute('data-lm-src', resource.url);
      image.removeAttribute('src');
      image.style.background = '#e8e8e8';
      image.style.minWidth = image.style.minWidth || '20px';
      image.style.minHeight = image.style.minHeight || '12px';
    });

    // Ancien attribut HTML background, encore fréquent dans les newsletters.
    doc.querySelectorAll('[background]').forEach(element => {
      const value = element.getAttribute('background') || '';
      const resource = addResource(resources, {
        type: 'background', url: value, label: filenameFromUrl(value),
      });
      if (!resource) return;
      element.setAttribute('data-lm-background-id', resource.id);
      element.removeAttribute('background');
    });

    // URL distantes dans les styles en ligne.
    doc.querySelectorAll('[style]').forEach(element => {
      const style = element.getAttribute('style') || '';
      const result = replaceCssRemoteUrls(style, resources, 'background', element.getAttribute('title') || 'CSS');
      if (!result.ids.length) return;
      element.setAttribute('data-lm-style-template', result.template);
      element.setAttribute('style', style.replace(/url\(\s*(['"]?)https?:\/\/[^)]*?\1\s*\)/gi, 'none'));
    });

    // URL distantes dans les blocs <style> intégrés au message.
    doc.querySelectorAll('style').forEach(styleElement => {
      const css = styleElement.textContent || '';
      const result = replaceCssRemoteUrls(css, resources, 'stylesheet', 'Feuille de style intégrée');
      if (!result.ids.length) return;
      styleElement.setAttribute('data-lm-style-block-template', result.template);
      styleElement.textContent = css.replace(/url\(\s*(['"]?)https?:\/\/[^)]*?\1\s*\)/gi, 'none');
    });

    // Liens : aucune navigation dans l'iframe. Le clic et le survol sont
    // relayés au parent par un petit pont contrôlé injecté après nettoyage.
    // Certains fournisseurs conservent l'adresse dans data-saferedirecturl ou
    // data-original-href : on les prend aussi en charge.
    doc.querySelectorAll('a').forEach(anchor => {
      const href = anchor.getAttribute('href')
        || anchor.getAttribute('data-original-href')
        || anchor.getAttribute('data-saferedirecturl')
        || '';
      if (!href) return;
      anchor.setAttribute('data-lm-href', href);
      anchor.removeAttribute('href');
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
      anchor.setAttribute('role', 'link');
      anchor.setAttribute('tabindex', '0');
      anchor.setAttribute('aria-label', anchor.getAttribute('aria-label') || href);
      anchor.setAttribute('title', anchor.getAttribute('title') || href);
      anchor.style.setProperty('cursor', 'pointer', 'important');
      anchor.style.setProperty('pointer-events', 'auto', 'important');
      const text = anchor.textContent.trim();
      if (/^https?:/i.test(text)) {
        try {
          const shown = new URL(text).hostname.replace(/^www\./, '');
          const real = new URL(href, 'https://x').hostname.replace(/^www\./, '');
          if (shown && real && shown !== real) {
            anchor.style.setProperty('outline', '2px solid var(--danger, #e5636b)', 'important');
            anchor.title = `⚠ ${shown} → ${real}`;
          }
        } catch {}
      }
    });

    return { html: doc.body.innerHTML, resources };
  }

  function baseStyle() {
    return `<style>
      body { font-family: system-ui, sans-serif; font-size: 14px; margin: 14px;
             color: #1c1e26; word-wrap: break-word; }
      img { max-width: 100%; height: auto; }
      pre, .plain { white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 13px; }
      blockquote { border-left: 3px solid #c9a24d; margin: 8px 0; padding: 2px 12px; color: #555; }
      a[data-lm-href], a[data-lm-href] * {
        pointer-events: auto !important;
        cursor: pointer !important;
      }
      a[data-lm-href] {
        color: #245fa8 !important;
        text-decoration: underline !important;
        text-underline-offset: 2px !important;
      }
      a[data-lm-href]:hover { color: #17477f !important; }
      a[data-lm-href]:focus { outline: 2px solid #c9a24d !important; outline-offset: 2px; border-radius: 2px; }
    </style>`;
  }

  function cssUrl(url) {
    return String(url || '').replace(/["\\\n\r]/g, value => `\\${value}`);
  }

  function restoreCssTemplate(template, resourceById, allowedUrls) {
    return String(template || '').replace(/url\("__LM_REMOTE_(lm-remote-\d+)__"\)/g, (whole, id) => {
      const resource = resourceById.get(id);
      return resource && allowedUrls.has(resource.url) ? `url("${cssUrl(resource.url)}")` : 'none';
    });
  }

  function materializeBodyHtml(bodyHtml, resources, allowedUrls) {
    const doc = new DOMParser().parseFromString(`<body>${bodyHtml}</body>`, 'text/html');
    const resourceById = new Map(resources.map(resource => [resource.id, resource]));

    doc.querySelectorAll('img[data-lm-src]').forEach(image => {
      const source = image.getAttribute('data-lm-src') || '';
      if (allowedUrls.has(source)) image.setAttribute('src', source);
      else image.removeAttribute('src');
    });

    doc.querySelectorAll('[data-lm-background-id]').forEach(element => {
      const resource = resourceById.get(element.getAttribute('data-lm-background-id'));
      if (resource && allowedUrls.has(resource.url)) element.setAttribute('background', resource.url);
      else element.removeAttribute('background');
    });

    doc.querySelectorAll('[data-lm-style-template]').forEach(element => {
      element.setAttribute('style', restoreCssTemplate(
        element.getAttribute('data-lm-style-template'), resourceById, allowedUrls));
    });

    doc.querySelectorAll('style[data-lm-style-block-template]').forEach(styleElement => {
      styleElement.textContent = restoreCssTemplate(
        styleElement.getAttribute('data-lm-style-block-template'), resourceById, allowedUrls);
    });

    return doc.body.innerHTML;
  }

  function linkBridgeScript() {
    return `<script nonce="${VIEWER_NONCE}">(function(){
      'use strict';
      var current = null;
      function closestLink(target) {
        if (!target || target.nodeType !== 1 || typeof target.closest !== 'function') return null;
        return target.closest('[data-lm-href]');
      }
      function hrefOf(anchor) { return anchor ? (anchor.getAttribute('data-lm-href') || '') : ''; }
      function textOf(anchor) { return anchor ? String(anchor.innerText || anchor.textContent || '').trim() : ''; }
      function send(type, anchor) {
        window.parent.postMessage({
          source: 'libramail-viewer',
          type: type,
          url: hrefOf(anchor),
          displayText: textOf(anchor)
        }, '*');
      }
      document.addEventListener('mouseover', function(event) {
        var anchor = closestLink(event.target);
        if (!anchor || anchor === current) return;
        current = anchor;
        send('link-hover', anchor);
      }, true);
      document.addEventListener('mouseout', function(event) {
        var anchor = closestLink(event.target);
        if (!anchor) return;
        var next = closestLink(event.relatedTarget);
        if (next === anchor) return;
        current = next || null;
        if (next) send('link-hover', next); else send('link-leave', anchor);
      }, true);
      document.addEventListener('focusin', function(event) {
        var anchor = closestLink(event.target);
        if (anchor) send('link-hover', anchor);
      }, true);
      document.addEventListener('focusout', function(event) {
        if (closestLink(event.target)) send('link-leave', null);
      }, true);
      document.addEventListener('click', function(event) {
        var anchor = closestLink(event.target);
        if (!anchor) return;
        event.preventDefault();
        event.stopPropagation();
        send('link-open', anchor);
      }, true);
      document.addEventListener('keydown', function(event) {
        var anchor = closestLink(event.target);
        if (!anchor || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        event.stopPropagation();
        send('link-open', anchor);
      }, true);
      window.addEventListener('blur', function() { send('link-leave', null); });
    })();<\/script>`;
  }

  function renderFrame(bodyHtml, resources, allowedUrls) {
    const mailFrame = frame();
    const renderedBody = materializeBodyHtml(bodyHtml, resources, allowedUrls);
    const sourceDocument = `<!doctype html><html><head>${csp(allowedUrls)}${baseStyle()}</head><body>${renderedBody}${linkBridgeScript()}</body></html>`;
    mailFrame.srcdoc = sourceDocument;
  }

  function linkifyPlainText(value) {
    const source = String(value || '');
    const expression = /(?:https?:\/\/|www\.)[^\s<>"']+|mailto:[^\s<>"']+/gi;
    let output = '';
    let cursor = 0;
    let match;
    while ((match = expression.exec(source))) {
      output += htmlEscape(source.slice(cursor, match.index));
      let visible = match[0];
      let suffix = '';
      const trailing = visible.match(/[),.;!?]+$/);
      if (trailing) {
        suffix = trailing[0];
        visible = visible.slice(0, -suffix.length);
      }
      const href = /^www\./i.test(visible) ? `https://${visible}` : visible;
      output += `<a data-lm-href="${attrEscape(href)}" role="link" tabindex="0" title="${attrEscape(href)}">${htmlEscape(visible)}</a>${htmlEscape(suffix)}`;
      cursor = match.index + match[0].length;
    }
    output += htmlEscape(source.slice(cursor));
    return output;
  }

  function show(message) {
    App.clearExternalTarget();
    current = message;
    mode = 'html';
    remoteResources = [];
    allowedRemoteUrls = new Set();
    render();
  }

  function render() {
    App.clearExternalTarget();
    if (!current) return;
    const mailFrame = frame();
    banner().classList.remove('visible');

    if (mode === 'text' || !current.html) {
      remoteResources = [];
      mailFrame.classList.add('textmode');
      renderFrame(`<div class="plain">${linkifyPlainText(current.text || '')}</div>`, [], new Set());
      return;
    }

    mailFrame.classList.remove('textmode');
    const sanitized = sanitize(current.html);
    remoteResources = sanitized.resources;

    // Lorsque le blocage est désactivé dans les paramètres, toutes les ressources
    // sont chargées. L'ancien lecteur les neutralisait malgré ce réglage.
    const effectiveAllowed = App.config.blockRemoteImages === false
      ? new Set(remoteResources.map(resource => resource.url))
      : new Set([...allowedRemoteUrls]);

    const blocked = remoteResources.filter(resource => !effectiveAllowed.has(resource.url));
    if (blocked.length > 0 && App.config.blockRemoteImages !== false) {
      banner().classList.add('visible');
      document.getElementById('remote-count').textContent = blocked
        .reduce((sum, resource) => sum + resource.occurrences, 0);
    }

    renderFrame(sanitized.html, remoteResources, effectiveAllowed);
  }

  function allowRemote(urls) {
    for (const value of urls || []) {
      const url = normalizedRemoteUrl(value);
      if (url) allowedRemoteUrls.add(url);
    }
    render();
  }

  function allowAllRemote() {
    allowRemote(remoteResources.map(resource => resource.url));
  }

  function getRemoteResources() {
    return remoteResources.map(resource => ({
      ...resource,
      allowed: App.config.blockRemoteImages === false || allowedRemoteUrls.has(resource.url),
    }));
  }

  function toggleMode() {
    mode = mode === 'html' ? 'text' : 'html';
    render();
    return mode;
  }

  window.addEventListener('message', event => {
    const mailFrame = frame();
    if (!mailFrame || event.source !== mailFrame.contentWindow) return;
    const payload = event.data;
    if (!payload || payload.source !== 'libramail-viewer') return;
    if (payload.type === 'link-hover') {
      App.previewExternalTarget(payload.url || '');
      return;
    }
    if (payload.type === 'link-leave') {
      App.clearExternalTarget();
      return;
    }
    if (payload.type === 'link-open') {
      App.openExternal(payload.url || '', { displayText: payload.displayText || '' });
    }
  });

  return {
    show,
    allowRemote,
    allowAllRemote,
    getRemoteResources,
    toggleMode,
    get current() { return current; },
  };
})();
