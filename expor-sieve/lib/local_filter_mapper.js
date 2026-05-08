// lib/local_filter_mapper.js
//
// Преобразование «локальных» фильтров Thunderbird (структура `TBFilter`,
// которую отдаёт Experiment API `browser.exporSieveCredentials.listLocalFilters`)
// в нашу UI-модель Rule (см. `lib/rule_model.js`). Используется фичей
// «Импорт фильтров из Thunderbird» (см. background:listLocalFilters /
// importLocalFilters и Manager toolbar / Options).
//
// Что покрывает (рамки задачи: миграция Quick Filters / встроенных filter
// rules в combined Sieve-script):
//
//   Search-term attrib → field
//     Subject       → subject
//     Sender (From) → from
//     To            → to
//     CC            → cc
//     ToOrCC        → to (с warning'ом, у нас нет общего «to or cc»)
//     OtherHeader   → header (с termname → headerName)
//     Size          → size  (TB передаёт KB; наш UI по умолчанию KB)
//
//   Search-term op → op
//     Contains      → contains
//     DoesntContain → not_contains
//     Is            → is
//     Isnt          → нет прямого аналога — skip term + warning
//     BeginsWith    → starts
//     EndsWith      → ends
//     IsGreaterThan → gt    (для Size)
//     IsLessThan    → lt    (для Size)
//     Matches/DoesntMatch (regexp) → skip + warning
//
//   Action.type → action
//     MoveToFolder  → fileinto(folder)
//     CopyToFolder  → copy(folder)
//     MarkRead      → mark_read
//     MarkFlagged   → flag
//     Delete        → discard           (Sieve `discard;`)
//     Forward       → redirect(address) (с warning'ом — видно отправителю)
//     StopExecution → rule.stopAfter = true
//     AddTag/Reply/JunkScore/MarkUnread/ChangePriority/etc. → skip + warning
//
// Всё что не вписывается — попадает в `warnings`, не падает. Если после
// маппинга у фильтра 0 поддерживаемых условий ИЛИ 0 поддерживаемых
// действий — фильтр считается несовместимым (skipped:true) и не должен
// попадать в default-set чекбоксов в preview-диалоге.

import { newRule } from './rule_model.js';
import { toCanonical } from './folder_path.js';

const TEXT_OP_MAP = {
  Contains: 'contains',
  DoesntContain: 'not_contains',
  Is: 'is',
  BeginsWith: 'starts',
  EndsWith: 'ends',
};
const HEADER_OP_MAP = TEXT_OP_MAP;     // тот же набор операторов
const SIZE_OP_MAP = {
  IsGreaterThan: 'gt',
  IsLessThan: 'lt',
};

const TEXTY_FIELDS = new Set(['Subject', 'Sender', 'To', 'CC', 'ToOrCC']);

/**
 * Маппинг одного term'а. Возвращает { condition, warning, skip }.
 */
