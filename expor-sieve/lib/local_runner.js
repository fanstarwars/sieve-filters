// lib/local_runner.js — локальный runner правил по существующим письмам.
//
// Sieve-фильтры на сервере отрабатывают только при доставке нового письма.
// Эта фича применяет существующее правило к уже-лежащим в папке письмам:
// проходим по folderId через browser.messages.list/continueList, для каждого
// письма проверяем условия (зеркально логике sieve_adapter.buildTest), и при
// match выполняем actions через стандартные TB MailExtension API.
//
// Чисто локальная операция — middleware/proxy_client не используется.
//
// Поддержанные conditions (см. lib/rule_form.js opsForField):
//   from/to/cc/subject/header → contains, not_contains, is, starts, ends, contains_any
//   size                      → gt, lt
//   attachment                → has_attachment, no_attachment
//
// Поддержанные actions (см. lib/rule_form.js ACTIONS):
//   fileinto, copy → требуют folder path → resolve to MailFolderId через folders.query
//   mark_read      → messages.update(id, { read: true })
//   flag           → messages.update(id, { flagged: true })
//   trash          → messages.move в spec'use=trash папку (или discard если её нет)
//   discard        → messages.delete([id])  (move-to-trash, не permanent)
//   redirect       → SKIPPED с warning (нет client-side SMTP)
//
// Прогресс-callback дёргается каждые ~50 сообщений (для UI).
// Abort через AbortSignal — корректно прерывает на ближайшей итерации.

import { findMatch, toCanonical } from './folder_path.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Ищет folder в массиве по path. Принимает любой формат пути (TB-canonical
 * c '/', Sieve-raw, Unicode-decoded — см. lib/folder_path.js). Делегирует
 * единому findMatch.
 *
 * @param {Array<{id, name, path}>} folders
 * @param {string} path
 * @returns {{id, name, path}|null}
 */
export function findFolderByPath(folders, path) {
  return findMatch(path, folders);
}

/**
 * Найти trash папку в списке папок аккаунта. Использует MailFolder.specialUse
 * (TB 121+: массив строк типа ['trash']) или type==='trash' (legacy).
 */
