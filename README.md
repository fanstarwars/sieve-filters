# sieve-filters

Server-side Sieve filter manager for Thunderbird/Betterbird with a self-hosted middleware that talks to a [mailcow-dockerized](https://mailcow.email/) backend. Runs entirely on your own infrastructure — no third-party services, no cloud, no telemetry.

This monorepo contains both halves of the system:

| Path | What it is |
|---|---|
| [`expor-sieve/`](./expor-sieve) | The Thunderbird/Betterbird WebExtension (Manifest V3). Lets users create, edit, reorder, run-on-folder and per-rule activate Sieve filters from inside the mail client. Imports existing local TB filters. Auto-detects IMAP server and password from Thunderbird's Login Manager. |
| [`expor-sieve-proxy/`](./expor-sieve-proxy) | A small FastAPI middleware that runs next to your mailcow stack. Authenticates each user with their own mailcow credentials (Dovecot SASL bind), enforces ownership, federates failed-auth events to mailcow's Fail2Ban, and proxies a strict whitelist of mailcow API endpoints. The mailcow admin API key never leaves the server. |

The plugin only talks to the middleware. The middleware only talks to mailcow. End-users never see the admin API key. The plugin keeps **zero copies of your password** — it reads it live from Thunderbird's Login Manager on every request.

## Why?

mailcow exposes Sieve filter management only through its admin API (one full-access key) and a basic textarea in the web UI. Quick Filters and similar Thunderbird add-ons manage local TB filters, not server-side Sieve. This project closes the gap: a polished Thunderbird UX for serverside Sieve, with a security-correct deployment model on top of mailcow.

## Features (current release — 0.16.1)

- **Full filter editor** with conditions on From / To / Cc / Subject / custom header / size / attachment, the standard operators (contains / is / starts / ends / not contains / contains-any), match-all / match-any, stop-after-this-rule, drag-and-drop reordering with persistence.
- **Eight actions**: move-to-folder, copy-to-folder, mark-as-read, star, **add tags** (multi-select chips with your real Thunderbird tag colours), forward-with-copy, discard, move-to-trash. Cyrillic / Greek / Hebrew folder names work end-to-end.
- **Create filter from message** — right-click any mail → wizard pre-fills the sender / subject / list-id and pre-selects the folder where the message currently lives. Single-window: re-invocation focuses and re-fills the open wizard instead of stacking popups.
- **Apply rule to existing folder** (backfill) — server Sieve runs only at delivery; the plugin can also walk an existing IMAP folder locally through Thunderbird's API and apply a rule to messages that are already there.
- **Sub-folder new-mail counter fix** — workaround for [Bugzilla 1396495](https://bugzilla.mozilla.org/show_bug.cgi?id=1396495). Per-account toggle and per-folder fine-grained control. Uses cheap IMAP `STATUS` (Dovecot serves it from `mailbox_list_index` in microseconds).
- **Multi-account** — every IMAP account in Thunderbird gets its own card. Auto-derived `baseUrl = https://${imap-host}/sieve-proxy`, per-account override available.
- **Password is never stored by the plugin** — read live from Thunderbird's Login Manager via Experiment API. If the master password is locked, the UI shows clear instructions to unlock it (no manual password input form).
- **Import existing local Thunderbird filters** — reads `msgFilterRules.dat`, maps to Sieve, optional cleanup of the local copy.
- **Tested on Thunderbird 128 ESR – 150**, including Ubuntu Snap.
- **364 / 364 unit tests** (sieve_adapter / migration / config_loader / local_runner / local_filter_mapper / wizard_prefs / manager / folder_path / notify_pref).

## Quick start

For end-users (one-time per machine):

1. Install the signed `.xpi` from this repo's Releases page (or build it from source — see [`expor-sieve/README.md`](./expor-sieve/README.md)).
2. The plugin auto-detects your IMAP server and pulls the password from Thunderbird's Login Manager. Open the toolbar icon → start managing rules.

For admins (one-time per mailcow server):

1. Create a read-write API key in mailcow with IP allow-list `172.22.1.0/24` (and optionally the IPv6 docker subnet).
2. `git clone https://github.com/fanstarwars/sieve-filters.git && cd sieve-filters/expor-sieve-proxy`
3. `sudo MAILCOW_API_KEY="<key>" ./install.sh`

Full deployment details: [`expor-sieve-proxy/DEPLOYMENT.md`](./expor-sieve-proxy/DEPLOYMENT.md).

## Architecture

```
Thunderbird (any machine)
  └── expor-sieve plugin
        └── HTTPS Basic auth (user mailcow password)
              └── mailcow nginx /sieve-proxy/v1/*
                    └── expor-sieve-proxy (FastAPI)
                          ├── Dovecot SASL bind for auth
                          ├── F2B publish on failed auth
                          └── X-API-Key → mailcow REST
```

All filters of a given user/account collapse into a single mailcow `sieve_filters` row (combined Sieve script with v2 markers). This works around mailcow's "only one active filter per user" cascade behavior at the data-model level.

## Repository layout

```
sieve-filters/
├── README.md            ← you are here
├── LICENSE              ← GPL-3.0-or-later
├── TZ.md                ← detailed plugin spec (Russian)
├── TZ-middleware.md     ← detailed middleware spec (Russian)
├── TZ-UI-v2.md          ← UI spec (Russian)
├── expor-sieve/         ← Thunderbird WebExtension
└── expor-sieve-proxy/   ← FastAPI middleware
```

The internal codename `expor-sieve` is preserved across paths/identifiers/test fixtures for backward compatibility with installations that pre-date the public release.

## License

GPL-3.0-or-later. See `LICENSE`.

All runtime dependencies are MIT/BSD/Apache-2.0 — fully compatible with GPL-3.0.

## Status

Production-ready (0.16.1). Storage layout `schema_version 3`, combined Sieve script `# expor-sieve v2 managed`, both stable since 0.15.0. Auto-migration paths from earlier schemas are covered.

Production-tested on mailcow 2026-03b with Thunderbird 140 ESR (Ubuntu Snap), 128 ESR (Linux deb), 150 (Windows). Latest changes ride along with `messagesTagsList` permission for the new tag-picker (added in 0.16.1).