function mapTerm(term, ruleName) {
  const attrib = term.attrib || '';
  const op = term.op || '';
  const value = term.value;

  // ─── Subject / From / To / CC / ToOrCC ─────────────────────────────────
  if (TEXTY_FIELDS.has(attrib)) {
    const ourOp = TEXT_OP_MAP[op];
    if (!ourOp) {
      return { skip: true, warning: `«${ruleName}»: оператор ${op} для ${attrib} не поддерживается, условие пропущено.` };
    }
    let field = 'subject';
    let extraWarning = null;
    switch (attrib) {
      case 'Subject':       field = 'subject'; break;
      case 'Sender':        field = 'from'; break;
      case 'To':            field = 'to'; break;
      case 'CC':            field = 'cc'; break;
      case 'ToOrCC':
        field = 'to';
        extraWarning = `«${ruleName}»: условие «To or CC» сведено к «To». Если нужно учитывать CC — добавьте отдельное условие вручную.`;
        break;
    }
    const out = {
      condition: { field, op: ourOp, value: String(value ?? '') },
    };
    if (extraWarning) out.warning = extraWarning;
    return out;
  }

  // ─── OtherHeader (произвольный заголовок) ─────────────────────────────
  if (attrib === 'OtherHeader') {
    const ourOp = HEADER_OP_MAP[op];
    if (!ourOp) {
      return { skip: true, warning: `«${ruleName}»: оператор ${op} для произвольного заголовка не поддерживается, условие пропущено.` };
    }
    const headerName = (term.headerName || '').trim();
    if (!headerName) {
      return { skip: true, warning: `«${ruleName}»: имя заголовка не задано, условие пропущено.` };
    }
    return {
      condition: { field: 'header', headerName, op: ourOp, value: String(value ?? '') },
    };
  }

  // ─── Size — TB хранит число в KB; наш UI по умолчанию KB ──────────────
  if (attrib === 'Size') {
    const ourOp = SIZE_OP_MAP[op];
    if (!ourOp) {
      return { skip: true, warning: `«${ruleName}»: оператор ${op} для размера не поддерживается, условие пропущено.` };
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return { skip: true, warning: `«${ruleName}»: размер «${value}» не распознан, условие пропущено.` };
    }
    return {
      condition: { field: 'size', op: ourOp, value: num, unit: 'KB' },
    };
  }

  // ─── Body / Date / Priority / MsgStatus / Keywords / etc. — не поддерживаем ─
  let humanField = attrib;
  let extra = '';
  switch (attrib) {
    case 'Body':       humanField = 'тело письма'; break;
    case 'Date':       humanField = 'дата'; break;
    case 'Priority':   humanField = 'приоритет'; break;
    case 'MsgStatus':  humanField = 'статус сообщения'; break;
    case 'Keywords':   humanField = 'теги'; extra = ' (теги пока не переносим)'; break;
    case 'AnyText':    humanField = 'любой текст'; break;
    case 'AllAddresses': humanField = 'все адреса'; break;
    case 'AgeInDays':  humanField = 'возраст в днях'; break;
    case 'JunkStatus': humanField = 'статус спама'; break;
    case 'JunkPercent': humanField = 'процент спама'; break;
    case 'JunkScoreOrigin': humanField = 'источник спам-оценки'; break;
    case 'HasAttachmentStatus': humanField = 'наличие вложений'; break;
  }
  return {
    skip: true,
    warning: `«${ruleName}»: условие по полю «${humanField}»${extra} не поддерживается, пропущено.`,
  };
}

/**
 * Маппинг одного action'а. Возвращает { action?, stop?, warning?, skip? }.
 */
function mapAction(action, ruleName) {
  const type = action.type || '';
  switch (type) {
    case 'MoveToFolder': {
      const raw = action.targetFolderPath
        || pathFromUriFallback(action.targetFolderUri)
        || '';
      if (!raw) {
        return { skip: true, warning: `«${ruleName}»: действие «Переместить» без целевой папки, пропущено.` };
      }
      return { action: { type: 'fileinto', folder: toCanonical(raw) } };
    }
    case 'CopyToFolder': {
      const raw = action.targetFolderPath
        || pathFromUriFallback(action.targetFolderUri)
        || '';
      if (!raw) {
        return { skip: true, warning: `«${ruleName}»: действие «Копировать» без целевой папки, пропущено.` };
      }
      return { action: { type: 'copy', folder: toCanonical(raw) } };
    }
    case 'MarkRead':
      return { action: { type: 'mark_read' } };
    case 'MarkFlagged':
      return { action: { type: 'flag' } };
    case 'Delete':
      return { action: { type: 'discard' } };
    case 'Forward': {
      const address = (action.strValue || '').trim();
      if (!address) {
        return { skip: true, warning: `«${ruleName}»: действие «Перенаправить» без адреса, пропущено.` };
      }
      return {
        action: { type: 'redirect', address },
        warning: `«${ruleName}»: «Перенаправить» виден отправителю и трекинг-системам — проверьте получателя.`,
      };
    }
    case 'StopExecution':
      return { stop: true };
    case 'AddTag': {
      // TB хранит keyword метки в strValue (например, '$label1'). Если он
      // пуст — пропускаем (не из чего делать tag-action).
      const raw = (action.strValue || '').trim();
      if (!raw) {
        return { skip: true, warning: `«${ruleName}»: действие «Добавить метку» без значения, пропущено.` };
      }
      // На всякий случай — приводим к виду '$keyword' (если пользователь
      // в TB настроил «голую» метку без $-префикса, считаем custom user-tag).
      const key = raw.startsWith('$') ? raw : ('$' + raw.replace(/[^A-Za-z0-9_]/g, '_'));
      return { action: { type: 'tag', keywords: [key] } };
    }
    // Не поддерживаем (возможно — в будущих версиях):
    case 'Reply':
      return { skip: true, warning: `«${ruleName}»: действие «Ответить шаблоном» не поддерживается, пропущено.` };
    case 'JunkScore':
      return { skip: true, warning: `«${ruleName}»: установка спам-оценки не поддерживается, пропущено.` };
    case 'MarkUnread':
      return { skip: true, warning: `«${ruleName}»: «Отметить как непрочитанное» не поддерживается, пропущено.` };
    case 'MarkUnflagged':
      return { skip: true, warning: `«${ruleName}»: «Снять флажок» не поддерживается, пропущено.` };
    case 'ChangePriority':
      return { skip: true, warning: `«${ruleName}»: изменение приоритета не поддерживается, пропущено.` };
    case 'KillThread':
    case 'KillSubthread':
    case 'WatchThread':
      return { skip: true, warning: `«${ruleName}»: действия с тредами не поддерживаются, пропущено.` };
    case 'DeleteFromPop3Server':
    case 'LeaveOnPop3Server':
    case 'FetchBodyFromPop3Server':
      return { skip: true, warning: `«${ruleName}»: POP3-специфичное действие не поддерживается, пропущено.` };
    case 'Custom':
      return { skip: true, warning: `«${ruleName}»: пользовательское действие не поддерживается, пропущено.` };
    default:
      return { skip: true, warning: `«${ruleName}»: действие «${type}» не поддерживается, пропущено.` };
  }
}

