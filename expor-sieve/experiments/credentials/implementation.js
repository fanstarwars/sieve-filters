/* experiments/credentials/implementation.js
 *
 * WebExtension Experiment API: exporSieveCredentials.getImapPassword(accountId).
 *
 * Read-only XPCOM glue that resolves the saved IMAP/POP3 password for a given
 * WebExtension accountId and returns it to the extension. Used to skip the
 * "enter your IMAP password" step in the options page when Thunderbird already
 * has it in its Login Manager (the common case after IMAP setup).
 *
 * Permission warning is amplified ("Have full, unrestricted access to all
 * Thunderbird data") because XPCOM access is unscoped. Acceptable for our
 * Enterprise Policy / self-hosted xpi distribution. NOT for ATN.
 *
 * Implementation strategy:
 *   1. Resolve `nsIMsgAccount` via MailServices.accounts.getAccount(accountId).
 *   2. Read its `incomingServer` (nsIMsgIncomingServer).
 *   3. Reject anything other than imap/pop3 — Sieve only makes sense for those.
 *   4. Call `incomingServer.password` (the cached in-memory copy) — non-blocking,
 *      no UI. If empty, fall through to `Services.logins.findLogins(...)` with
 *      the same hostname/realm pair Thunderbird itself uses, so we get the
 *      stored value even when the user has not unlocked the account yet
 *      this session.
 *   5. Never trigger a master-password prompt: we explicitly avoid
 *      `getPasswordWithUI()` and we wrap everything in try/catch so a locked
 *      Login Manager just yields null.
 *   6. Always return null on any failure path. Never throw — caller treats
 *      null as "no password available, fall back to manual entry".
 *
 * Refs:
 *   - https://webextension-api.thunderbird.net/en/mv3/how-to/experiments.html
 *   - https://searchfox.org/comm-central/source/mailnews/base/src/MailServices.sys.mjs
 *   - https://searchfox.org/comm-central/source/mailnews/base/public/nsIMsgAccountManager.idl
 *   - https://searchfox.org/comm-central/source/mailnews/base/public/nsIMsgIncomingServer.idl
 *   - kkapsner/keepassxc-mail experiment/implementation.js (reference pattern)
 */

"use strict";

// docs: https://webextension-api.thunderbird.net/en/mv3/how-to/experiments.html
//   Implementation files run in chrome scope. ExtensionCommon, ChromeUtils,
//   and Components are available without explicit imports.

// В TB 140 ESR `resource://gre/modules/Services.sys.mjs` не существует
// (раньше переезжал из toolkit/modules/Services.jsm в .sys.mjs, но не во всех
// сборках). При этом `Services` в большинстве chrome-контекстов есть глобально
// (через ext-injection). Делаем robust-resolution: глобал → ESM → JSM.
let Services;
try {
  Services = globalThis.Services;
} catch (_e) { /* ignore */ }
if (!Services) {
  try {
    Services = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs").Services;
  } catch (_e) { /* old TB without ESM path */ }
}
if (!Services) {
  try {
    Services = ChromeUtils.import("resource://gre/modules/Services.jsm").Services;
  } catch (_e) { /* very old TB */ }
}

// docs: https://searchfox.org/comm-central/source/mailnews/base/src/MailServices.sys.mjs
//   MailServices.accounts is XPCOMUtils.defineLazyServiceGetter(...,
//   "@mozilla.org/messenger/account-manager;1", Ci.nsIMsgAccountManager).
let MailServices;
try {
  MailServices = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs",
  ).MailServices;
} catch (_e) {
  try {
    MailServices = ChromeUtils.import(
      "resource:///modules/MailServices.jsm",
    ).MailServices;
  } catch (_e2) { /* impossibly old TB */ }
}

const LOG_PREFIX = "[expor-sieve][exp]";

function logWarn(...args) {
  try {
    // eslint-disable-next-line no-console
    console.warn(LOG_PREFIX, ...args);
  } catch (_e) {
    /* ignore */
  }
}

