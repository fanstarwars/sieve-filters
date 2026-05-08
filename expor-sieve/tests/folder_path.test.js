// tests/folder_path.test.js
//
// Регрессионные тесты на рассинхрон форматов имени папки между:
//   1. Импортом TB Quick Filter (Experiment API → targetFolderPath = Unicode)
//   2. Локальным selecte в Editor/Manager (browser.folders.query → IMAP mUTF7)
//   3. Сериализацией в Sieve (Dovecot Pigeonhole ждёт IMAP mUTF7)
//
// На момент написания тесты ПАДАЮТ — фиксируют баги, которые мы собираемся
// чинить через единый lib/folder_path.js. Когда тесты позеленеют, баги
// устранены.

import { describe, it, expect, vi } from 'vitest';

let _uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${++_uuidCounter}`,
});

import { mapLocalToRule } from '../lib/local_filter_mapper.js';
import { ruleToSieve, sieveToRule } from '../lib/sieve_adapter.js';

// Реальное IMAP modified UTF-7 кодирование для "Россылки".
// Для проверки: lib/imap_utf7.js decodeIMAPUTF7 даёт обратно "INBOX/Россылки".
const ROSSYLKI_UNICODE = 'INBOX/Россылки';
const ROSSYLKI_MUTF7 = 'INBOX/&BCAEPgRBBEEESwQ7BDoEOA-';

describe('Bug 2: импорт TB Quick Filter с кириллической папкой → Sieve', () => {
  it('targetFolderPath="INBOX/Россылки" (Unicode) → fileinto должен быть в IMAP mUTF7', () => {
    const tb = {
      name: 'r1', enabled: true, matchAll: true,
      searchTerms: [{ attrib: 'Subject', op: 'Contains', value: 'a', booleanAnd: true }],
      actions: [{ type: 'MoveToFolder', targetFolderPath: ROSSYLKI_UNICODE }],
    };
    const { rule } = mapLocalToRule(tb);
    rule.name = 'r1';
    const sieve = ruleToSieve(rule);

    // Dovecot Pigeonhole ждёт mUTF7. Если в Sieve уйдёт буквальная кириллица,
    // фильтр не сматчит реальную серверную папку.
    expect(sieve).toContain(`fileinto "${ROSSYLKI_MUTF7}";`);
    expect(sieve).not.toContain(`fileinto "${ROSSYLKI_UNICODE}";`);
  });

  it('round-trip: кириллическая папка выживает Rule → Sieve → Rule', () => {
    // Контракт хранения a.folder = canonical (decoded Unicode без leading '/').
    // На входе любой формат (TB-canonical с '/', Sieve-raw mUTF7, Unicode-импорт).
    const inputs = [
      ROSSYLKI_UNICODE,             // Unicode (после импорта TB Quick Filter)
      '/' + ROSSYLKI_MUTF7,         // TB-canonical (browser.folders.query)
      ROSSYLKI_MUTF7,               // Sieve-raw (после parseAction)
    ];
    for (const folder of inputs) {
      const rule = {
        name: 'r2', active: true, matchAll: true,
        conditions: [{ field: 'from', op: 'contains', value: 'a@b' }],
        actions: [{ type: 'fileinto', folder }],
        stopAfter: false,
      };
      const sieve = ruleToSieve(rule);
      // В Sieve-script всегда mUTF7 без '/' — Dovecot матчит реальную папку.
      expect(sieve).toContain(`fileinto "${ROSSYLKI_MUTF7}";`);
      // После парсинга назад — canonical Unicode.
      const back = sieveToRule(sieve);
      expect(back.actions[0].folder).toBe(ROSSYLKI_UNICODE);
    }
  });
});

describe('Bug 1: editor должен сматчить a.folder с f.path в РАЗНЫХ форматах', () => {
  // Имитируем findMatchingFolderPath: какой бы формат ни был у a.folder
  // (TB-canonical, Sieve-raw, Unicode-impt), функция должна найти ту же папку.
  // Сейчас стратегий 5 в editor.js — но они дублируются inline в rule_form.js
  // и local_runner.js. Этот тест вынесем как контракт единого folder_path.equals().

  // Когда появится lib/folder_path.js — заменим этот mock на импорт.
  function equalsCanonical(a, b) {
    const decode = (s) => {
      if (!s || !s.includes('&')) return String(s || '').replace(/^\/+/, '');
      // мини-декодер mUTF7 (тот же что в lib/imap_utf7.js)
      let out = '', i = 0;
      const stripped = String(s).replace(/^\/+/, '');
      while (i < stripped.length) {
        const c = stripped[i];
        if (c !== '&') { out += c; i++; continue; }
        const end = stripped.indexOf('-', i + 1);
        if (end === -1) { out += stripped.slice(i); break; }
        if (end === i + 1) { out += '&'; i = end + 1; continue; }
        const b64 = stripped.slice(i + 1, end).replace(/,/g, '/');
        const pad = b64 + '='.repeat((4 - b64.length % 4) % 4);
        try {
          const bytes = atob(pad);
          let str = '';
          for (let j = 0; j + 1 < bytes.length; j += 2) {
            str += String.fromCharCode((bytes.charCodeAt(j) << 8) | bytes.charCodeAt(j + 1));
          }
          out += str;
        } catch { out += stripped.slice(i, end + 1); }
        i = end + 1;
      }
      return out;
    };
    return decode(a) === decode(b);
  }

  it('TB-canonical (с /) == Sieve-raw (без /)', () => {
    expect(equalsCanonical('/' + ROSSYLKI_MUTF7, ROSSYLKI_MUTF7)).toBe(true);
  });
  it('TB-canonical mUTF7 == импортированный Unicode', () => {
    expect(equalsCanonical('/' + ROSSYLKI_MUTF7, ROSSYLKI_UNICODE)).toBe(true);
  });
  it('Sieve-raw mUTF7 == импортированный Unicode', () => {
    expect(equalsCanonical(ROSSYLKI_MUTF7, ROSSYLKI_UNICODE)).toBe(true);
  });
  it('ASCII папки (без UTF-7) — все три формата эквивалентны', () => {
    expect(equalsCanonical('/INBOX/Logistics', 'INBOX/Logistics')).toBe(true);
  });
});
