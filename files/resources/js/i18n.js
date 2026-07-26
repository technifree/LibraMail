/* LibraMail — internationalisation légère */
'use strict';
(function () {
  const DEFAULT_LOCALE = 'fr';
  const I18N = {
    locale: '',
    messages: {},
    async load(locale = DEFAULT_LOCALE) {
      const requested = String(locale || DEFAULT_LOCALE).toLowerCase().startsWith('en') ? 'en' : 'fr';
      let messages = {};
      try {
        const response = await fetch(`locales/${requested}.json`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        messages = await response.json();
      } catch (error) {
        if (requested !== DEFAULT_LOCALE) {
          try {
            const fallback = await fetch(`locales/${DEFAULT_LOCALE}.json`, { cache: 'no-store' });
            if (fallback.ok) messages = await fallback.json();
          } catch {}
        }
        if (!Object.keys(messages).length) {
          console.warn('[LibraMail] Traductions indisponibles :', error);
        }
      }
      this.locale = requested;
      this.messages = messages || {};
      this.apply(document);
      return this.messages;
    },
    translate(key, variables = {}) {
      const raw = this.messages?.[key] ?? key;
      return String(raw).replace(/\{([\w.-]+)\}/g, (match, name) => {
        return Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match;
      });
    },
    apply(root = document) {
      const scope = root || document;
      scope.querySelectorAll?.('[data-i18n]').forEach(element => {
        element.textContent = this.translate(element.dataset.i18n);
      });
      scope.querySelectorAll?.('[data-i18n-title]').forEach(element => {
        element.setAttribute('title', this.translate(element.dataset.i18nTitle));
        element.setAttribute('aria-label', this.translate(element.dataset.i18nTitle));
      });
      scope.querySelectorAll?.('[data-i18n-ph]').forEach(element => {
        element.setAttribute('placeholder', this.translate(element.dataset.i18nPh));
      });
    },
  };

  window.I18N = I18N;
  window.t = (key, variables) => I18N.translate(key, variables);

  window.addEventListener('DOMContentLoaded', () => {
    const browserLocale = (navigator.language || DEFAULT_LOCALE).slice(0, 2);
    I18N.load(browserLocale).catch(error => console.warn('[LibraMail] Chargement langue :', error));
  });
})();