/**
 * Try the cheapest path first: nsIMsgIncomingServer.password is the in-memory
 * decrypted copy that Thunderbird populates after the user has logged into
 * IMAP at least once this session. No UI, no master-password prompt.
 *
 * docs: https://searchfox.org/comm-central/source/mailnews/base/public/nsIMsgIncomingServer.idl
 *   attribute AString password;
 */
function readCachedServerPassword(server) {
  try {
    const pw = server.password;
    if (typeof pw === "string" && pw.length > 0) return pw;
  } catch (e) {
    logWarn("incomingServer.password threw:", e?.message || e);
  }
  return null;
}

/**
 * Fallback: walk Services.logins for stored credentials with the same realm
 * Thunderbird itself uses. The realm is `mailbox://hostname` for POP3 and
 * `imap://hostname` for IMAP — but historical TB versions used the bare
 * `serverURI` too, so we try both.
 *
 * docs: https://searchfox.org/mozilla-central/source/toolkit/components/passwordmgr/nsILoginManager.idl
 *   Array<nsILoginInfo> findLogins(in AString aHostname,
 *                                  in AString aActionURL,
 *                                  in AString aHttpRealm);
 *   For mail accounts Thunderbird passes ("imap://host" or "mailbox://host",
 *   null, "<serverURI>") — see comm-central msgIncomingServer.cpp.
 */
function readStoredLogin(server) {
  let candidates = [];
  try {
    const hostname = server.hostName || "";
    const proto = (server.type || "").toLowerCase(); // "imap" / "pop3"
    if (!hostname) return null;
    const schemeHost =
      proto === "imap" ? `imap://${hostname}` : `mailbox://${hostname}`;
    let serverURI = "";
    try {
      serverURI = server.serverURI || "";
    } catch (_e) {
      /* some legacy servers omit it */
    }
    candidates.push([schemeHost, serverURI]);
    if (serverURI && serverURI !== schemeHost) {
      candidates.push([serverURI, ""]);
    }
  } catch (e) {
    logWarn("server attrs threw:", e?.message || e);
    return null;
  }

  for (const [hostnameArg, realmArg] of candidates) {
    let logins = [];
    try {
      // 3-arg form is the historic signature still supported in TB 128+.
      logins = Services.logins.findLogins(hostnameArg, null, realmArg) || [];
    } catch (e) {
      logWarn("findLogins(", hostnameArg, ",", realmArg, ") threw:", e?.message || e);
      continue;
    }
    if (!logins.length) continue;

    // Prefer an entry whose username matches what TB uses to authenticate.
    let serverUser = "";
    try {
      serverUser = (server.username || server.realUsername || "").toLowerCase();
    } catch (_e) {
      /* ignore */
    }
    let chosen = null;
    if (serverUser) {
      chosen = logins.find(
        (l) => (l.username || "").toLowerCase() === serverUser,
      );
    }
    chosen = chosen || logins[0];
    if (chosen && typeof chosen.password === "string" && chosen.password.length > 0) {
      return chosen.password;
    }
  }
  return null;
}

/**
 * Resolve nsIMsgIncomingServer for a WebExtension accountId.
 *
 * docs: https://searchfox.org/comm-central/source/mailnews/base/public/nsIMsgAccountManager.idl
 *   nsIMsgAccount getAccount(in AUTF8String key);
 *   The WebExtension accountId IS the internal account key — confirmed by
 *   comm-central extension-accounts.js which round-trips the same string.
 * docs: https://searchfox.org/comm-central/source/mailnews/base/public/nsIMsgIncomingServer.idl
 *   readonly attribute AString hostName;
 *   readonly attribute long    port;
 *   readonly attribute ACString type;       // "imap" / "pop3" / ...
 *   attribute          AString username;
 *   readonly attribute AString realUsername; // resolved login username
 *
 * Returns the server, or null on any failure. Never throws.
 */
function resolveIncomingServer(accountId) {
  let account = null;
  try {
    account = MailServices.accounts.getAccount(accountId);
  } catch (e) {
    logWarn("getAccount(", accountId, ") threw:", e?.message || e);
    return null;
  }
  if (!account) return null;

  let server = null;
  try {
    server = account.incomingServer;
  } catch (e) {
    logWarn("incomingServer threw:", e?.message || e);
    return null;
  }
  return server || null;
}