/**
 * Грубый fallback на случай, если Experiment не смог резолвнуть folderUri в
 * path (например, папка не существует локально). Берём всё после
 * `mailbox://user@host/` или `imap://user@host/`.
 */
function pathFromUriFallback(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const m = uri.match(/^[a-z]+:\/\/[^/]+\/(.+)$/i);
  if (!m) return null;
  let p = m[1];
  try { p = decodeURIComponent(p); } catch (_e) { /* keep raw */ }
  return p;
}

/**
 * Преобразует один TBFilter в Rule.
 *
 * @param {object} tbFilter      TBFilter из Experiment API.
 * @param {object} [_opts]       reserved (accountId etc).
 * @returns {{ rule: object|null, warnings: string[], skipped: boolean,
 *            originalName: string, hadStop: boolean }}
 */
export function mapLocalToRule(tbFilter, _opts = {}) {
  const warnings = [];
  const name = (tbFilter && typeof tbFilter.name === 'string' && tbFilter.name)
    ? tbFilter.name
    : '(без имени)';

  if (!tbFilter || !Array.isArray(tbFilter.searchTerms) || !Array.isArray(tbFilter.actions)) {
    return {
      rule: null, warnings: [`«${name}»: фильтр без условий/действий, пропущен.`],
      skipped: true, originalName: name, hadStop: false,
    };
  }

  const conditions = [];
  for (const term of tbFilter.searchTerms) {
    const r = mapTerm(term, name);
    if (r.warning) warnings.push(r.warning);
    if (r.condition) conditions.push(r.condition);
  }

  const actions = [];
  let hadStop = false;
  for (const a of tbFilter.actions) {
    const r = mapAction(a, name);
    if (r.warning) warnings.push(r.warning);
    if (r.action) actions.push(r.action);
    if (r.stop) hadStop = true;
  }

  if (conditions.length === 0 || actions.length === 0) {
    if (conditions.length === 0) {
      warnings.push(`«${name}»: ни одно условие не удалось перенести.`);
    }
    if (actions.length === 0) {
      warnings.push(`«${name}»: ни одно действие не удалось перенести.`);
    }
    return {
      rule: null, warnings,
      skipped: true, originalName: name, hadStop,
    };
  }

  const rule = newRule();
  rule.name = name;
  rule.active = !!tbFilter.enabled;
  rule.matchAll = tbFilter.matchAll !== false;
  rule.conditions = conditions;
  rule.actions = actions;
  // StopExecution в TB ≈ наш stopAfter=true; иначе false — пусть совпадает
  // с поведением исходного TB-фильтра (а не с дефолтом stopAfter=true из
  // newRule()).
  rule.stopAfter = hadStop;

  return { rule, warnings, skipped: false, originalName: name, hadStop };
}

/**
 * Маппинг массива TBFilter → { mapped, skipped, warnings }.
 *
 * @param {object[]} tbFilters
 * @param {object} [opts]
 * @returns {{
 *   mapped: object[],
 *   skipped: object[],
 *   warnings: Array<{name: string, msg: string}>
 * }}
 */
export function mapLocalToRules(tbFilters, opts = {}) {
  const mapped = [];
  const skipped = [];
  const warnings = [];
  if (!Array.isArray(tbFilters)) return { mapped, skipped, warnings };

  for (const tb of tbFilters) {
    const r = mapLocalToRule(tb, opts);
    for (const w of r.warnings) {
      warnings.push({ name: r.originalName, msg: w });
    }
    if (r.skipped) {
      skipped.push(tb);
    } else if (r.rule) {
      mapped.push(r.rule);
    }
  }
  return { mapped, skipped, warnings };
}
