/* LibraMail — internationalisation légère */
'use strict';
(function () {
  const DEFAULT_LOCALE = 'fr';
  const FALLBACK_MESSAGES = {
    'status.connected': 'Moteur connecté',
    'status.disconnected': 'Moteur déconnecté — démarrage…',
    'status.ready': 'Prêt',
    'error': 'Erreur',
    'group.today': 'Aujourd’hui',
    'group.yesterday': 'Hier',
    'group.thisWeek': 'Cette semaine',
    'group.thisMonth': 'Ce mois-ci',
    'group.older': 'Plus ancien',
    'group.week': 'Cette semaine',
    'group.month': 'Ce mois-ci',
    'mail.noSubject': '(sans objet)',
    'mail.unknownSender': 'Expéditeur inconnu',
    'mail.unknownRecipient': 'Destinataire inconnu',
    'remote.blocked': 'Les images et contenus distants ont été bloqués pour protéger votre vie privée.',
    'remote.inspect': 'Voir les détails',
    'remote.none': 'Aucun contenu distant bloqué pour ce message.',
    'selection.select': 'Sélectionner',
  };
  const ALIASES = {
    'group.week': 'group.thisWeek',
    'group.month': 'group.thisMonth',
  };

  const I18N = {
    locale: '',
    messages: {},
    loading: null,

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
        if (!Object.keys(messages).length) console.warn('[LibraMail] Traductions indisponibles :', error);
      }
      this.locale = requested;
      this.messages = { ...FALLBACK_MESSAGES, ...(messages || {}) };
      // Compatibilité avec des clés utilisées par certaines anciennes vues.
      for (const [alias, target] of Object.entries(ALIASES)) {
        if (!this.messages[alias] && this.messages[target]) this.messages[alias] = this.messages[target];
      }
      this.apply(document);
      return this.messages;
    },

    translate(key, variables = {}) {
      const target = ALIASES[key] || key;
      const raw = this.messages?.[key] ?? this.messages?.[target] ?? FALLBACK_MESSAGES[key] ?? FALLBACK_MESSAGES[target] ?? key;
      return String(raw).replace(/\{([\w.-]+)\}/g, (match, name) => {
        return Object.prototype.hasOwnProperty.call(variables || {}, name) ? String(variables[name]) : match;
      });
    },

    apply(root = document) {
      const scope = root || document;
      scope.querySelectorAll?.('[data-i18n]').forEach(element => {
        element.textContent = this.translate(element.dataset.i18n);
      });
      scope.querySelectorAll?.('[data-i18n-title]').forEach(element => {
        const label = this.translate(element.dataset.i18nTitle);
        element.setAttribute('title', label);
        element.setAttribute('aria-label', label);
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
    I18N.loading = I18N.load(browserLocale).catch(error => console.warn('[LibraMail] Chargement langue :', error));
  });
})();