// ──────────────────────────────────────────────────────────────────────────
// Local-filter introspection (TB msgFilterRules.dat → JSON).
//
// Used by `listLocalFilters(accountId)` for the «Импорт фильтров из
// Thunderbird» feature. We DO NOT mutate the local filter list here —
// read-only projection only.
//
// docs (XPCOM IDL refs — values are static enum integers):
//   nsMsgSearchAttrib:
//     https://searchfox.org/comm-central/source/mailnews/search/public/nsMsgSearchCore.idl
//   nsMsgSearchOp:
//     https://searchfox.org/comm-central/source/mailnews/search/public/nsMsgSearchCore.idl
//   nsMsgFilterAction:
//     https://searchfox.org/comm-central/source/mailnews/search/public/nsMsgFilterCore.idl
//   nsIMsgFilterList:
//     https://searchfox.org/comm-central/source/mailnews/search/public/nsIMsgFilterList.idl
//   nsIMsgFilter / nsIMsgRuleAction:
//     https://searchfox.org/comm-central/source/mailnews/search/public/nsIMsgFilter.idl
//   nsIMsgSearchTerm:
//     https://searchfox.org/comm-central/source/mailnews/search/public/nsIMsgSearchTerm.idl
//   nsIFolderLookupService:
//     https://searchfox.org/comm-central/source/mailnews/base/public/nsIFolderLookupService.idl
//
// nsIMsgFilter has no global matchAll attribute — matchAll/matchAny is
// encoded per-search-term via `term.booleanAnd`. We mirror that into our
// projected struct so the mapper can pick allof/anyof per filter.
// ──────────────────────────────────────────────────────────────────────────

// Reverse-map nsMsgSearchAttrib integer → ASCII name.
// docs: https://searchfox.org/comm-central/source/mailnews/search/public/nsMsgSearchCore.idl
function searchAttribName(intVal) {
  const A = Ci.nsMsgSearchAttrib;
  if (!A) return String(intVal);
  const known = [
    "Custom", "Default", "Subject", "Sender", "Body", "Date", "Priority",
    "MsgStatus", "To", "CC", "ToOrCC", "AllAddresses", "Location",
    "MessageKey", "AgeInDays", "FolderInfo", "Size", "AnyText", "Keywords",
    "JunkStatus", "JunkPercent", "JunkScoreOrigin", "HdrProperty",
    "FolderFlag", "Uint32HdrProperty", "OtherHeader", "HasAttachmentStatus",
  ];
  for (const k of known) {
    if (typeof A[k] === "number" && A[k] === intVal) return k;
  }
  return `Attr_${intVal}`;
}

// Reverse-map nsMsgSearchOp integer → ASCII name.
// docs: https://searchfox.org/comm-central/source/mailnews/search/public/nsMsgSearchCore.idl
function searchOpName(intVal) {
  const O = Ci.nsMsgSearchOp;
  if (!O) return String(intVal);
  const known = [
    "Contains", "DoesntContain", "Is", "Isnt", "IsEmpty", "IsntEmpty",
    "BeginsWith", "EndsWith", "IsBefore", "IsAfter", "IsHigherThan",
    "IsLowerThan", "IsGreaterThan", "IsLessThan", "Matches", "DoesntMatch",
    "SoundsLike", "LdapDwim", "NameCompletion", "IsInAB", "IsntInAB",
  ];
  for (const k of known) {
    if (typeof O[k] === "number" && O[k] === intVal) return k;
  }
  return `Op_${intVal}`;
}

