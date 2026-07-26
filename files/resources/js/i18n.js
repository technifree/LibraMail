/* LibraMail — i18n
 * Fichiers JSON dans /locales. Ajout d'une langue = un fichier de plus.
 * Usage HTML : <span data-i18n="clé"></span> ou data-i18n-ph pour un placeholder.
 * Usage JS  : t('clé', { var: valeur })
 */
'use strict';
const I18N = (() => {
  let dict = {};
  let locale = 'fr';

  async function load(loc) {
    locale = loc;
    const res = await fetch(`locales/${loc}.json`);
    dict = await res.json();
    apply();
    document.documentElement.lang = loc;
  }

  function t(key, vars) {
    let s = dict[key] || key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
    return s;
  }

  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  }

  return { load, t, apply, get locale() { return locale; } };
})();
const t = (k, v) => I18N.t(k, v);
