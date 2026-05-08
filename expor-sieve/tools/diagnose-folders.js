// Диагностика рассинхрона имён папок между Linux/Windows.
//
// Как запустить:
//   1. Thunderbird → меню «Инструменты» → «Менеджер фильтров expor-sieve».
//      В открывшемся окне Manager: правая кнопка → «Inspect» (или F12).
//   2. Если правой кнопки нет — Tools → Developer Tools → Browser Console
//      (Ctrl+Shift+J), и в нём смени контекст на manager.html.
//   3. В консоли вставь содержимое этого файла целиком и нажми Enter.
//   4. Дождись «── DIAGNOSE END ──», скопируй ВСЁ (правый клик → Copy all)
//      и пришли вывод.
//
// Скрипт ничего не меняет, только читает.

(async () => {
  const log = (...a) => console.log('[diagnose]', ...a);
  const hex = (s) => Array.from(String(s)).map(c => {
    const h = c.charCodeAt(0).toString(16).padStart(4, '0');
    return c.charCodeAt(0) < 0x80 ? c : `\\u${h}`;
  }).join('');

  log('── DIAGNOSE START ──');
  log('UA:', navigator.userAgent);
  log('platform:', navigator.platform);

  const send = (cmd, payload = {}) =>
    browser.runtime.sendMessage({ cmd, ...payload });

  // 1. Аккаунты
  const accounts = await send('listAccounts').catch(e => ({ error: String(e) }));
  log('accounts:', accounts);
  if (!Array.isArray(accounts) || accounts.length === 0) {
    log('нет аккаунтов — стоп');
    return;
  }

  for (const acc of accounts) {
    log(`\n══ account: ${acc.email || acc.name || acc.id} (id=${acc.id}) ══`);

    // 2. Папки этого аккаунта
    const folders = await send('listFolders', { accountId: acc.id }).catch(e => ({ error: String(e) }));
    if (!Array.isArray(folders)) { log('listFolders error:', folders); continue; }
    log(`folders: ${folders.length}`);
    for (const f of folders.slice(0, 30)) {
      const hasAmp = String(f.path || '').includes('&');
      const hasNonAscii = /[^\x00-\x7f]/.test(String(f.path || ''));
      const sep = (String(f.path || '').match(/[/\\]/g) || []).join('') || '∅';
      log(
        `  path=${JSON.stringify(f.path)}  ` +
        `name=${JSON.stringify(f.name)}  ` +
        `id=${JSON.stringify(f.id)}  ` +
        `utf7?=${hasAmp}  nonAscii?=${hasNonAscii}  sep=${sep}  ` +
        `hex=${hex(f.path)}`
      );
    }
    if (folders.length > 30) log(`  ... и ещё ${folders.length - 30}`);

    // 3. Правила: что лежит в actions[].folder
    const rules = await send('listRules', { accountId: acc.id }).catch(e => ({ error: String(e) }));
    if (!Array.isArray(rules)) { log('listRules error:', rules); continue; }
    log(`rules: ${rules.length}`);
    for (const r of rules) {
      const acts = (r.actions || []).filter(a => a.type === 'fileinto' || a.type === 'copy');
      if (acts.length === 0) continue;
      log(`  rule "${r.name}" (id=${r.id}, active=${r.active})`);
      for (const a of acts) {
        const af = a.folder;
        const hasAmp = String(af || '').includes('&');
        const hasNonAscii = /[^\x00-\x7f]/.test(String(af || ''));
        const sep = (String(af || '').match(/[/\\]/g) || []).join('') || '∅';

        // Пробуем разные стратегии матча — те же, что в editor.js:findMatchingFolderPath
        const stripSlash = (s) => String(s || '').replace(/^\/+/, '');
        const decode = (s) => {
          try { return decodeIMAPUTF7Local(stripSlash(s)); } catch { return stripSlash(s); }
        };
        const lower = (s) => decode(s).toLowerCase();

        const matches = [];
        for (const f of folders) {
          if (f.path === af) matches.push(['raw', f.path]);
          else if (stripSlash(f.path) === stripSlash(af)) matches.push(['strip', f.path]);
          else if (decode(f.path) === decode(af)) matches.push(['decode', f.path]);
          else if (lower(f.path) === lower(af)) matches.push(['lower', f.path]);
        }

        log(
          `    action=${a.type} folder=${JSON.stringify(af)}  ` +
          `utf7?=${hasAmp}  nonAscii?=${hasNonAscii}  sep=${sep}  ` +
          `hex=${hex(af)}  ` +
          `matches=${matches.length === 0 ? 'NONE' : JSON.stringify(matches)}`
        );
      }

      // 4. Sieve preview, как уйдёт на сервер
      try {
        const prev = await send('previewSieve', { rule: r });
        const folderLines = String(prev?.sieve || '')
          .split('\n').filter(ln => /fileinto/.test(ln));
        for (const ln of folderLines) log(`    sieve> ${ln.trim()}`);
      } catch (e) {
        log('    previewSieve error:', String(e && e.message || e));
      }
    }
  }

  log('\n── DIAGNOSE END ──');

  // Локальная копия decodeIMAPUTF7 — на случай если в контексте,
  // где запускают сниппет, нет импорта lib/imap_utf7.js.
  function decodeIMAPUTF7Local(s) {
    if (typeof s !== 'string' || !s.includes('&')) return s || '';
    let out = '', i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c !== '&') { out += c; i++; continue; }
      const end = s.indexOf('-', i + 1);
      if (end === -1) { out += s.slice(i); break; }
      if (end === i + 1) { out += '&'; i = end + 1; continue; }
      const b64 = s.slice(i + 1, end).replace(/,/g, '/');
      const pad = b64.length % 4 ? b64 + '='.repeat(4 - b64.length % 4) : b64;
      try {
        const bytes = atob(pad);
        let str = '';
        for (let j = 0; j + 1 < bytes.length; j += 2) {
          str += String.fromCharCode((bytes.charCodeAt(j) << 8) | bytes.charCodeAt(j + 1));
        }
        out += str;
      } catch {
        out += s.slice(i, end + 1);
      }
      i = end + 1;
    }
    return out;
  }
})();