// Reverse-map nsMsgFilterAction integer → ASCII name.
// docs: https://searchfox.org/comm-central/source/mailnews/search/public/nsMsgFilterCore.idl
function filterActionName(intVal) {
  const F = Ci.nsMsgFilterAction;
  if (!F) return String(intVal);
  const known = [
    "Custom", "None", "MoveToFolder", "ChangePriority", "Delete", "MarkRead",
    "KillThread", "WatchThread", "MarkFlagged", "Label" /* legacy */, "Reply",
    "Forward", "StopExecution", "DeleteFromPop3Server", "LeaveOnPop3Server",
    "JunkScore", "FetchBodyFromPop3Server", "CopyToFolder", "AddTag",
    "KillSubthread", "MarkUnread",
  ];
  for (const k of known) {
    if (typeof F[k] === "number" && F[k] === intVal) return k;
  }
  return `Action_${intVal}`;
}

/**
 * Resolve a TB folder URI (`imap://user%40host@host/INBOX/FESCO`) to the
 * server-relative IMAP path `INBOX/FESCO`. Walks up via folder.parent so
 * nested paths survive. On any failure returns null.
 *
 * docs: https://searchfox.org/comm-central/source/mailnews/base/public/nsIFolderLookupService.idl
 *   nsIMsgFolder getFolderForURL(in AUTF8String uri);
 */
function folderUriToPath(uri) {
  if (!uri || typeof uri !== "string") return null;
  let folder = null;
  try {
    if (MailServices && MailServices.folderLookup
        && typeof MailServices.folderLookup.getFolderForURL === "function") {
      folder = MailServices.folderLookup.getFolderForURL(uri);
    }
  } catch (_e) { /* fall through to URI parse */ }

  if (folder) {
    try {
      const parts = [];
      let cur = folder;
      // Walk up; root server folder has no displayable name in path.
      // Stop when we hit a folder whose parent is null (server root).
      while (cur && cur.parent) {
        parts.unshift(cur.name || "");
        cur = cur.parent;
      }
      const path = parts.filter(Boolean).join("/");
      if (path) return path;
    } catch (_e) { /* fall back */ }
  }

  // Fallback: parse the URI ourselves. Strip scheme + authority, decode.
  try {
    const m = String(uri).match(/^[a-z]+:\/\/[^/]+\/(.+)$/i);
    if (m && m[1]) {
      let p = m[1];
      try { p = decodeURIComponent(p); } catch (_e) { /* keep raw */ }
      return p;
    }
  } catch (_e) { /* ignore */ }
  return null;
}

/**
 * Project a single nsIMsgSearchTerm into a JSON-safe object.
 */
function projectSearchTerm(term) {
  let attrib = "";
  let op = "";
  let value = "";
  let headerName = null;
  let booleanAnd = true;
  try { attrib = searchAttribName(term.attrib); } catch (_e) {}
  try { op = searchOpName(term.op); } catch (_e) {}
  try { booleanAnd = !!term.booleanAnd; } catch (_e) {}
  try {
    const headerNameRaw = term.arbitraryHeader;
    if (headerNameRaw && typeof headerNameRaw === "string") {
      headerName = headerNameRaw;
    }
  } catch (_e) { /* not present for non-OtherHeader */ }

  // nsIMsgSearchValue: discriminated union — read the field that matches
  // this attrib. For most string-y attribs `value.str` works; for size
  // it's `value.size`; for date `value.date` (PRTime/μs).
  // docs: https://searchfox.org/comm-central/source/mailnews/search/public/nsIMsgSearchValue.idl
  try {
    const v = term.value;
    if (v) {
      try {
        if (typeof v.str === "string" && v.str.length) {
          value = v.str;
        }
      } catch (_e) {}
      if (!value) {
        try {
          if (typeof v.size === "number" && Number.isFinite(v.size)) {
            value = String(v.size);
          }
        } catch (_e) {}
      }
      if (!value) {
        try {
          if (typeof v.priority === "number") value = String(v.priority);
        } catch (_e) {}
      }
      if (!value) {
        try {
          if (typeof v.status === "number") value = String(v.status);
        } catch (_e) {}
      }
    }
  } catch (_e) { /* ignore */ }

  const out = {
    attrib,
    op,
    value,
    booleanAnd,
  };
  if (headerName) out.headerName = headerName;
  return out;
}

/**
 * Project a single nsIMsgRuleAction into a JSON-safe object.
 */
