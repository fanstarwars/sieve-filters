# expor-sieve

Add-on for **Thunderbird 128+ / Betterbird** (Manifest V3): manage server-side
Sieve mail filters in mailcow directly from the mail client — no web-UI, no
hand-written Sieve syntax.

The internal codename `expor-sieve` is preserved across files, function
names and the WebExtension id for backward compatibility with existing
installations. The user-facing branding is generic.

---

## User quick-start

1. Install the `.xpi` (Tools → Add-ons → Install from file, or via Enterprise
   Policy — see below).
2. The toolbar shows a Σ icon. Click it to open the list of your server-side
   rules.
3. If there are no rules yet, click "Create the first rule".
4. Fill in the form: name, conditions, actions. Save — the rule is applied on
   the server immediately.
5. Your rules always run server-side, even when Thunderbird is closed.

---

## Administrator install (Enterprise rollout)

The add-on is designed for corporate rollout via **Mozilla Enterprise
Policies**. The middleware URL (`baseUrl`) is configured by policy; the
mailbox password is **picked up automatically from the Thunderbird Login
Manager** via a WebExtension Experiment API (see `experiments/credentials/`).
The user only needs to configure IMAP in TB once — they do not enter their
password into the add-on separately.

If the password is not in the Login Manager (e.g. the user picked "Do not
save" during IMAP setup), the options page lets them enter it manually or
press "Import from Thunderbird" once it has been saved.

> **About the install permission warning (>=0.7.0).** Because of
> `experiment_apis` in the manifest, Thunderbird shows the strong warning
> *"Have full, unrestricted access to Thunderbird, and your computer"*. This
> is normal for Experiment-based extensions and does not mean the add-on
> phones home — the XPCOM code in `experiments/credentials/implementation.js`
> only reads the IMAP/POP3 password on demand from the background script.
> Because of this, the add-on is not published on ATN — distribution is via
> Enterprise Policy + self-hosted xpi.

### Step 1. Deploy middleware `expor-sieve-proxy`

The plugin no longer talks to the mailcow REST API directly — a thin FastAPI
middleware sits between them. It

- authenticates the user with their own mailbox password via Dovecot SASL
  bind;
- whitelists exactly the 5 endpoints the add-on needs;
- inserts the admin `X-API-Key` only after authentication, **inside its own
  container**;
- rejects requests that try to operate on someone else's mailbox.

Full deployment instructions are in
[`../expor-sieve-proxy/DEPLOYMENT.md`](../expor-sieve-proxy/DEPLOYMENT.md).
In short: create an RW X-API-Key in mailcow, run the `expor-sieve-proxy`
container next to mailcow on the same docker network, route
`https://mail.example.com/sieve-proxy/*` through mailcow's nginx to that
container.

The admin X-API-Key never leaves the server perimeter — users do not have
it in their plugin.

### Step 2. Build/download the `.xpi` and host it

```sh
cd expor-sieve
npm install
npm run build         # → ../dist/expor_sieve-<version>.xpi
npm run sign          # sign via addons.thunderbird.net (--channel=unlisted)
```

Place the signed file somewhere reachable, e.g.
`https://example.com/addons/expor-sieve.xpi`.

### Step 3. Distribute `policies.json`

Take [`policies.example.json`](./policies.example.json), set `baseUrl`
(URL of the middleware, **with** `/sieve-proxy` suffix) and `install_url`.
There are no secrets in the policy — only the public middleware URL.

Drop it as `policies.json`:

- **Linux:** `/etc/thunderbird/policies/policies.json`
- **macOS:** `/Library/Preferences/org.mozilla.thunderbird/policies.json`
- **Windows:** registry `HKLM\Software\Policies\Mozilla\Thunderbird`, or
  next to `thunderbird.exe` in `distribution/policies.json`

After Thunderbird restarts, the add-on installs automatically. On the first
server call, the add-on pulls the IMAP password from the TB Login Manager
(Experiment API `exporSieveCredentials.getImapPassword`). The user does not
need to enter anything — their IMAP password is also the middleware
password.

Fallback: if no password is in the Login Manager, the options page shows a
manual-entry field. Such a saved password lives in the profile's
`storage.local` in plain text (just like `nsLoginManager` without a master
password) — your real protection is profile permissions and full-disk
encryption.

---

## Localisation

The add-on ships with English (`_locales/en/`) and Russian
(`_locales/ru/`). Thunderbird auto-selects the locale based on its UI
language; if the UI is in any other language, it falls back to English
(the manifest `default_locale`).

---

## Developer install

```sh
cd expor-sieve
npm install
npm run lint          # web-ext lint
npm run run           # run in dev-Thunderbird (TB Beta or Daily required)
npm test              # vitest
```

Without an Enterprise Policy: open the add-on options page, go to
"Connection" and enter `baseUrl` (URL of the middleware with `/sieve-proxy`
suffix) + mailbox + password manually. This path is for debugging/testing
only.

---

## Architecture

```
manifest.json          — MV3
background.js          — service worker, the only module that does network I/O
lib/
  proxy_client.js      — fetch wrapper around the 6 middleware endpoints (Basic auth)
  sieve_adapter.js     — Rule (our model) ↔ Sieve text
  config_loader.js     — managed (baseUrl) + local (mailbox+password)
  rule_model.js        — Rule/Condition/Action types
manager/               — main filter list window
options/               — options page (separate tab)
wizard/                — "create from message" wizard
editor/                — rule editor (modal/standalone)
_locales/              — i18n (en, ru)
icons/                 — 16/32/128
tests/                 — vitest
policies.example.json  — Enterprise Policy example (baseUrl only)
```

Internal contracts (UI ↔ background message format) are documented at the
top of `background.js`.

---

## "Our-rules" marker

Every rule the add-on creates starts with `# expor-sieve vN managed` on the
first line of the Sieve script. This lets us:

- distinguish the plugin's rules from rules created by hand via mailcow UI;
- coexist safely: the add-on never touches rules without the marker;
- store the display order as `# order: <N>` on the second line (mailcow has
  no native order field).

If the add-on is uninstalled, the rules keep working server-side. The user
can delete them by hand via mailcow UI.

---

## Format v2: Combined Sieve Script

Starting with **0.4.0**, the add-on stores ALL of a user's rules in a
**single** mailcow filter with `active=1`, where `script_data` is a big
Sieve script with all `if`-blocks back-to-back. This works around a mailcow
cascade bug (`add/filter` and `edit/filter` deactivate every other active
filter for the same user; see
[`functions.mailbox.inc.php:276-282 / :2517-2526`](https://github.com/mailcow/mailcow-dockerized)).

Per-rule active-state = `if true { ... }` (active) vs `if false { ... }`
(inactive) wrapper. Rule metadata (id, name, order, active, matchAll,
stopAfter) is stored in comments between blocks.

Example:

```sieve
# expor-sieve v2 managed
require ["fileinto","imap4flags"];

# >>> rule: 9b1c... active=1 order=0 matchAll=1 stopAfter=1
# name: Newsletter to folder
if anyof (
  address :contains "from" "newsletter@",
  address :contains "from" "@news.example.com"
) {
  fileinto "INBOX/Newsletters";
  addflag "\\Flagged";
  stop;
}
# <<< rule: 9b1c...

# >>> rule: 4af2... active=0 order=1 matchAll=1 stopAfter=1
# name: Inactive rule
if false {
  if address :contains "from" "@spam.example.com" {
    fileinto "INBOX/Spam";
    stop;
  }
}
# <<< rule: 4af2...
```

### Migration v1 → v2

Old layout (v1, up to 0.3.x): one Rule = one mailcow filter. On the first
run of 0.4.0 the add-on:

1. Reads all of the user's filters.
2. Parses each `# expor-sieve v1 managed` filter.
3. Creates a **single** new combined v2 filter.
4. Removes the old v1 filters.

Migration is idempotent: if it fails halfway through, the next run finds
the partially-created v2 and removes any remaining v1.

Foreign filters (created via mailcow web-UI without our marker) are
**never** touched.

---

## Out of scope (MVP)

Regex mode, the `*` wildcard, vacation with date ranges, contact
autocomplete, drag-and-drop sorting, Sieve syntax highlighting, ATN
publication, corporate template URL.

---

## Dependencies & GPL compatibility

- Plugin runtime: vanilla JS, no npm dependencies.
- Lucide icons (MIT) — compatible with GPL-3.0-or-later.
- Dev-only: `vitest` (MIT), `web-ext` (MPL-2.0) — used at build/test time
  only, not redistributed.

---

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE) file.
