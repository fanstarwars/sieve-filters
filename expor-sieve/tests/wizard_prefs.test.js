// Tests for lib/wizard_prefs.js, lib/folder_filter.js and the wizard
// templates' integration with WizardPrefs (subject prefix stripping +
// own-recipient exclusion).

import { beforeEach, describe, it, expect, vi } from 'vitest';

// ───────── Storage mock ─────────────────────────────────────────────────────
class FakeStorage {
  constructor(initial = {}) { this.data = { ...initial }; }
  async get(keys) {
    if (keys == null) return { ...this.data };
    if (typeof keys === 'string') {
      return (keys in this.data) ? { [keys]: this.data[keys] } : {};
    }
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (k in this.data) out[k] = this.data[k];
      return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(keys)) {
      out[k] = (k in this.data) ? this.data[k] : v;
    }
    return out;
  }
  async set(patch) { Object.assign(this.data, patch); }
  async remove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) delete this.data[k];
  }
}

let fakeLocal;

// Минимальный стаб i18n: для ключей wiz_name_* возвращаем русский шаблон
// (тесты ниже сравнивают конкретные строки rule.name по русской локали).
// Это эмулирует поведение browser.i18n.getMessage: подставляет позиционные
// аргументы $N$/$1 и т.п. Для остальных ключей возвращаем '' — тогда t()
// (см. lib/rule_form.js) падает в `|| key` и не ломает остальные тесты.
function fakeI18n(key, subs) {
  const args = Array.isArray(subs) ? subs : [];
  switch (key) {
    case 'wiz_name_sender':    return `От ${args[0] ?? ''}`;
    case 'wiz_name_domain':    return `Домен ${args[0] ?? ''}`;
    case 'wiz_name_recipient': return `Кому ${args[0] ?? ''}`;
    case 'wiz_name_reply_to':  return `Reply-To ${args[0] ?? ''}`;
    case 'wiz_name_subject':   return `Тема: ${args[0] ?? ''}`;
    case 'wiz_name_list':      return 'Список рассылки';
    default:                   return '';
  }
}

function setupBrowser(initial = {}) {
  fakeLocal = new FakeStorage(initial);
  vi.stubGlobal('browser', {
    storage: {
      local: fakeLocal,
      onChanged: { addListener: vi.fn() },
    },
    i18n: { getMessage: fakeI18n },
  });
}

beforeEach(() => {
  setupBrowser({});
  vi.resetModules();
});