function projectAction(action) {
  let typeName = "";
  let targetFolderUri = null;
  let targetFolderPath = null;
  let strValue = null;
  let priority = null;

  try { typeName = filterActionName(action.type); } catch (_e) {}
  try {
    const u = action.targetFolderUri;
    if (typeof u === "string" && u.length) {
      targetFolderUri = u;
      targetFolderPath = folderUriToPath(u);
    }
  } catch (_e) { /* not present for non-Move/Copy */ }
  try {
    const s = action.strValue;
    if (typeof s === "string" && s.length) strValue = s;
  } catch (_e) { /* not present for some action types */ }
  try {
    if (typeof action.priority === "number") priority = action.priority;
  } catch (_e) {}

  const out = { type: typeName };
  if (targetFolderUri) out.targetFolderUri = targetFolderUri;
  if (targetFolderPath) out.targetFolderPath = targetFolderPath;
  if (strValue) out.strValue = strValue;
  if (priority != null) out.priority = priority;
  return out;
}

/**
 * Determine matchAll for a filter from its searchTerms.
 *
 * Convention used by TB UI: if every term (except the first) has
 * `booleanAnd=true`, the filter is "Match all of the following" (AND).
 * Mixing OR on any non-first term means "Match any" — TB UI doesn't allow
 * mixed boolean within a single filter, but we play safe.
 */
function deduceMatchAll(termsArr) {
  if (!termsArr || termsArr.length <= 1) return true;
  // First term's booleanAnd is irrelevant; check the rest.
  for (let i = 1; i < termsArr.length; i++) {
    if (termsArr[i].booleanAnd === false) return false;
  }
  return true;
}

/**
 * Project the full nsIMsgFilterList of a server into TBFilter[].
 * Returns [] on any failure.
 */
function projectFilterList(server) {
  let list = null;
  try {
    list = server.getFilterList(null);
  } catch (e) {
    logWarn("server.getFilterList threw:", e?.message || e);
    return [];
  }
  if (!list) return [];

  let count = 0;
  try { count = Number(list.filterCount) || 0; } catch (_e) { return []; }
  const out = [];
  for (let i = 0; i < count; i++) {
    let f;
    try { f = list.getFilterAt(i); } catch (_e) { continue; }
    if (!f) continue;

    let name = "";
    let enabled = false;
    try { name = String(f.filterName || ""); } catch (_e) {}
    try { enabled = !!f.enabled; } catch (_e) {}

    // searchTerms is nsIMutableArray of nsIMsgSearchTerm.
    const terms = [];
    try {
      const arr = f.searchTerms;
      // Prefer Array.from over enumerator dance — nsIMutableArray supports
      // QueryElementAt and length in TB 128+ (it's actually XPCOM Array<>).
      let len = 0;
      try { len = Number(arr.length) || 0; } catch (_e) { len = 0; }
      if (!len && typeof arr.queryElementAt === "function") {
        // Fallback for legacy nsIArray.
        try { len = Number(arr.length) || 0; } catch (_e) {}
      }
      for (let j = 0; j < len; j++) {
        let term;
        try {
          term = (typeof arr.queryElementAt === "function")
            ? arr.queryElementAt(j, Ci.nsIMsgSearchTerm)
            : arr[j];
        } catch (_e) { continue; }
        if (!term) continue;
        try { terms.push(projectSearchTerm(term)); } catch (_e) { /* skip */ }
      }
    } catch (e) {
      logWarn("searchTerms iter failed:", e?.message || e);
    }

    const actions = [];
    try {
      const arr = f.actionList || f.sortedActionList;
      let len = 0;
      try { len = Number(arr.length) || 0; } catch (_e) { len = 0; }
      for (let j = 0; j < len; j++) {
        let a;
        try {
          a = (typeof arr.queryElementAt === "function")
            ? arr.queryElementAt(j, Ci.nsIMsgRuleAction)
            : arr[j];
        } catch (_e) { continue; }
        if (!a) continue;
        try { actions.push(projectAction(a)); } catch (_e) { /* skip */ }
      }
    } catch (e) {
      logWarn("actionList iter failed:", e?.message || e);
    }

    out.push({
      name,
      enabled,
      matchAll: deduceMatchAll(terms),
      searchTerms: terms,
      actions,
    });
  }
  return out;
}

