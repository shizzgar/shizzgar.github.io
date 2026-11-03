// Interface localization only. User prompts, generated code and raw model
// output are not translated by this module.
export const SUPPORTED_LANGUAGES = Object.freeze(['ru', 'en']);
export const LANGUAGE_STORAGE_KEY = 'forma.language';

const locales = {ru:'ru-RU', en:'en-US'};
const attributes = {
  title:'title', placeholder:'placeholder', 'aria-label':'aria-label',
  'aria-description':'aria-description', alt:'alt', content:'content', prompt:'data-prompt',
};

function supportedLanguage(value) {
  if (typeof value !== 'string') return null;
  const base = value.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  return SUPPORTED_LANGUAGES.includes(base) ? base : null;
}

/** Respect the browser's preference order, falling back to English. */
export function detectLanguage(languages = []) {
  const choices = typeof languages === 'string' ? [languages] : Array.isArray(languages) ? languages : [];
  for (const value of choices) {
    const language = supportedLanguage(value);
    if (language) return language;
  }
  return 'en';
}

function browserLanguages() {
  try {
    const nav = globalThis.navigator;
    return Array.isArray(nav?.languages) && nav.languages.length ? [...nav.languages] : nav?.language ? [nav.language] : [];
  } catch { return []; }
}
function browserStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** A factory makes storage denial, browser language changes and DOM behavior testable. */
export function createI18n({languages = browserLanguages, storage = browserStorage(), eventTarget = globalThis} = {}) {
  const messages = {ru:Object.create(null), en:Object.create(null)};
  const listeners = new Set();
  const getLanguages = () => {
    try { return typeof languages === 'function' ? languages() : languages; } catch { return []; }
  };
  let preference = 'auto';
  try {
    const saved = storage?.getItem?.(LANGUAGE_STORAGE_KEY);
    if (saved === 'ru' || saved === 'en') preference = saved;
  } catch { /* Browser privacy modes may deny storage. */ }
  let language = preference === 'auto' ? detectLanguage(getLanguages()) : preference;

  function notify(previousLanguage, previousPreference) {
    if (language === previousLanguage && preference === previousPreference) return;
    const detail = Object.freeze({preference, previousPreference});
    for (const fn of [...listeners]) {
      try { fn(language, previousLanguage, detail); } catch { /* A UI subscriber cannot break other subscribers. */ }
    }
  }
  function setLanguage(value, {persist = true} = {}) {
    const nextPreference = value === 'auto' ? 'auto' : supportedLanguage(value);
    if (!nextPreference) throw new RangeError('Unsupported interface language.');
    const previousLanguage = language, previousPreference = preference;
    preference = nextPreference;
    language = preference === 'auto' ? detectLanguage(getLanguages()) : preference;
    if (persist) {
      try {
        if (preference === 'auto') storage?.removeItem?.(LANGUAGE_STORAGE_KEY);
        else storage?.setItem?.(LANGUAGE_STORAGE_KEY, preference);
      } catch { /* The in-memory selection still works when saving is denied. */ }
    }
    notify(previousLanguage, previousPreference);
    return language;
  }
  function onLanguageChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('A language-change listener must be a function.');
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function onBrowserLanguageChange() {
    if (preference !== 'auto') return;
    const previousLanguage = language;
    language = detectLanguage(getLanguages());
    notify(previousLanguage, preference);
  }
  try { eventTarget?.addEventListener?.('languagechange', onBrowserLanguageChange); } catch { /* Optional in non-browser runtimes. */ }

  function registerMessages(source) {
    if (!source || typeof source !== 'object') throw new TypeError('Translation dictionaries are required.');
    for (const lang of SUPPORTED_LANGUAGES) {
      const entries = source[lang];
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value === 'string') messages[lang][key] = value;
      }
    }
  }
  function t(key, variables = {}) {
    const name = String(key ?? '');
    const text = messages[language][name] ?? messages.ru[name] ?? messages.en[name] ?? name;
    return text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, variable) => Object.prototype.hasOwnProperty.call(variables || {}, variable) ? String(variables[variable]) : match);
  }
  function trustedHtml(key, variables = {}) {
    const template = messages[language][key] ?? messages.ru[key] ?? messages.en[key];
    if (template === undefined) return null;
    const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    // Only source-controlled dictionaries may contain markup. Interpolated
    // values are always escaped; prompts, code and model output never go here.
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, variable) => Object.prototype.hasOwnProperty.call(variables || {}, variable) ? escape(variables[variable]) : match);
  }
  function formatNumber(value, options = {}) {
    return new Intl.NumberFormat(locales[language], options).format(value);
  }
  function formatBytes(bytes, {maximumFractionDigits = 1} = {}) {
    const count = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    const units = language === 'ru' ? ['Б','КиБ','МиБ','ГиБ','ТиБ'] : ['B','KiB','MiB','GiB','TiB'];
    const exponent = count > 0 ? Math.max(0, Math.min(units.length - 1, Math.floor(Math.log(count) / Math.log(1024)))) : 0;
    return `${formatNumber(count / 1024 ** exponent, {maximumFractionDigits:exponent ? maximumFractionDigits : 0})} ${units[exponent]}`;
  }
  function formatDateTime(value, options = {}) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locales[language], options).format(date) : '—';
  }
  function applyTranslations(root = globalThis.document) {
    if (!root) return;
    const selectors = ['[data-i18n]', '[data-i18n-html]', ...Object.keys(attributes).map(name => `[data-i18n-${name}]`)];
    const nodes = [];
    if (typeof root.matches === 'function' && root.matches(selectors.join(','))) nodes.push(root);
    if (typeof root.querySelectorAll === 'function') nodes.push(...root.querySelectorAll(selectors.join(',')));
    for (const element of nodes) {
      let variables = {};
      try {
        const parsed = JSON.parse(element.getAttribute('data-i18n-args') || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) variables = parsed;
      } catch { /* A bad optional value does not break the rest of the UI. */ }
      const key = element.getAttribute('data-i18n');
      const htmlKey = element.getAttribute('data-i18n-html');
      if (htmlKey) {
        const html = trustedHtml(htmlKey, variables);
        if (html === null) element.textContent = htmlKey;
        else element.innerHTML = html;
      } else if (key) element.textContent = t(key, variables);
      for (const [name, attribute] of Object.entries(attributes)) {
        const attributeKey = element.getAttribute(`data-i18n-${name}`);
        if (attributeKey) element.setAttribute(attribute, t(attributeKey, variables));
      }
    }
    const doc = root.documentElement ? root : root.ownerDocument;
    if (doc?.documentElement) doc.documentElement.lang = language;
  }
  function destroy() {
    listeners.clear();
    try { eventTarget?.removeEventListener?.('languagechange', onBrowserLanguageChange); } catch { /* Optional. */ }
  }
  return {
    getLanguage:() => language,
    getLocale:() => locales[language],
    getLanguagePreference:() => preference,
    getLanguageMode:() => preference,
    setLanguage, onLanguageChange, registerMessages, t, formatNumber,
    formatBytes, formatDateTime, applyTranslations, destroy,
  };
}

const i18n = createI18n();
export const getLanguage = i18n.getLanguage;
export const getLocale = i18n.getLocale;
export const getLanguagePreference = i18n.getLanguagePreference;
export const getLanguageMode = i18n.getLanguageMode;
export const setLanguage = i18n.setLanguage;
export const onLanguageChange = i18n.onLanguageChange;
export const registerMessages = i18n.registerMessages;
export const t = i18n.t;
export const formatNumber = i18n.formatNumber;
export const formatBytes = i18n.formatBytes;
export const formatDateTime = i18n.formatDateTime;
export const applyTranslations = i18n.applyTranslations;
