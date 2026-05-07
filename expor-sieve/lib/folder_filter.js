// lib/folder_filter.js — определение «системных» папок для скрытия в picker'ах.
//
// MailFolder.specialUse в TB 121+ — массив строк, см.
//   https://webextension-api.thunderbird.net/en/mv3/folders.html#mailfolderspecialuse
// Поддерживаемые значения: archives, drafts, inbox, junk, outbox, sent,
// templates, trash. INBOX мы НЕ считаем системной — в неё может потребоваться
// fileinto (например, при разлёте через подпапки).
//
// Fallback для старых аккаунтов (без specialUse) — сравнение path/name по
// набору стандартных имён на разных языках. Регистр игнорируется.

const SYSTEM_SPECIAL_USE = new Set([
  'archives',
  'drafts',
  'junk',
  'outbox',
  'sent',
  'templates',
  'trash',
]);

// Имена системных папок на разных языках. Ключ — lowercase токен, который
// должен ровно совпадать с именем/последним сегментом пути.
//
// Источники: стандартные TB-локали, IMAP NAMESPACE из dovecot/mailcow и
// пара-тройка наиболее часто встречающихся синонимов (юзеры с английским
// клиентом + русскоязычным сервером).
const SYSTEM_FOLDER_NAMES = new Set([
  // English
  'trash', 'deleted', 'deleted items', 'deleted messages',
  'junk', 'junk e-mail', 'junk email', 'spam', 'bulk mail',
  'drafts', 'draft',
  'outbox', 'sent', 'sent items', 'sent mail', 'sent messages',
  'templates', 'template',
  'archive', 'archives', 'all mail',
  // Russian
  'корзина', 'удалённые', 'удаленные', 'удалённое', 'удаленное',
  'спам', 'нежелательная почта',
  'черновики', 'черновик',
  'исходящие', 'отправленные', 'отправленная почта',
  'шаблоны', 'шаблон',
  'архив',
  // German
  'papierkorb', 'gelöscht', 'geloscht', 'mülleimer', 'mulleimer',
  'spam', 'werbung', 'unerwünscht', 'unerwunscht',
  'entwürfe', 'entwurfe', 'entwurf',
  'postausgang', 'gesendet',
  'vorlagen', 'vorlage',
  'archiv',
  // French
  'corbeille',
  'pourriel', 'indésirables', 'indesirables',
  'brouillons', 'brouillon',
  'envoyés', 'envoyes', 'envoyé', 'envoye',
  'modèles', 'modeles',
  'archive', 'archives',
  // Spanish
  'papelera', 'eliminados',
  'correo no deseado', 'no deseado',
  'borradores', 'borrador',
  'bandeja de salida', 'enviados',
  'plantillas', 'plantilla',
  'archivado',
]);

function pathTail(p) {
  if (!p) return '';
  const s = String(p).replace(/^\//, '').replace(/\/$/, '');
  if (!s) return '';
  const i = s.lastIndexOf('/');
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
}

/**
 * Является ли папка «системной» (Trash/Junk/Drafts/Sent/Outbox/Templates/Archives).
 * Inbox и обычные пользовательские папки → false.
 *
 * @param {object|null|undefined} folder MailFolder-подобный {path?, name?, specialUse?}.
 * @returns {boolean}
 */
export function isSystemFolder(folder) {
  if (!folder || typeof folder !== 'object') return false;

  // 1. specialUse (TB 121+).
  const su = folder.specialUse;
  if (Array.isArray(su)) {
    for (const v of su) {
      if (typeof v === 'string' && SYSTEM_SPECIAL_USE.has(v.toLowerCase())) {
        return true;
      }
    }
  } else if (typeof su === 'string') {
    if (SYSTEM_SPECIAL_USE.has(su.toLowerCase())) return true;
  }

  // 2. Legacy type-поле (TB до 121 / некоторые проксированные API).
  if (folder.type) {
    const t = String(folder.type).toLowerCase();
    if (SYSTEM_SPECIAL_USE.has(t)) return true;
  }

  // 3. Fallback — сравнение по name/path-tail с известными именами.
  const name = String(folder.name || '').toLowerCase().trim();
  if (name && SYSTEM_FOLDER_NAMES.has(name)) return true;
  const tail = pathTail(folder.path || '');
  if (tail && SYSTEM_FOLDER_NAMES.has(tail)) return true;

  return false;
}

/**
 * Отфильтровать массив папок, исключив системные.
 * При opts.hideSystemFolders === false возвращает folders без изменений
 * (важно: ту же ссылку, чтобы caller не делал лишних копий).
 *
 * @param {Array} folders
 * @param {{hideSystemFolders?: boolean}} [opts]
 * @returns {Array}
 */
export function filterUsableFolders(folders, opts) {
  if (!Array.isArray(folders)) return [];
  const hide = opts ? opts.hideSystemFolders !== false : true;
  if (!hide) return folders;
  return folders.filter((f) => !isSystemFolder(f));
}
