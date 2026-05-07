# sieve-filters

Server-side Sieve filter manager for Thunderbird/Betterbird with a self-hosted middleware that talks to a [mailcow-dockerized](https://mailcow.email/) backend. Runs entirely on your own infrastructure — no third-party services, no cloud, no telemetry.

This monorepo contains both halves of the system:

| Path | What it is |
|---|---|
| [`expor-sieve/`](./expor-sieve) | The Thunderbird/Betterbird WebExtension (Manifest V3). Lets users create, edit, reorder, run-on-folder and per-rule activate Sieve filters from inside the mail client. Imports existing local TB filters. Auto-detects IMAP server and password from Thunderbird's Login Manager. |
| [`expor-sieve-proxy/`](./expor-sieve-proxy) | A small FastAPI middleware that runs next to your mailcow stack. Authenticates each user with their own mailcow credentials (Dovecot SASL bind), enforces ownership, federates failed-auth events to mailcow's Fail2Ban, and proxies a strict whitelist of mailcow API endpoints. The mailcow admin API key never leaves the server. |

The plugin only talks to the middleware. The middleware only talks to mailcow. End-users never see the admin API key.

## Why?

mailcow exposes Sieve filter management only through its admin API (one full-access key) and a basic textarea in the web UI. Quick Filters and similar Thunderbird add-ons manage local TB filters, not server-side Sieve. This project closes the gap: a polished Thunderbird UX for serverside Sieve, with a security-correct deployment model on top of mailcow.

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

Early. APIs and storage formats may change. Production-tested on a single mailcow 2026-03b deployment with Thunderbird 140 ESR.
