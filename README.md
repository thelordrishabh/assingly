# Assingly

Assingly is a local-first MVP for a **copying-only** student marketplace. It uses
Dime, an integer-only, non-cashable internal unit. It does not generate academic
answers, handle money, cash out balances, expose home addresses, or enable
school/teacher transactions.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:5173. The API runs on http://localhost:3001. The first API
start creates `data/assingly.db`, applies `server/migrations/001_initial.sql`, and
loads clearly-labelled fictional demo data.

Demo sign-in is deliberately local-only: use the profile switcher in the app.
It is not production authentication. A production deployment must replace demo
identity with a verified session provider, secure cookies, CSRF controls, a managed
private object store, malware scanning, rate-limit storage, and a production OCR
adapter.

## Demo participants

| Profile | What to try |
| --- | --- |
| Aanya Rao | Requester dashboard, browse, wallet, publish a copying request |
| Kabir Verma | Accept open writing work and submit page evidence |
| Meera Shah | Claim a delivery leg and test a handoff code |
| Nikhil Patel | Minor account with guardian consent and spending limits |
| Rhea Patel | Read-only guardian controls/activity |
| Assingly Operations | Verification queue, safe points, disputes, restrictions and audit log |

## Rules encoded in the MVP

- Dime uses integer ledger entries. Available/locked/lifetime earnings are updated
  in a single SQLite transaction and entries are never edited or deleted.
- A request needs a private source asset and copying-only attestation. Publishing
  locks the reward; writers never stake Dime. Notebook jobs create independently
  funded inbound/return delivery legs at a selected approved safe point.
- Students must be verified and minors require active guardian consent. Guardian
  limits are enforced before escrow is locked. Guardians are read-only.
- Page reviews are page-specific; OCR is marked advisory. Settlements use a
  deterministic per-page integer allocation and the accepted contract's immutable
  terms, including the 10% per started late day discount capped at 50%.
- Safe-point handoff codes are short-lived, single-use, stored only as hashes, and
  cannot be replayed. A requester or writer cannot courier their own leg.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

## Deliberate MVP seams

`server/services/ocr.ts` is an advisory queued/OCR adapter placeholder; no OCR
result can settle or decide a dispute. `server/services/uploads.ts` retains files
behind authenticated API access and strips location metadata only when image tools
are added; production should use object storage plus a malware/metadata pipeline.
Merchant redemption is intentionally absent and has no active route or UI.

The API is documented in [docs/API.md](docs/API.md) and business defaults are in
[docs/POLICIES.md](docs/POLICIES.md). Deployment guides for Render, Railway, Fly.io,
and Docker are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Deploy to web

Assingly includes ready-to-use production configurations:
- **Render**: [`render.yaml`](render.yaml) blueprint with persistent disk
- **Railway**: [`railway.json`](railway.json) with Dockerfile builder
- **Fly.io**: [`fly.toml`](fly.toml) with persistent NVMe volume
- **Docker Compose**: [`docker-compose.yml`](docker-compose.yml)
- Complete deployment walkthrough: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
