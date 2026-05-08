// templates.js — шаблоны Wizard'а.
// Каждый шаблон знает, как заполнить draft Rule на основе message-meta.
//
// API шаблона:
//   {
//     id: string,
//     titleKey: i18n key,
//     descKey: i18n key (description),
//     canApplyWithoutMessage: boolean (показать ли в Manager-меню «Создать… ▾»)
//     supports(meta, opts): boolean — доступен ли при текущем письме
//     apply(rule, meta, folders, opts): void — мутирует rule
//     disabled: boolean (для post-MVP — серый пункт меню)
//     disabledKey: i18n key для tooltip
//   }
//
// opts (в supports/apply): объект с per-call контекстом:
//   - ownEmails: string[]   — нормализованный (lowercase) набор «своих» адресов;
//   - prefs:     WizardPrefs — поведенческие настройки (см. lib/wizard_prefs.js).

import { defaultAction } from './actions.js';
import { cleanSubjectForName, DEFAULTS as PREF_DEFAULTS } from '../lib/wizard_prefs.js';
import { t } from '../lib/rule_form.js';
import { toCanonical } from '../lib/folder_path.js';

function trunc(s, n) {
  s = String(s || '').trim();
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

// Парсит "Иван Андреев <ivan@example.com>" → "ivan@example.com".
// Если без угловых скобок — просто возвращает trim.
function extractEmail(s) {
  s = String(s || '').trim();
  const m = s.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  return s;
}

function extractDomain(email) {
  const at = String(email || '').lastIndexOf('@');
  if (at < 0) return '';
  return email.slice(at + 1).trim().replace(/[>"\s]+$/, '');
}

// Из строки "to: a@x, b@y" / "Иван <i@x>, Петр <p@y>" → массив email'ов.
function splitAddressList(s) {
  return String(s || '')
    .split(/[,;]/)
    .map((x) => extractEmail(x))
    .filter(Boolean);
}

// Берёт первый recipient из meta.recipients, который НЕ входит в ownEmails.
// Если все «свои» (или recipients пусто) — возвращает ''.
function pickNonOwnRecipient(meta, ownSet) {
  const list = splitAddressList(meta && meta.recipients);
  for (const r of list) {
    if (!ownSet.has(String(r).toLowerCase())) return r;
  }
  return '';
}

function getPrefs(opts) {
  const p = opts && opts.prefs;
  return p || PREF_DEFAULTS;
}

function getOwnSet(opts) {
  const arr = (opts && Array.isArray(opts.ownEmails)) ? opts.ownEmails : [];
  return new Set(arr.map((e) => String(e || '').toLowerCase()));
}

export const TEMPLATES = [
  {
    id: 'sender',
    titleKey: 'wiz_template_sender',
    descKey: 'wiz_template_sender_desc',
    canApplyWithoutMessage: false,
    supports: (m) => !!extractEmail(m?.author),
    apply(rule, meta /* , folders, opts */) {
      const email = extractEmail(meta?.author);
      rule.name = t('wiz_name_sender', [email]);
      rule.conditions = [{ field: 'from', op: 'contains', value: email }];
    },
  },
  {
    id: 'domain',
    titleKey: 'wiz_template_domain',
    descKey: 'wiz_template_domain_desc',
    canApplyWithoutMessage: false,
    supports: (m) => !!extractDomain(extractEmail(m?.author)),
    apply(rule, meta) {
      const dom = extractDomain(extractEmail(meta?.author));
      rule.name = t('wiz_name_domain', [dom]);
      rule.conditions = [{ field: 'from', op: 'contains', value: '@' + dom }];
    },
  },
  {
    id: 'recipient',
    titleKey: 'wiz_template_recipient',
    descKey: 'wiz_template_recipient_desc',
    canApplyWithoutMessage: false,
    disabledKey: 'wiz_template_recipient_disabled_own',
    supports: (m, opts) => {
      // Базовая доступность — нужен хоть какой-то адрес.
      const fallback = extractEmail(m?.author);
      const recipientList = splitAddressList(m?.recipients);
      const candidate = recipientList[0] || fallback;
      if (!candidate) return false;

      const prefs = getPrefs(opts);
      if (!prefs.excludeOwnAddresses) return true;

      const ownSet = getOwnSet(opts);
      if (ownSet.size === 0) return true;

      // Если есть recipient, не входящий в ownEmails — поддерживаем шаблон
      // (apply возьмёт именно его).
      const nonOwn = pickNonOwnRecipient(m, ownSet);
      if (nonOwn) return true;

      // Иначе fallback — это адрес автора (or единственный recipient).
      // Если он сам не «свой» — допустимо.
      const fb = String(fallback).toLowerCase();
      if (fb && !ownSet.has(fb)) return true;

      return false;
    },
    apply(rule, meta, _folders, opts) {
      const prefs = getPrefs(opts);
      const ownSet = getOwnSet(opts);

      let email = '';
      if (prefs.excludeOwnAddresses && ownSet.size > 0) {
        email = pickNonOwnRecipient(meta, ownSet);
      }
      if (!email) {
        // Если все recipient'ы — свои, или excludeOwnAddresses=false:
        // прежнее поведение — берём автора (это поведение существовало до v0.10).
        const recipientList = splitAddressList(meta && meta.recipients);
        email = recipientList[0] || extractEmail(meta?.author);
      }

      rule.name = t('wiz_name_recipient', [email]);
      rule.conditions = [{ field: 'to', op: 'contains', value: email }];
    },
  },
  {
    id: 'replyTo',
    titleKey: 'wiz_template_reply_to',
    descKey: 'wiz_template_reply_to_desc',
    canApplyWithoutMessage: false,
    supports: (m) => !!m?.replyTo,
    disabledKey: 'wiz_template_no_reply_to',
    apply(rule, meta) {
      const v = String(meta?.replyTo || '').trim();
      rule.name = t('wiz_name_reply_to', [extractEmail(v)]);
      rule.conditions = [{ field: 'header', headerName: 'Reply-To', op: 'contains', value: extractEmail(v) }];
    },
  },
  {
    id: 'subject',
    titleKey: 'wiz_template_subject',
    descKey: 'wiz_template_subject_desc',
    canApplyWithoutMessage: false,
    supports: (m) => !!m?.subject,
    apply(rule, meta, _folders, opts) {
      const prefs = getPrefs(opts);
      const rawSub = String(meta?.subject || '').trim();
      const cleaned = prefs.stripSubjectPrefixes
        ? cleanSubjectForName(rawSub, prefs.subjectPrefixes)
        : rawSub;
      const v = trunc(cleaned, 50);
      rule.name = t('wiz_name_subject', [trunc(cleaned, 40)]);
      rule.conditions = [{ field: 'subject', op: 'contains', value: v }];
    },
  },
  {
    id: 'list',
    titleKey: 'wiz_template_list',
    descKey: 'wiz_template_list_desc',
    canApplyWithoutMessage: false,
    supports: (m) => !!m?.listId,
    disabledKey: 'wiz_template_no_list_id',
    apply(rule, meta) {
      const v = String(meta?.listId || '').trim();
      rule.name = t('wiz_name_list');
      rule.conditions = [{ field: 'header', headerName: 'List-Id', op: 'contains', value: v }];
    },
  },
  {
    id: 'tags',
    titleKey: 'wiz_template_tags',
    descKey: 'wiz_template_tags_desc',
    canApplyWithoutMessage: false,
    supports: () => false,           // disabled в MVP
    disabled: true,
    disabledKey: 'wiz_template_tags_disabled',
    apply() { /* no-op */ },
  },
];

export function applyActionsToRule(rule, opts, folders) {
  // opts: { fileinto: bool, tags: bool, important: bool, star: bool, flag: bool }
  rule.actions = [];
  if (opts.fileinto) {
    const folder = toCanonical(opts.folder || folders?.[0]?.path);
    rule.actions.push({ type: 'fileinto', folder });
  }
  if (opts.star || opts.flag) {
    rule.actions.push({ type: 'flag' });
  }
  if (rule.actions.length === 0) {
    rule.actions.push(defaultAction(folders));
  }
}
