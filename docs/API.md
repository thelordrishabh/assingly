# API overview

All protected demo routes receive `X-Demo-User: <demo user id>` from the local
client. Responses use `{ error: { code, message, details? } }` for failures.
Pagination uses `?page=1&limit=20`.

| Area | Routes | Description |
| --- | --- | --- |
| Identity | `GET /api/users`, `GET /api/me`, `POST /api/verification/request`, `POST /api/admin/users/:id/verify`, `GET /api/guardian/controls`, `PUT /api/guardian/controls`, `POST /api/guardian/consent`, `GET /api/guardian/activity` | Profiles, demo authentication, verification requests/approvals, and guardian consent/controls |
| Wallet | `GET /api/wallet`, `GET /api/wallet/ledger`, `POST /api/admin/grants` | Balances (available, locked, lifetime earned), append-only ledger history, and audited grants |
| Writing | `GET/POST /api/contracts`, `GET /api/contracts/:id`, `POST /api/contracts/:id/accept`, `POST /api/contracts/:id/cancel`, `POST /api/contracts/:id/offers`, `POST /api/contracts/:id/offers/:offerId/accept`, `POST /api/contracts/:id/offers/:offerId/decline` | Contract publishing, structured counter-offers, acceptance, cancellation, and late policy |
| Evidence & OCR | `POST /api/contracts/:id/evidence`, `GET /api/contracts/:id/ocr-comparison/:pageNumber`, `POST /api/contracts/:id/reviews`, `POST /api/contracts/:id/disputes`, `POST /api/contracts/:id/auto-accept` | Page photo upload with SHA-256 receipt hash, advisory OCR coverage, page review, disputes, and 48h auto-accept |
| Uploads | `POST /api/uploads/source`, `GET /api/assets/:id` | Private file uploads, EXIF location metadata stripping, and authenticated private file access |
| Delivery | `GET /api/delivery`, `GET /api/delivery/:id`, `POST /api/delivery/:id/claim`, `POST /api/delivery/:id/handoff/initiate`, `POST /api/delivery/:id/handoff/confirm` | Independent delivery legs, safe points, single-use 6-digit OTP/QR handoffs, and custody proof |
| Reports | `POST /api/reports`, `POST /api/admin/reports/:id/resolve` | Filing and resolving safe point, condition, or custody issues |
| Notifications | `GET /api/notifications`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all` | In-app notification feed without private source or reusable meeting codes |
| Moderator | `GET /api/admin/overview`, `POST /api/admin/disputes/:id/resolve`, `POST /api/admin/users/:id/restrict`, `POST /api/admin/safe-points`, `PUT /api/admin/safe-points/:id`, `GET /api/admin/audit` | Operations console, evidence-based dispute adjudication, account restrictions, safe point directory, and audit logs |

Source uploads accept `multipart/form-data` field `file` and are capped at 10MB.
Evidence uses `file` plus a positive `pageNumber`. OCR state is returned as
`QUEUED`, `LOW_CONFIDENCE`, or `READY`; it is strictly advisory and cannot decide disputes or payouts.