// docs: https://webextension-api.thunderbird.net/en/mv3/how-to/experiments.html
//   The exported class name MUST match the namespace defined in schema.json
//   (`exporSieveCredentials`) — the framework instantiates it by that name.
this.exporSieveCredentials = class extends ExtensionCommon.ExtensionAPI {
  getAPI(_context) {
    return {
      exporSieveCredentials: {
        async getImapPassword(accountId) {
          if (typeof accountId !== "string" || !accountId) return null;

          const server = resolveIncomingServer(accountId);
          if (!server) return null;

          // Only IMAP and POP3 carry the kind of credentials we can re-use as
          // ManageSieve / mailcow basic-auth. EWS/NNTP/RSS/none → null.
          let serverType = "";
          try {
            serverType = (server.type || "").toLowerCase();
          } catch (_e) {
            /* ignore */
          }
          if (serverType !== "imap" && serverType !== "pop3") return null;

          const cached = readCachedServerPassword(server);
          if (cached) return cached;

          const stored = readStoredLogin(server);
          if (stored) return stored;

          return null;
        },

        /**
         * Return non-secret incomingServer attributes for accountId. Used to
         * auto-derive the middleware base URL `https://${hostname}/sieve-proxy`.
         *
         * Only IMAP/POP3 accounts are supported — for other types we return
         * null so the caller falls back to manual configuration.
         *
         * Pure synchronous XPCOM getters: never blocks, never opens a
         * master-password prompt, never throws.
         */
        async getServerInfo(accountId) {
          if (typeof accountId !== "string" || !accountId) return null;

          const server = resolveIncomingServer(accountId);
          if (!server) return null;

          let hostname = "";
          let port = 0;
          let serverType = "";
          let username = "";
          try {
            // docs: https://searchfox.org/comm-central/source/mailnews/base/public/nsIMsgIncomingServer.idl
            hostname = String(server.hostName || "");
          } catch (e) {
            logWarn("server.hostName threw:", e?.message || e);
          }
          try {
            port = Number(server.port || 0);
          } catch (e) {
            logWarn("server.port threw:", e?.message || e);
          }
          try {
            serverType = String(server.type || "").toLowerCase();
          } catch (_e) { /* ignore */ }
          try {
            // realUsername falls back to username when not separately set.
            username = String(server.realUsername || server.username || "");
          } catch (_e) { /* ignore */ }

          if (serverType !== "imap" && serverType !== "pop3") return null;
          if (!hostname) return null;

          // hostnameOrIp is a forward-compat field that today equals hostname.
          // Reserved for a future split when we want to distinguish a literal
          // IP from a DNS hostname (e.g. for SNI-aware URL derivation).
          return {
            hostname,
            port,
            type: serverType,
            username,
            hostnameOrIp: hostname,
          };
        },

        /**
         * Enumerate local TB filters for the account and project them into
         * a JSON-safe array of TBFilter objects. See class-doc above for
         * format and references.
         *
         * Returns [] on any error path. Never throws; never opens a master-
         * password prompt (we don't touch passwords here at all).
         */
        async listLocalFilters(accountId) {
          if (typeof accountId !== "string" || !accountId) return [];
          const server = resolveIncomingServer(accountId);
          if (!server) return [];

          // Sieve only makes sense for IMAP / POP3. Some account types
          // (EWS, NNTP) also have filter lists but our middleware contract
          // is mailcow-Sieve so we restrict here.
          let serverType = "";
          try {
            serverType = (server.type || "").toLowerCase();
          } catch (_e) { /* ignore */ }
          if (serverType !== "imap" && serverType !== "pop3") return [];

          try {
            return projectFilterList(server);
          } catch (e) {
            logWarn("listLocalFilters projection threw:", e?.message || e);
            return [];
          }
        },
      },
    };
  }
};