export function findTrashFolder(folders) {
  if (!Array.isArray(folders)) return null;
  for (const f of folders) {
    if (!f) continue;
    const su = f.specialUse;
    if (Array.isArray(su) && su.includes('trash')) return f;
    if (typeof su === 'string' && su.toLowerCase() === 'trash') return f;
    if (f.type && String(f.type).toLowerCase() === 'trash') return f;
  }
  // Fallback: имя/path начинается с "Trash" (английская локаль).
  for (const f of folders) {
    if (!f) continue;
    const name = String(f.name || '').toLowerCase();
    const path = toCanonical(f.path).toLowerCase();
    if (name === 'trash' || path === 'trash' || path.endsWith('/trash')) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------
// matchCondition
// ---------------------------------------------------------------------------

function asString(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function ciIncludes(haystack, needle) {
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}
function ciEquals(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}
function ciStarts(haystack, needle) {
  return String(haystack).toLowerCase().startsWith(String(needle).toLowerCase());
}
function ciEnds(haystack, needle) {
  return String(haystack).toLowerCase().endsWith(String(needle).toLowerCase());
}

/**
 * Преобразует size value/unit в байты (зеркало sieve_adapter: K|M).
 */
function sizeToBytes(value, unit) {
  const n = Number(value) || 0;
  if (unit === 'MB') return n * 1024 * 1024;
  return n * 1024;  // KB по умолчанию (как в sieve_adapter)
}

/**
 * Извлекает строковое представление поля из MessageHeader (+опц. full).
 *
 * @param {string} field
 * @param {string} [headerName] для field === 'header'
 * @param {object} msg          MessageHeader
 * @param {object} [full]       результат browser.messages.getFull (опц.)
 * @returns {string|null}       null если поле не извлечь
 */
function extractTextField(field, headerName, msg, full) {
  switch (field) {
    case 'from':
      return asString(msg.author);
    case 'to':
      return asString(msg.recipients);
    case 'cc':
      return asString(msg.ccList);
    case 'subject':
      return asString(msg.subject);
    case 'header': {
      if (!headerName) return null;
      const key = String(headerName).toLowerCase();
      // browser.messages.getFull headers: dictionary key→array<string>.
      const h = full?.headers?.[key];
      if (Array.isArray(h)) return h.join(', ');
      if (typeof h === 'string') return h;
      return null;
    }
    default:
      return null;
  }
}

/**
 * Определяет, есть ли у сообщения вложения. Использует:
 *   1. msg.hasAttachment (поле было удалено из MessageHeader, но мы пробуем);
 *   2. full.parts: рекурсивный walk — есть ли часть с partName !== '' и
 *      contentType не text/* и not multipart/*;
 *   3. multipart/mixed в Content-Type — приближение sieve_adapter dialect.
 */
function hasAttachment(msg, full) {
  if (typeof msg?.hasAttachment === 'boolean') return msg.hasAttachment;

  // Walk full.parts
  if (full && Array.isArray(full.parts)) {
    let found = false;
    const walk = (parts) => {
      for (const p of (parts || [])) {
        if (found) return;
        const ct = String(p.contentType || '').toLowerCase();
        // Attachment-like part: имеет name или partName !== '1' и не text/*
        const isText = ct.startsWith('text/');
        const isMultipart = ct.startsWith('multipart/');
        if (!isText && !isMultipart && (p.name || (p.partName && p.partName !== '1'))) {
          found = true;
          return;
        }
        if (Array.isArray(p.parts) && p.parts.length) walk(p.parts);
      }
    };
    walk(full.parts);
    if (found) return true;
  }

  // Fallback: Content-Type начинается с multipart/ (приближение из sieve_adapter)
  const ct = full?.headers?.['content-type']?.[0] || '';
  if (String(ct).toLowerCase().startsWith('multipart/')) {
    // multipart/alternative — обычно нет вложений; multipart/mixed — обычно есть.
    if (/multipart\/(mixed|related|signed|encrypted)/i.test(ct)) return true;
  }
  return false;
}

/**
 * Применяет одно условие к сообщению.
 *
 * @param {object} cond  Condition (см. rule_model.js)
 * @param {object} msg   MessageHeader
 * @param {object} [full] результат browser.messages.getFull (для header/attachment)
 * @returns {boolean}
 */
export function matchCondition(cond, msg, full) {
  if (!cond || !msg) return false;

  // size
  if (cond.field === 'size') {
    const threshold = sizeToBytes(cond.value, cond.unit);
    const sz = Number(msg.size || 0);
    if (cond.op === 'gt') return sz > threshold;
    if (cond.op === 'lt') return sz < threshold;
    return false;
  }

  // attachment
  if (cond.field === 'attachment') {
    const has = hasAttachment(msg, full);
    if (cond.op === 'has_attachment') return has;
    if (cond.op === 'no_attachment') return !has;
    return false;
  }

  // text-like fields: from/to/cc/subject/header
  const text = extractTextField(cond.field, cond.headerName, msg, full);
  if (text == null) return false;

  switch (cond.op) {
    case 'contains':
      return ciIncludes(text, asString(cond.value));
    case 'not_contains':
      return !ciIncludes(text, asString(cond.value));
    case 'is':
      return ciEquals(text, asString(cond.value));
    case 'starts':
      return ciStarts(text, asString(cond.value));
    case 'ends':
      return ciEnds(text, asString(cond.value));
    case 'contains_any': {
      const arr = Array.isArray(cond.value) ? cond.value : [cond.value];
      return arr.some((v) => ciIncludes(text, asString(v)));
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// matchRule
// ---------------------------------------------------------------------------

/**
 * Проверка правила (allof/anyof) с нужным набором условий.
 *
 * @param {object} rule  Rule
 * @param {object} msg   MessageHeader
 * @param {object} [full] результат getFull (для header/attachment); опц.
 * @returns {boolean}
 */
export function matchRule(rule, msg, full) {
  if (!rule || !Array.isArray(rule.conditions) || rule.conditions.length === 0) {
    return false;
  }
  const matchAll = rule.matchAll !== false;
  if (matchAll) {
    return rule.conditions.every((c) => matchCondition(c, msg, full));
  }
  return rule.conditions.some((c) => matchCondition(c, msg, full));
}

// ---------------------------------------------------------------------------
// needFullMessage — нужен ли getFull для оценки правила
// ---------------------------------------------------------------------------

/**
 * Возвращает true, если для оценки rule.conditions нужно вызывать getFull.
 * Получение полного сообщения дорого, делаем только когда реально нужно
 * (custom header или attachment).
 */
export function needFullMessage(rule) {
  if (!rule || !Array.isArray(rule.conditions)) return false;
  for (const c of rule.conditions) {
    if (c.field === 'header') return true;
    if (c.field === 'attachment') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// applyActions
// ---------------------------------------------------------------------------

/**
 * Выполнить actions для одного сообщения.
 *
 * @param {object} rule
 * @param {object} msg                 MessageHeader (нужен msg.id)
 * @param {object} ctx                 контекст исполнения
 * @param {Array}  ctx.folders         все папки accountId
 * @param {object} [ctx.trashFolder]   преcomputed trash folder (опц.)
 * @returns {Promise<{applied: string[], skipped: string[], errors: string[]}>}
 */
export async function applyActions(rule, msg, ctx) {
  const applied = [];
  const skipped = [];
  const errors = [];
  const folders = (ctx && ctx.folders) || [];
  const trashFolder = (ctx && ctx.trashFolder) || findTrashFolder(folders);

  for (const a of (rule.actions || [])) {
    try {
      switch (a.type) {
        case 'fileinto': {
          const target = findFolderByPath(folders, a.folder);
          if (!target) {
            errors.push(`fileinto: folder not found "${a.folder}"`);
            continue;
          }
          // docs: https://webextension-api.thunderbird.net/en/mv3/messages.html#move
          await browser.messages.move([msg.id], target.id);
          applied.push('fileinto');
          break;
        }
        case 'copy': {
          const target = findFolderByPath(folders, a.folder);
          if (!target) {
            errors.push(`copy: folder not found "${a.folder}"`);
            continue;
          }
          // docs: https://webextension-api.thunderbird.net/en/mv3/messages.html#copy
          await browser.messages.copy([msg.id], target.id);
          applied.push('copy');
          break;
        }
        case 'mark_read': {
          // docs: https://webextension-api.thunderbird.net/en/mv3/messages.html#update
          await browser.messages.update(msg.id, { read: true });
          applied.push('mark_read');
          break;
        }
        case 'flag': {
          // docs: https://webextension-api.thunderbird.net/en/mv3/messages.html#update
          await browser.messages.update(msg.id, { flagged: true });
          applied.push('flag');
          break;
        }
        case 'tag': {
          // Локальный аналог серверного `addflag $labelN` — добавляем
          // user-keywords к msg.tags. messages.update ожидает ПОЛНЫЙ массив
          // tags (а не дельту), поэтому сливаем с текущими.
          // docs: https://webextension-api.thunderbird.net/en/mv3/messages.html#update
          const incoming = Array.isArray(a.keywords) ? a.keywords : [];
          if (incoming.length === 0) {
            // Defensive — validateRule отбивает пустой keywords, но если
            // дошли — пропускаем без ошибки.
            applied.push('tag');
            break;
          }
          // msg.tags может быть undefined в старых TB; используем [] fallback.
          const cur = Array.isArray(msg.tags) ? msg.tags : [];
          const merged = Array.from(new Set([...cur, ...incoming]));
          await browser.messages.update(msg.id, { tags: merged });
          applied.push('tag');
          break;
        }
        case 'trash': {
          if (trashFolder) {
            await browser.messages.move([msg.id], trashFolder.id);
            applied.push('trash');
          } else {
            // Fallback: messages.delete (honors account trash settings)
            // docs: https://webextension-api.thunderbird.net/en/mv3/messages.html#delete
            await browser.messages.delete([msg.id], false);
            applied.push('trash');
          }
          break;
        }
        case 'discard': {
          // discard в Sieve = удалить тихо. В TB API ближайший аналог — delete
          // без принудительного skipTrash (= move to trash, не permanent).
          // docs: https://webextension-api.thunderbird.net/en/mv3/messages.html#delete
          await browser.messages.delete([msg.id], false);
          applied.push('discard');
          break;
        }
        case 'redirect': {
          // Нет client-side SMTP в MailExtension API: redirect требует исходящего
          // соединения. Sieve выполняет это серверно, но для already-delivered
          // писем у нас этого канала нет. Skip с warning.
          skipped.push('redirect');
          break;
        }
        default:
          errors.push(`unsupported action: ${a.type}`);
      }
    } catch (e) {
      errors.push(`${a.type}: ${e?.message || String(e)}`);
    }
  }

  return { applied, skipped, errors };
}

// ---------------------------------------------------------------------------
// runRuleOnFolder — главная функция
// ---------------------------------------------------------------------------

/**
 * Применить правило ко всем письмам в указанной папке.
 *
 * Алгоритм:
 *   1. browser.messages.list(folderId) → page; loop через continueList.
 *   2. Для каждого msg: optional getFull → matchRule → applyActions.
 *   3. onProgress({processed, total, matched, applied, errors}) каждые ~50.
 *   4. Поддержка abort через AbortSignal.
 *
 * Возвращает summary {processed, total, matched, applied, errors[], skipped[]}.
 * total может быть 0 если папка пуста (или null если неизвестно).
 *
 * @param {object} rule                   Rule
 * @param {string} folderId               MailFolderId (НЕ path)
 * @param {object} [opts]
 * @param {Function} [opts.onProgress]    callback({processed, total, matched, applied, errors, skipped})
 * @param {AbortSignal} [opts.signal]     отмена
 * @param {Array} [opts.folders]          preloaded folders для accountId (для resolve fileinto/trash)
 * @returns {Promise<{processed, total, matched, applied, errors: string[], skipped: string[], aborted: boolean}>}
 */
export async function runRuleOnFolder(rule, folderId, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const signal = opts.signal || null;
  const folders = Array.isArray(opts.folders) ? opts.folders : [];
  const trashFolder = findTrashFolder(folders);
  const wantFull = needFullMessage(rule);

  const summary = {
    processed: 0,
    total: null,        // если getFolderInfo доступен — заполним; иначе null
    matched: 0,
    applied: 0,
    errors: [],
    skipped: [],
    aborted: false,
  };

  // Попробуем получить total через folders.getFolderInfo (TB 91+).
  // Это не критично — UI показывает '?' если не получилось.
  // docs: https://webextension-api.thunderbird.net/en/mv3/folders.html#get-folder-info
  try {
    if (browser.folders && typeof browser.folders.getFolderInfo === 'function') {
      const info = await browser.folders.getFolderInfo(folderId);
      const t = Number(info?.totalMessageCount);
      if (Number.isFinite(t) && t >= 0) summary.total = t;
    }
  } catch {
    // ignore — total остаётся null
  }

  if (signal && signal.aborted) {
    summary.aborted = true;
    summary.errors.push('aborted');
    onProgress({ ...summary });
    return summary;
  }

  // Page-by-page iteration через generator.
  // docs: https://webextension-api.thunderbird.net/en/mv3/messages.html#list-folderid
  // docs: https://webextension-api.thunderbird.net/en/mv3/messages.html#continue-list-messagelistid
  const REPORT_EVERY = 50;
  let lastReport = 0;

  let page;
  try {
    page = await browser.messages.list(folderId);
  } catch (e) {
    summary.errors.push(`list: ${e?.message || String(e)}`);
    onProgress({ ...summary });
    return summary;
  }

  while (page) {
    const messages = Array.isArray(page.messages) ? page.messages : [];
    for (const msg of messages) {
      if (signal && signal.aborted) {
        summary.aborted = true;
        summary.errors.push('aborted');
        onProgress({ ...summary });
        return summary;
      }

      summary.processed++;

      let full = null;
      if (wantFull) {
        try {
          // docs: https://webextension-api.thunderbird.net/en/mv3/messages.html#get-full-messageid-options
          full = await browser.messages.getFull(msg.id);
        } catch (e) {
          summary.errors.push(`getFull(${msg.id}): ${e?.message || String(e)}`);
        }
      }

      let matched = false;
      try {
        matched = matchRule(rule, msg, full);
      } catch (e) {
        summary.errors.push(`match(${msg.id}): ${e?.message || String(e)}`);
        matched = false;
      }
      if (matched) {
        summary.matched++;
        const r = await applyActions(rule, msg, { folders, trashFolder });
        if (r.applied.length) summary.applied++;
        for (const s of r.skipped) {
          if (!summary.skipped.includes(s)) summary.skipped.push(s);
        }
        for (const er of r.errors) summary.errors.push(er);
      }

      if (summary.processed - lastReport >= REPORT_EVERY) {
        lastReport = summary.processed;
        onProgress({ ...summary });
      }
    }

    if (!page.id) break;
    try {
      page = await browser.messages.continueList(page.id);
    } catch (e) {
      summary.errors.push(`continueList: ${e?.message || String(e)}`);
      break;
    }
  }

  onProgress({ ...summary });
  return summary;
}