// ───────────────────────────────────────────────────────────────────────────
// cleanSubjectForName
// ───────────────────────────────────────────────────────────────────────────
describe('cleanSubjectForName', () => {
  it('пустая строка → возвращает пустую (как есть)', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('')).toBe('');
    expect(cleanSubjectForName(null)).toBe('');
    expect(cleanSubjectForName(undefined)).toBe('');
  });

  it('строка без префиксов остаётся без изменений (после trim)', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('hello world')).toBe('hello world');
    expect(cleanSubjectForName('  hello world  ')).toBe('hello world');
  });

  it('один префикс Re:', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('Re: счёт')).toBe('счёт');
  });

  it('один префикс Fwd:', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('Fwd: Hello')).toBe('Hello');
  });

  it('цепочка Re: Re: Fwd: x → x', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('Re: Re: Fwd: счёт')).toBe('счёт');
  });

  it('регистр игнорируется (RE:, re:, rE:)', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('RE: hello')).toBe('hello');
    expect(cleanSubjectForName('re: hello')).toBe('hello');
    expect(cleanSubjectForName('rE: hello')).toBe('hello');
    expect(cleanSubjectForName('FWD: hello')).toBe('hello');
  });

  it('кастомные префиксы из аргумента (Antw:, Wg:)', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('Antw: Hallo', ['Antw'])).toBe('Hallo');
    expect(cleanSubjectForName('Wg: Foo', ['Wg', 'Aw'])).toBe('Foo');
  });

  it('пустой массив prefixes → строка не меняется (только trim)', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('Re: hello', [])).toBe('Re: hello');
  });

  it('whitespace tolerance: лишние пробелы между префиксом и текстом', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('Re:   hello')).toBe('hello');
    expect(cleanSubjectForName('  Re:hello')).toBe('hello');
    expect(cleanSubjectForName('Re :  hello')).toBe('hello');
  });

  it('после очистки пусто → возвращает оригинал (не ломает фильтр)', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('Re:')).toBe('Re:');
    expect(cleanSubjectForName('Re: Re: Re:')).toBe('Re: Re: Re:');
  });

  it('префиксы можно передать с двоеточием или без — обе формы работают', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('Re: x', ['Re:'])).toBe('x');
    expect(cleanSubjectForName('Re: x', ['Re'])).toBe('x');
  });

  it('обычное слово начинающееся с "Re" не трогается', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('Reorder request')).toBe('Reorder request');
  });

  it('смесь языковых префиксов в цепочке (Re: Antw: Wg: …)', async () => {
    const { cleanSubjectForName } = await import('../lib/wizard_prefs.js');
    expect(cleanSubjectForName('Re: Antw: Wg: тема')).toBe('тема');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// load/saveWizardPrefs
// ───────────────────────────────────────────────────────────────────────────
describe('loadWizardPrefs / saveWizardPrefs', () => {
  it('пустой storage → DEFAULTS', async () => {
    setupBrowser({});
    vi.resetModules();
    const { loadWizardPrefs, DEFAULTS } = await import('../lib/wizard_prefs.js');
    const got = await loadWizardPrefs();
    expect(got.stripSubjectPrefixes).toBe(true);
    expect(got.subjectPrefixes).toEqual(DEFAULTS.subjectPrefixes);
    expect(got.hideSystemFolders).toBe(true);
    expect(got.excludeOwnAddresses).toBe(true);
    expect(got.newRulePosition).toBe('end');
  });

  it('partial patch — слияние с дефолтами', async () => {
    setupBrowser({});
    vi.resetModules();
    const { saveWizardPrefs, loadWizardPrefs } = await import('../lib/wizard_prefs.js');
    await saveWizardPrefs({ stripSubjectPrefixes: false });
    const got = await loadWizardPrefs();
    expect(got.stripSubjectPrefixes).toBe(false);
    expect(got.hideSystemFolders).toBe(true); // не тронут
    expect(got.newRulePosition).toBe('end');
  });

  it('saveWizardPrefs — несколько последовательных patch-ей', async () => {
    setupBrowser({});
    vi.resetModules();
    const { saveWizardPrefs, loadWizardPrefs } = await import('../lib/wizard_prefs.js');
    await saveWizardPrefs({ newRulePosition: 'top' });
    await saveWizardPrefs({ excludeOwnAddresses: false });
    const got = await loadWizardPrefs();
    expect(got.newRulePosition).toBe('top');
    expect(got.excludeOwnAddresses).toBe(false);
    expect(got.stripSubjectPrefixes).toBe(true);
  });

  it('битая newRulePosition сводится к "end"', async () => {
    setupBrowser({});
    vi.resetModules();
    const { saveWizardPrefs } = await import('../lib/wizard_prefs.js');
    const got = await saveWizardPrefs({ newRulePosition: 'middle' });
    expect(got.newRulePosition).toBe('end');
  });

  it('subjectPrefixes — фильтрация пустых и trim', async () => {
    setupBrowser({});
    vi.resetModules();
    const { saveWizardPrefs } = await import('../lib/wizard_prefs.js');
    const got = await saveWizardPrefs({
      subjectPrefixes: ['  Re:  ', '', '  ', 'Fwd:', null, undefined, 0],
    });
    // 0 → "0" → "0" — не пусто, остаётся.
    expect(got.subjectPrefixes).toEqual(['Re:', 'Fwd:', '0']);
  });

  it('subjectPrefixes — все пустые → возврат к DEFAULTS', async () => {
    setupBrowser({});
    vi.resetModules();
    const { saveWizardPrefs, DEFAULTS } = await import('../lib/wizard_prefs.js');
    const got = await saveWizardPrefs({ subjectPrefixes: ['', '   ', null] });
    expect(got.subjectPrefixes).toEqual(DEFAULTS.subjectPrefixes);
  });

  it('subjectPrefixes — не массив → DEFAULTS', async () => {
    setupBrowser({});
    vi.resetModules();
    const { saveWizardPrefs, DEFAULTS } = await import('../lib/wizard_prefs.js');
    const got = await saveWizardPrefs({ subjectPrefixes: 'Re:, Fwd:' });
    expect(got.subjectPrefixes).toEqual(DEFAULTS.subjectPrefixes);
  });

  it('сохранение записывается в storage.local', async () => {
    setupBrowser({});
    vi.resetModules();
    const { saveWizardPrefs } = await import('../lib/wizard_prefs.js');
    await saveWizardPrefs({ stripSubjectPrefixes: false });
    expect(fakeLocal.data.wizardPrefs).toBeTruthy();
    expect(fakeLocal.data.wizardPrefs.stripSubjectPrefixes).toBe(false);
  });

  it('loadWizardPrefs не выбрасывает при отсутствии browser.storage', async () => {
    vi.stubGlobal('browser', { i18n: { getMessage: () => '' } });
    vi.resetModules();
    const { loadWizardPrefs, DEFAULTS } = await import('../lib/wizard_prefs.js');
    const got = await loadWizardPrefs();
    expect(got.stripSubjectPrefixes).toBe(DEFAULTS.stripSubjectPrefixes);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// folder_filter — isSystemFolder / filterUsableFolders
// ───────────────────────────────────────────────────────────────────────────
describe('isSystemFolder / filterUsableFolders', () => {
  it('распознаёт через specialUse=["trash"]', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    expect(isSystemFolder({ specialUse: ['trash'], name: 'X', path: '/X' })).toBe(true);
  });

  it('распознаёт все 7 системных типов через specialUse', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    for (const t of ['archives', 'drafts', 'junk', 'outbox', 'sent', 'templates', 'trash']) {
      expect(isSystemFolder({ specialUse: [t], name: 'whatever' })).toBe(true);
    }
  });

  it('inbox через specialUse — НЕ системная (в неё можно fileinto)', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    expect(isSystemFolder({ specialUse: ['inbox'], name: 'INBOX' })).toBe(false);
  });

  it('обычная папка → false', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    expect(isSystemFolder({ name: 'Projects', path: '/INBOX/Projects' })).toBe(false);
    expect(isSystemFolder({ specialUse: [], name: 'Mail' })).toBe(false);
  });

  it('legacy: type="trash" (старые TB или прокси без specialUse)', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    expect(isSystemFolder({ type: 'trash', name: 'X', path: '/X' })).toBe(true);
    expect(isSystemFolder({ type: 'TRASH' })).toBe(true);
  });

  it('fallback по имени: английские стандартные имена', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    expect(isSystemFolder({ name: 'Trash', path: '/Trash' })).toBe(true);
    expect(isSystemFolder({ name: 'Junk', path: '/Junk' })).toBe(true);
    expect(isSystemFolder({ name: 'Drafts', path: '/Drafts' })).toBe(true);
    expect(isSystemFolder({ name: 'Sent', path: '/Sent' })).toBe(true);
    expect(isSystemFolder({ name: 'Outbox', path: '/Outbox' })).toBe(true);
    expect(isSystemFolder({ name: 'Templates', path: '/Templates' })).toBe(true);
    expect(isSystemFolder({ name: 'Archive', path: '/Archive' })).toBe(true);
  });

  it('fallback по имени: русские названия', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    expect(isSystemFolder({ name: 'Корзина' })).toBe(true);
    expect(isSystemFolder({ name: 'Спам' })).toBe(true);
    expect(isSystemFolder({ name: 'Черновики' })).toBe(true);
    expect(isSystemFolder({ name: 'Отправленные' })).toBe(true);
    expect(isSystemFolder({ name: 'Архив' })).toBe(true);
  });

  it('fallback по имени: немецкие названия', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    expect(isSystemFolder({ name: 'Papierkorb' })).toBe(true);
    expect(isSystemFolder({ name: 'Entwürfe' })).toBe(true);
    expect(isSystemFolder({ name: 'Gesendet' })).toBe(true);
  });

  it('fallback по имени: французские названия', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    expect(isSystemFolder({ name: 'Corbeille' })).toBe(true);
    expect(isSystemFolder({ name: 'Brouillons' })).toBe(true);
    expect(isSystemFolder({ name: 'Envoyés' })).toBe(true);
  });

  it('регистр игнорируется в fallback', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    expect(isSystemFolder({ name: 'TRASH' })).toBe(true);
    expect(isSystemFolder({ name: 'корзина' })).toBe(true);
    expect(isSystemFolder({ path: '/trash' })).toBe(true);
  });

  it('специальное use перебивает fallback (массив пустой → имя нормальное)', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    // Если папка названа "Trash" но specialUse=[] и type отсутствует —
    // всё равно ловим её через fallback. (Это желаемое поведение.)
    expect(isSystemFolder({ specialUse: [], name: 'Trash' })).toBe(true);
  });

  it('пустой/null folder → false', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    expect(isSystemFolder(null)).toBe(false);
    expect(isSystemFolder(undefined)).toBe(false);
    expect(isSystemFolder({})).toBe(false);
  });

  it('filterUsableFolders с hideSystemFolders=true (default) фильтрует', async () => {
    const { filterUsableFolders } = await import('../lib/folder_filter.js');
    const folders = [
      { name: 'INBOX', path: '/INBOX' },
      { name: 'Projects', path: '/INBOX/Projects' },
      { name: 'Trash', path: '/Trash', specialUse: ['trash'] },
      { name: 'Drafts', path: '/Drafts', specialUse: ['drafts'] },
    ];
    const got = filterUsableFolders(folders, { hideSystemFolders: true });
    expect(got.map(f => f.name)).toEqual(['INBOX', 'Projects']);
  });

  it('filterUsableFolders с hideSystemFolders=false → всё возвращается', async () => {
    const { filterUsableFolders } = await import('../lib/folder_filter.js');
    const folders = [
      { name: 'INBOX' }, { name: 'Trash', specialUse: ['trash'] },
    ];
    expect(filterUsableFolders(folders, { hideSystemFolders: false }).length).toBe(2);
  });

  it('filterUsableFolders без opts → hideSystemFolders=true по умолчанию', async () => {
    const { filterUsableFolders } = await import('../lib/folder_filter.js');
    const folders = [{ name: 'INBOX' }, { name: 'Trash', specialUse: ['trash'] }];
    expect(filterUsableFolders(folders).map(f => f.name)).toEqual(['INBOX']);
  });

  it('filterUsableFolders с не-массивом → []', async () => {
    const { filterUsableFolders } = await import('../lib/folder_filter.js');
    expect(filterUsableFolders(null)).toEqual([]);
    expect(filterUsableFolders(undefined)).toEqual([]);
  });

  it('path-tail распознаётся (для вложенных «Trash» — например /INBOX/Trash)', async () => {
    const { isSystemFolder } = await import('../lib/folder_filter.js');
    // /INBOX/Trash — последний сегмент = "Trash" → системная.
    expect(isSystemFolder({ name: 'Some', path: '/INBOX/Trash' })).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Wizard templates: subject prefix stripping + own-recipient exclusion
// ───────────────────────────────────────────────────────────────────────────
describe('wizard templates × WizardPrefs', () => {
  it('subject template: stripSubjectPrefixes=true → имя без "Re:"', async () => {
    setupBrowser({});
    vi.resetModules();
    const { TEMPLATES } = await import('../wizard/templates.js');
    const tpl = TEMPLATES.find(t => t.id === 'subject');
    const rule = {};
    tpl.apply(rule, { subject: 'Re: счёт за апрель' }, [], {
      prefs: {
        stripSubjectPrefixes: true,
        subjectPrefixes: ['Re:', 'Fwd:'],
      },
    });
    expect(rule.name).toBe('Тема: счёт за апрель');
    expect(rule.conditions[0].value).toBe('счёт за апрель');
  });

  it('subject template: stripSubjectPrefixes=false → имя как есть', async () => {
    setupBrowser({});
    vi.resetModules();
    const { TEMPLATES } = await import('../wizard/templates.js');
    const tpl = TEMPLATES.find(t => t.id === 'subject');
    const rule = {};
    tpl.apply(rule, { subject: 'Re: счёт' }, [], {
      prefs: { stripSubjectPrefixes: false, subjectPrefixes: ['Re:'] },
    });
    expect(rule.name).toBe('Тема: Re: счёт');
  });

  it('subject template без opts → дефолтное поведение (со strip)', async () => {
    setupBrowser({});
    vi.resetModules();
    const { TEMPLATES } = await import('../wizard/templates.js');
    const tpl = TEMPLATES.find(t => t.id === 'subject');
    const rule = {};
    tpl.apply(rule, { subject: 'Fwd: hello' }, []);
    // Без opts → используются DEFAULTS, stripSubjectPrefixes=true.
    expect(rule.name).toBe('Тема: hello');
  });

  it('subject template: цепочка префиксов корректно очищается', async () => {
    setupBrowser({});
    vi.resetModules();
    const { TEMPLATES } = await import('../wizard/templates.js');
    const tpl = TEMPLATES.find(t => t.id === 'subject');
    const rule = {};
    tpl.apply(rule, { subject: 'Re: Re: Fwd: важное' }, [], {
      prefs: { stripSubjectPrefixes: true, subjectPrefixes: ['Re:', 'Fwd:'] },
    });
    expect(rule.name).toBe('Тема: важное');
  });

  it('recipient template: supports=true если мой email совпадает с author, но recipient — другой', async () => {
    setupBrowser({});
    vi.resetModules();
    const { TEMPLATES } = await import('../wizard/templates.js');
    const tpl = TEMPLATES.find(t => t.id === 'recipient');
    const ok = tpl.supports(
      { author: 'me@example.com', recipients: 'friend@elsewhere.org' },
      { prefs: { excludeOwnAddresses: true }, ownEmails: ['me@example.com'] },
    );
    expect(ok).toBe(true);
  });

  it('recipient template: supports=false если ВСЕ recipients свои + author свой', async () => {
    setupBrowser({});
    vi.resetModules();
    const { TEMPLATES } = await import('../wizard/templates.js');
    const tpl = TEMPLATES.find(t => t.id === 'recipient');
    const ok = tpl.supports(
      { author: 'me@example.com', recipients: 'me@example.com' },
      { prefs: { excludeOwnAddresses: true }, ownEmails: ['me@example.com'] },
    );
    expect(ok).toBe(false);
  });

  it('recipient template: excludeOwnAddresses=false → supports=true даже на свой адрес', async () => {
    setupBrowser({});
    vi.resetModules();
    const { TEMPLATES } = await import('../wizard/templates.js');
    const tpl = TEMPLATES.find(t => t.id === 'recipient');
    const ok = tpl.supports(
      { author: 'me@example.com', recipients: 'me@example.com' },
      { prefs: { excludeOwnAddresses: false }, ownEmails: ['me@example.com'] },
    );
    expect(ok).toBe(true);
  });

  it('recipient template: ownEmails пустой → supports=true (не у кого исключать)', async () => {
    setupBrowser({});
    vi.resetModules();
    const { TEMPLATES } = await import('../wizard/templates.js');
    const tpl = TEMPLATES.find(t => t.id === 'recipient');
    const ok = tpl.supports(
      { author: 'me@example.com', recipients: 'me@example.com' },
      { prefs: { excludeOwnAddresses: true }, ownEmails: [] },
    );
    expect(ok).toBe(true);
  });

  it('recipient template: apply берёт первый non-own recipient', async () => {
    setupBrowser({});
    vi.resetModules();
    const { TEMPLATES } = await import('../wizard/templates.js');
    const tpl = TEMPLATES.find(t => t.id === 'recipient');
    const rule = {};
    tpl.apply(rule, {
      author: 'sender@x.ru',
      recipients: 'me@example.com, alias@example.com, friend@y.ru',
    }, [], {
      prefs: { excludeOwnAddresses: true },
      ownEmails: ['me@example.com', 'alias@example.com'],
    });
    expect(rule.name).toBe('Кому friend@y.ru');
    expect(rule.conditions[0].value).toBe('friend@y.ru');
  });

  it('recipient template: case-insensitive own match отключает шаблон только когда автор тоже свой', async () => {
    setupBrowser({});
    vi.resetModules();
    const { TEMPLATES } = await import('../wizard/templates.js');
    const tpl = TEMPLATES.find(t => t.id === 'recipient');
    // recipients=ME@... но author=me@... (тот же ящик self-CC) — оба свои → false.
    const ok = tpl.supports(
      { author: 'me@example.com', recipients: 'ME@EXAMPLE.com' },
      { prefs: { excludeOwnAddresses: true }, ownEmails: ['me@example.com'] },
    );
    expect(ok).toBe(false);
  });

  it('sender template работает без opts (стабильность legacy-callers)', async () => {
    setupBrowser({});
    vi.resetModules();
    const { TEMPLATES } = await import('../wizard/templates.js');
    const tpl = TEMPLATES.find(t => t.id === 'sender');
    const rule = {};
    tpl.apply(rule, { author: 'Иван <ivan@x.ru>' }, []);
    expect(rule.conditions[0].value).toBe('ivan@x.ru');
  });
});
