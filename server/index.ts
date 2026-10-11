import 'dotenv/config';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  addAudit,
  addReliabilityEvent,
  allocationForPage,
  autoAcceptExpiredReviews,
  lateDiscountPercent,
  notify,
  openDatabase,
  postLedgerTransaction,
  type Db,
} from './db.js';
import { calculateAdvisoryCoverage, processAssetOcr, processEvidenceOcr } from './services/ocr.js';
import { ALLOWED_MIME_TYPES, MAX_UPLOAD_BYTES, sanitizeImageMetadata } from './services/uploads.js';

const app = express();
const db = openDatabase();
const port = Number(process.env.PORT || 3001);
const uploadDir = process.env.UPLOAD_DIR || './data/private-uploads';
mkdirSync(uploadDir, { recursive: true });

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

type User = {
  id: string;
  email: string;
  display_name: string;
  role: 'STUDENT' | 'GUARDIAN' | 'MODERATOR';
  age: number;
  campus: string | null;
  verified_at: string | null;
  restricted_at: string | null;
};

type AuthedRequest = Request & { user?: User };
const now = () => new Date().toISOString();
const id = () => randomUUID();

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.use((req: AuthedRequest, _res, next) => {
  const userId = req.header('x-demo-user');
  if (userId) {
    req.user = db.prepare('SELECT id, email, display_name, role, age, campus, verified_at, restricted_at FROM users WHERE id = ?').get(userId) as User | undefined;
  }
  next();
});

const disk = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadDir),
  filename: (_req, file, callback) => callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
});

const upload = multer({
  storage: disk,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new ApiError(400, 'UNSUPPORTED_FILE', 'Use a PDF, text file, JPG, PNG, or WebP under 10MB.'));
  },
});

function requireUser(req: AuthedRequest): User {
  if (!req.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Choose a local demo profile to continue.');
  return req.user;
}

function requireRole(req: AuthedRequest, role: User['role']): User {
  const user = requireUser(req);
  if (user.role !== role) throw new ApiError(403, 'FORBIDDEN', 'This action is not available for this role.');
  return user;
}

function requireModerator(req: AuthedRequest): User {
  return requireRole(req, 'MODERATOR');
}

function requireStudent(req: AuthedRequest): User {
  const user = requireRole(req, 'STUDENT');
  if (!user.verified_at) throw new ApiError(403, 'VERIFICATION_REQUIRED', 'Student verification is required before marketplace participation.');
  if (user.restricted_at) throw new ApiError(403, 'ACCOUNT_RESTRICTED', 'This account is temporarily restricted. Contact support for review.');
  if (user.age < 18) {
    const relationship = db.prepare('SELECT consented_at FROM guardian_relationships WHERE student_id = ?').get(user.id) as { consented_at: string | null } | undefined;
    if (!relationship?.consented_at) throw new ApiError(403, 'GUARDIAN_CONSENT_REQUIRED', 'Guardian consent is required before marketplace participation.');
  }
  return user;
}

function getContract(contractId: string) {
  const contract = db.prepare(`SELECT c.*, r.display_name requester_name, w.display_name writer_name, s.name safe_point_name, s.campus safe_point_campus,
    a.original_name source_name, a.ocr_status source_ocr_status, a.ocr_confidence source_ocr_confidence, a.ocr_text source_ocr_text
    FROM writing_contracts c JOIN users r ON r.id = c.requester_id LEFT JOIN users w ON w.id = c.writer_id
    JOIN safe_points s ON s.id = c.safe_point_id JOIN source_assets a ON a.id = c.source_asset_id WHERE c.id = ?`).get(contractId) as Record<string, unknown> | undefined;
  if (!contract) throw new ApiError(404, 'NOT_FOUND', 'Writing contract not found.');
  return contract;
}

function getDelivery(legId: string) {
  const leg = db.prepare(`SELECT d.*, r.display_name requester_name, p.display_name recipient_name, c.display_name courier_name, s.name safe_point_name, s.hours safe_point_hours
    FROM delivery_legs d JOIN users r ON r.id = d.requester_id JOIN users p ON p.id = d.recipient_id
    LEFT JOIN users c ON c.id = d.courier_id JOIN safe_points s ON s.id = d.safe_point_id WHERE d.id = ?`).get(legId) as Record<string, unknown> | undefined;
  if (!leg) throw new ApiError(404, 'NOT_FOUND', 'Delivery leg not found.');
  return leg;
}

function parse<T extends z.ZodType>(body: unknown, schema: T): z.output<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', result.error.flatten());
  return result.data as z.output<T>;
}

function canSeeContract(user: User, contract: Record<string, unknown>) {
  return user.role === 'MODERATOR' || user.id === contract.requester_id || user.id === contract.writer_id;
}

function assertGuardianLimit(database: Db, user: User, amount: number) {
  if (user.age >= 18) return;
  const control = database.prepare('SELECT * FROM guardian_controls WHERE student_id = ?').get(user.id) as { max_per_contract: number; max_per_rolling_period: number; rolling_period_days: number } | undefined;
  if (!control) throw new ApiError(403, 'GUARDIAN_CONTROL_REQUIRED', 'A guardian needs to set spending controls before Dime can be committed.');
  if (amount > control.max_per_contract) throw new ApiError(403, 'GUARDIAN_CONTRACT_LIMIT', `This needs ${amount} Dime, above the guardian limit of ${control.max_per_contract}.`);
  const since = new Date(Date.now() - control.rolling_period_days * 86400000).toISOString();
  const committed = (database.prepare(`SELECT COALESCE(SUM(ABS(l.available_delta)), 0) as total FROM ledger_lines l
      JOIN ledger_transactions t ON t.id = l.transaction_id WHERE l.user_id = ? AND l.available_delta < 0 AND t.kind = 'ESCROW_LOCK' AND t.created_at >= ?`).get(user.id, since) as { total: number }).total;
  if (committed + amount > control.max_per_rolling_period) throw new ApiError(403, 'GUARDIAN_PERIOD_LIMIT', 'This would exceed the guardian rolling-period Dime limit.');
}

function createAsset(ownerId: string, file: Express.Multer.File) {
  const assetId = id();
  const rawContents = readFileSync(file.path);
  // Strip location/camera metadata for privacy
  const contents = sanitizeImageMetadata(rawContents, file.mimetype) as Buffer;
  const storageKey = file.filename;
  const hash = createHash('sha256').update(contents).digest('hex');
  db.prepare('INSERT INTO source_assets (id, owner_id, storage_key, original_name, content_type, bytes, sha256, ocr_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(assetId, ownerId, storageKey, file.originalname.slice(0, 140), file.mimetype, contents.length, hash, 'QUEUED', now());

  // Launch advisory OCR processing in background
  processAssetOcr(db, assetId, file.path, file.mimetype, file.originalname);

  return { id: assetId, originalName: file.originalname, ocrStatus: 'QUEUED' };
}

function settleIfReady(contractId: string, actorId: string) {
  const contract = getContract(contractId) as unknown as { id: string; requester_id: string; writer_id: string | null; reward: number; page_count: number; deadline_at: string; status: string; settled_at: string | null };
  if (contract.settled_at || !contract.writer_id) return false;
  const reviews = db.prepare('SELECT page_number, status, payout_percent FROM page_reviews WHERE contract_id = ?').all(contractId) as { page_number: number; status: string; payout_percent: number | null }[];
  if (reviews.length !== contract.page_count || reviews.some((review) => review.status === 'DISPUTED')) return false;
  const discount = lateDiscountPercent(contract.deadline_at);
  let payout = 0;
  for (const review of reviews) {
    const allocation = allocationForPage(contract.reward, contract.page_count, review.page_number);
    const percent = review.payout_percent ?? 100;
    payout += Math.floor((allocation * percent * (100 - discount)) / 10000);
  }
  const refund = contract.reward - payout;
  postLedgerTransaction(db, {
    idempotencyKey: `settlement-${contract.id}`,
    kind: 'SETTLEMENT',
    reason: `Page-by-page settlement${discount ? ` with ${discount}% late adjustment` : ''}`,
    actorId,
    contractId: contract.id,
    lines: [
      { userId: contract.requester_id, available: refund, locked: -contract.reward },
      { userId: contract.writer_id, available: payout, locked: 0, earned: payout },
    ],
  });
  db.prepare('UPDATE writing_contracts SET status = ?, settled_at = ?, updated_at = ? WHERE id = ?').run('SETTLED', now(), now(), contract.id);
  // Add positive reliability event if payout > 0
  if (payout > 0) {
    addReliabilityEvent(db, contract.writer_id, 2, 'POSITIVE_COMPLETION', `Successful pro-rata completion of ${contract.id}`, contract.id, actorId);
  }
  notify(db, contract.requester_id, 'SETTLEMENT', 'Writing contract settled', `${payout} Dime was paid for accepted/adjudicated pages; ${refund} Dime returned to available balance.`, `/contracts/${contract.id}`);
  notify(db, contract.writer_id, 'SETTLEMENT', 'Writing contract settled', `${payout} Dime was released for accepted/adjudicated pages.`, `/contracts/${contract.id}`);
  addAudit(db, actorId, 'SETTLE_CONTRACT', 'writing_contract', contract.id, undefined, { payout, refund, discount });
  return true;
}

// -----------------------------------------------------------------------------
// Core Info & Identity Routes
// -----------------------------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ status: 'ok', demoMode: process.env.DEMO_MODE !== 'false' }));

app.get('/api/users', (_req, res) => res.json({
  data: db.prepare('SELECT id, display_name, role, age, campus, verified_at, restricted_at FROM users ORDER BY role, display_name').all(),
}));

app.get('/api/me', (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const wallet = db.prepare('SELECT available, locked, lifetime_earned FROM wallets WHERE user_id = ?').get(user.id);
  const reliability = db.prepare('SELECT COALESCE(SUM(delta), 0) as score, COUNT(*) as events FROM reliability_events WHERE user_id = ?').get(user.id);
  const active = db.prepare("SELECT COUNT(*) as count FROM writing_contracts WHERE (requester_id = ? OR writer_id = ?) AND status NOT IN ('SETTLED','CANCELLED')").get(user.id, user.id);
  const guardian = user.age < 18 ? db.prepare('SELECT gc.*, u.display_name guardian_name FROM guardian_controls gc JOIN users u ON u.id = gc.guardian_id WHERE gc.student_id = ?').get(user.id) : null;
  res.json({ data: { user, wallet, reliability, activeContracts: active, guardian } });
});

// -----------------------------------------------------------------------------
// Wallet & Ledger Routes
// -----------------------------------------------------------------------------

app.get('/api/wallet', (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const wallet = db.prepare('SELECT available, locked, lifetime_earned FROM wallets WHERE user_id = ?').get(user.id);
  res.json({ data: wallet });
});

app.get('/api/wallet/ledger', (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
  const page = Math.max(1, Number(req.query.page || 1));
  const rows = db.prepare(`SELECT l.*, t.kind, t.reason, t.contract_id, t.created_at FROM ledger_lines l JOIN ledger_transactions t ON t.id = l.transaction_id
      WHERE l.user_id = ? ORDER BY t.created_at DESC LIMIT ? OFFSET ?`).all(user.id, limit, (page - 1) * limit);
  const total = (db.prepare('SELECT COUNT(*) as count FROM ledger_lines WHERE user_id = ?').get(user.id) as { count: number }).count;
  res.json({ data: rows, pagination: { page, limit, total } });
});

// -----------------------------------------------------------------------------
// Private Uploads & Assets
// -----------------------------------------------------------------------------

app.post('/api/uploads/source', upload.single('file'), (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  if (!req.file) throw new ApiError(400, 'SOURCE_REQUIRED', 'Choose a source file before continuing.');
  const asset = createAsset(user.id, req.file);
  addAudit(db, user.id, 'UPLOAD_SOURCE', 'source_asset', asset.id);
  res.status(201).json({ data: asset });
});

app.get('/api/assets/:id', (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const asset = db.prepare('SELECT * FROM source_assets WHERE id = ?').get(req.params.id) as { id: string; owner_id: string; storage_key: string; original_name: string; content_type: string } | undefined;
  if (!asset) throw new ApiError(404, 'NOT_FOUND', 'Private asset not found.');
  const permitted = user.role === 'MODERATOR' || asset.owner_id === user.id || db.prepare(`SELECT 1 FROM writing_contracts c LEFT JOIN page_evidence p ON p.contract_id = c.id
    WHERE (c.source_asset_id = ? OR p.asset_id = ?) AND (c.requester_id = ? OR c.writer_id = ?) LIMIT 1`).get(asset.id, asset.id, user.id, user.id);
  if (!permitted) throw new ApiError(403, 'PRIVATE_ASSET', 'You do not have access to this private asset.');
  const file = join(uploadDir, asset.storage_key);
  if (!existsSync(file)) throw new ApiError(404, 'FILE_MISSING', 'The private file is no longer available.');
  res.type(asset.content_type).attachment(asset.original_name).sendFile(file, { root: '/' });
});

// -----------------------------------------------------------------------------
// Writing Contracts & Offers
// -----------------------------------------------------------------------------

const contractSchema = z.object({
  title: z.string().trim().min(6).max(120),
  summary: z.string().trim().min(12).max(700),
  paperMode: z.enum(['WRITER_SUPPLIED', 'REQUESTER_NOTEBOOK']),
  pageCount: z.number().int().min(1).max(100),
  reward: z.number().int().min(10).max(100000),
  deliveryReward: z.number().int().min(0).max(10000),
  deadlineAt: z.string().datetime(),
  safePointId: z.string().min(1),
  sourceAssetId: z.string().min(1),
  acceptanceCriteria: z.string().trim().min(8).max(500),
  copyingAttested: z.literal(true),
});

app.get('/api/contracts', (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const scope = String(req.query.scope || 'market');
  const status = req.query.status ? String(req.query.status) : undefined;
  const params: unknown[] = [];
  let where = '';
  if (scope === 'mine') {
    where = 'WHERE (c.requester_id = ? OR c.writer_id = ?)';
    params.push(user.id, user.id);
  } else if (scope === 'market') {
    where = "WHERE c.status = 'OPEN' AND c.requester_id != ?";
    params.push(user.id);
  }
  if (status) {
    where += where ? ' AND c.status = ?' : 'WHERE c.status = ?';
    params.push(status);
  }
  const rows = db.prepare(`SELECT c.id, c.title, c.summary, c.status, c.paper_mode, c.page_count, c.reward, c.delivery_reward, c.deadline_at, c.requester_id, r.display_name requester_name, w.display_name writer_name, s.name safe_point_name, s.campus
    FROM writing_contracts c JOIN users r ON r.id = c.requester_id LEFT JOIN users w ON w.id = c.writer_id JOIN safe_points s ON s.id = c.safe_point_id ${where} ORDER BY c.deadline_at ASC`).all(...params);
  res.json({ data: rows });
});

app.post('/api/contracts', (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  const input = parse(req.body, contractSchema);
  const deadline = new Date(input.deadlineAt);
  if (deadline.getTime() < Date.now() + 60 * 60 * 1000) {
    throw new ApiError(400, 'DEADLINE_INVALID', 'Choose a deadline at least one hour from now.');
  }
  const source = db.prepare('SELECT id FROM source_assets WHERE id = ? AND owner_id = ?').get(input.sourceAssetId, user.id);
  if (!source) throw new ApiError(400, 'SOURCE_REQUIRED', 'Upload your private source material before publishing.');
  const safePoint = db.prepare('SELECT id FROM safe_points WHERE id = ? AND active = 1').get(input.safePointId);
  if (!safePoint) throw new ApiError(400, 'SAFE_POINT_INVALID', 'Choose an approved active safe point.');
  if (input.paperMode === 'REQUESTER_NOTEBOOK' && input.deliveryReward < 1) {
    throw new ApiError(400, 'DELIVERY_REWARD_REQUIRED', 'Notebook requests require a Dime reward for each delivery leg.');
  }
  const total = input.reward + (input.paperMode === 'REQUESTER_NOTEBOOK' ? input.deliveryReward * 2 : 0);
  assertGuardianLimit(db, user, total);
  const contractId = id();
  const created = now();
  const terms = { ...input, fundedTotal: total, latePolicy: '10% per started 24h, capped at 50%; 24h cancellation grace' };

  db.transaction(() => {
    postLedgerTransaction(db, {
      idempotencyKey: `lock-${contractId}`,
      kind: 'ESCROW_LOCK',
      reason: 'Writing contract and applicable delivery escrow',
      actorId: user.id,
      contractId,
      lines: [{ userId: user.id, available: -total, locked: total }],
    });
    db.prepare(`INSERT INTO writing_contracts (id, requester_id, title, summary, status, paper_mode, page_count, reward, delivery_reward, deadline_at, safe_point_id, source_asset_id, acceptance_criteria, copying_attested_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(contractId, user.id, input.title, input.summary, input.paperMode, input.pageCount, input.reward, input.deliveryReward, input.deadlineAt, input.safePointId, input.sourceAssetId, input.acceptanceCriteria, created, created, created);
    db.prepare('INSERT INTO contract_versions (id, contract_id, version, terms_json, source_asset_id, proposed_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)')
      .run(id(), contractId, JSON.stringify(terms), input.sourceAssetId, user.id, created);
    addAudit(db, user.id, 'PUBLISH_CONTRACT', 'writing_contract', contractId, undefined, { total });
  })();
  res.status(201).json({ data: getContract(contractId) });
});

app.get('/api/contracts/:id', (req: AuthedRequest, res) => {
  const contractId = String(req.params.id);
  const user = requireUser(req);
  const contract = getContract(contractId);
  if (!canSeeContract(user, contract) && contract.status !== 'OPEN') {
    throw new ApiError(403, 'FORBIDDEN', 'This contract is private.');
  }
  const includePrivate = canSeeContract(user, contract);
  const data: Record<string, unknown> = { ...contract };
  if (includePrivate) {
    data.versions = db.prepare('SELECT version, terms_json, accepted_at, created_at FROM contract_versions WHERE contract_id = ? ORDER BY version DESC').all(contractId);
    data.evidence = db.prepare(`SELECT p.*, a.original_name, a.ocr_text evidence_ocr_text
      FROM page_evidence p JOIN source_assets a ON a.id = p.asset_id WHERE p.contract_id = ? ORDER BY p.page_number`).all(contractId);
    data.reviews = db.prepare('SELECT * FROM page_reviews WHERE contract_id = ? ORDER BY page_number').all(contractId);
    data.disputes = db.prepare('SELECT * FROM disputes WHERE contract_id = ? ORDER BY created_at DESC').all(contractId);
    data.offers = db.prepare(`SELECT o.*, u.display_name proposer_name FROM contract_offers o JOIN users u ON u.id = o.proposer_id WHERE o.contract_id = ? ORDER BY o.created_at DESC`).all(contractId);
  } else {
    delete data.source_asset_id;
    delete data.source_name;
    delete data.source_ocr_text;
  }
  res.json({ data });
});

app.post('/api/contracts/:id/accept', (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  const contract = getContract(String(req.params.id)) as unknown as { id: string; requester_id: string; status: string; paper_mode: string; safe_point_campus: string; delivery_reward: number; source_asset_id: string; safe_point_id: string };
  if (contract.status !== 'OPEN') throw new ApiError(409, 'NOT_OPEN', 'This request is no longer open.');
  if (contract.requester_id === user.id) throw new ApiError(403, 'SELF_CONTRACT', 'You cannot accept your own request.');
  if (contract.paper_mode === 'REQUESTER_NOTEBOOK' && user.campus !== contract.safe_point_campus) {
    throw new ApiError(400, 'SAME_CAMPUS_REQUIRED', 'Requester-supplied notebooks are limited to students at the same verified campus.');
  }
  db.transaction(() => {
    db.prepare('UPDATE writing_contracts SET writer_id = ?, status = ?, accepted_version = 1, updated_at = ? WHERE id = ?').run(user.id, 'ACCEPTED', now(), contract.id);
    db.prepare('UPDATE contract_versions SET accepted_at = ? WHERE contract_id = ? AND version = 1').run(now(), contract.id);
    if (contract.paper_mode === 'REQUESTER_NOTEBOOK') {
      const requester = contract.requester_id;
      const legs = [
        ['INBOUND_NOTEBOOK', requester, user.id, 'Requester-supplied bound notebook'],
        ['RETURN_WORK', requester, requester, 'Completed copied notebook'],
      ];
      for (const [direction, owner, recipient, description] of legs) {
        db.prepare('INSERT INTO delivery_legs (id, writing_contract_id, requester_id, recipient_id, direction, status, reward, campus, safe_point_id, item_description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id(), contract.id, owner, recipient, direction, 'OPEN', contract.delivery_reward, user.campus, contract.safe_point_id, description, now(), now());
      }
    }
    notify(db, contract.requester_id, 'ACCEPTANCE', 'A writer accepted your copying request', 'Review the accepted, immutable terms and keep handoffs at the approved safe point.', `/contracts/${contract.id}`);
    notify(db, user.id, 'ACCEPTANCE', 'You accepted a copying request', 'The source is private and may only be copied as supplied.', `/contracts/${contract.id}`);
    addAudit(db, user.id, 'ACCEPT_CONTRACT', 'writing_contract', contract.id);
  })();
  res.json({ data: getContract(contract.id) });
});

// Structured Counter-Offers
const offerSchema = z.object({
  reward: z.number().int().min(10).max(100000).optional(),
  deadlineAt: z.string().datetime().optional(),
  pageCount: z.number().int().min(1).max(100).optional(),
  note: z.string().trim().max(300).optional(),
});

app.post('/api/contracts/:id/offers', (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  const contract = getContract(String(req.params.id)) as unknown as { id: string; requester_id: string; status: string };
  if (contract.status !== 'OPEN') throw new ApiError(409, 'NOT_OPEN', 'Counter-offers can only be proposed on open requests.');
  if (contract.requester_id === user.id) throw new ApiError(403, 'SELF_OFFER', 'You cannot counter your own request.');
  const input = parse(req.body, offerSchema);
  if (!input.reward && !input.deadlineAt && !input.pageCount) {
    throw new ApiError(400, 'OFFER_EMPTY', 'Specify at least one modified term (reward, deadline, or page count).');
  }
  const offerId = id();
  db.prepare('INSERT INTO contract_offers (id, contract_id, proposer_id, reward, deadline_at, page_count, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(offerId, contract.id, user.id, input.reward || null, input.deadlineAt || null, input.pageCount || null, 'PENDING', input.note || null, now());
  notify(db, contract.requester_id, 'OFFER', 'New structured counter-offer received', `${user.display_name} proposed modified terms for your review.`, `/contracts/${contract.id}`);
  addAudit(db, user.id, 'PROPOSE_OFFER', 'contract_offer', offerId, undefined, input);
  res.status(201).json({ data: { id: offerId, status: 'PENDING' } });
});

app.post('/api/contracts/:id/offers/:offerId/accept', (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  const contract = getContract(String(req.params.id)) as unknown as {
    id: string; requester_id: string; status: string; reward: number; delivery_reward: number;
    paper_mode: string; page_count: number; deadline_at: string; safe_point_campus: string;
    safe_point_id: string; source_asset_id: string;
  };
  if (contract.requester_id !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Only the requester can accept an offer.');
  if (contract.status !== 'OPEN') throw new ApiError(409, 'NOT_OPEN', 'Contract is no longer open.');
  const offer = db.prepare('SELECT * FROM contract_offers WHERE id = ? AND contract_id = ?').get(req.params.offerId, contract.id) as {
    id: string; proposer_id: string; reward: number | null; deadline_at: string | null; page_count: number | null; status: string;
  } | undefined;
  if (!offer || offer.status !== 'PENDING') throw new ApiError(404, 'OFFER_NOT_PENDING', 'Offer is no longer pending.');

  const newReward = offer.reward ?? contract.reward;
  const newDeadline = offer.deadline_at ?? contract.deadline_at;
  const newPages = offer.page_count ?? contract.page_count;
  const rewardDelta = newReward - contract.reward;

  db.transaction(() => {
    if (rewardDelta !== 0) {
      if (rewardDelta > 0) {
        assertGuardianLimit(db, user, newReward + (contract.paper_mode === 'REQUESTER_NOTEBOOK' ? contract.delivery_reward * 2 : 0));
      }
      postLedgerTransaction(db, {
        idempotencyKey: `offer-escrow-${offer.id}`,
        kind: rewardDelta > 0 ? 'ESCROW_LOCK' : 'ESCROW_RELEASE',
        reason: `Escrow adjustment for accepted counter-offer (${rewardDelta > 0 ? '+' : ''}${rewardDelta} Dime)`,
        actorId: user.id,
        contractId: contract.id,
        lines: [{ userId: user.id, available: -rewardDelta, locked: rewardDelta }],
      });
    }

    const nextVersion = ((db.prepare('SELECT COALESCE(MAX(version), 1) as v FROM contract_versions WHERE contract_id = ?').get(contract.id) as { v: number }).v) + 1;
    const terms = {
      reward: newReward,
      pageCount: newPages,
      deadlineAt: newDeadline,
      paperMode: contract.paper_mode,
      deliveryReward: contract.delivery_reward,
      counterOfferId: offer.id,
    };
    db.prepare('INSERT INTO contract_versions (id, contract_id, version, terms_json, source_asset_id, proposed_by, accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id(), contract.id, nextVersion, JSON.stringify(terms), contract.source_asset_id, offer.proposer_id, now(), now());

    db.prepare(`UPDATE writing_contracts SET writer_id = ?, status = 'ACCEPTED', reward = ?, page_count = ?, deadline_at = ?, accepted_version = ?, updated_at = ? WHERE id = ?`)
      .run(offer.proposer_id, newReward, newPages, newDeadline, nextVersion, now(), contract.id);

    db.prepare("UPDATE contract_offers SET status = 'ACCEPTED' WHERE id = ?").run(offer.id);
    db.prepare("UPDATE contract_offers SET status = 'EXPIRED' WHERE contract_id = ? AND id != ? AND status = 'PENDING'").run(contract.id, offer.id);

    if (contract.paper_mode === 'REQUESTER_NOTEBOOK') {
      const legs = [
        ['INBOUND_NOTEBOOK', contract.requester_id, offer.proposer_id, 'Requester-supplied bound notebook'],
        ['RETURN_WORK', contract.requester_id, contract.requester_id, 'Completed copied notebook'],
      ];
      for (const [direction, owner, recipient, description] of legs) {
        db.prepare('INSERT INTO delivery_legs (id, writing_contract_id, requester_id, recipient_id, direction, status, reward, campus, safe_point_id, item_description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id(), contract.id, owner, recipient, direction, 'OPEN', contract.delivery_reward, contract.safe_point_campus, contract.safe_point_id, description, now(), now());
      }
    }

    notify(db, offer.proposer_id, 'OFFER_ACCEPTED', 'Your counter-offer was accepted!', 'The contract terms have been updated and are now immutable.', `/contracts/${contract.id}`);
    addAudit(db, user.id, 'ACCEPT_OFFER', 'contract_offer', offer.id, undefined, terms);
  })();

  res.json({ data: getContract(contract.id) });
});

app.post('/api/contracts/:id/offers/:offerId/decline', (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  const contract = getContract(String(req.params.id)) as unknown as { id: string; requester_id: string };
  if (contract.requester_id !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Only the requester can decline an offer.');
  const offer = db.prepare('SELECT * FROM contract_offers WHERE id = ? AND contract_id = ?').get(req.params.offerId, contract.id) as { id: string; proposer_id: string; status: string } | undefined;
  if (!offer || offer.status !== 'PENDING') throw new ApiError(404, 'OFFER_NOT_PENDING', 'Offer is no longer pending.');
  db.prepare("UPDATE contract_offers SET status = 'DECLINED' WHERE id = ?").run(offer.id);
  notify(db, offer.proposer_id, 'OFFER_DECLINED', 'Counter-offer declined', 'The requester declined the proposed counter-offer.', `/contracts/${contract.id}`);
  addAudit(db, user.id, 'DECLINE_OFFER', 'contract_offer', offer.id);
  res.json({ data: { id: offer.id, status: 'DECLINED' } });
});

// Cancellation & Late Policy
app.post('/api/contracts/:id/cancel', (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  const contract = getContract(String(req.params.id)) as unknown as {
    id: string; requester_id: string; status: string; reward: number; delivery_reward: number; paper_mode: string; deadline_at: string;
  };
  if (contract.requester_id !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Only the requester can cancel this contract.');

  // Eligible for full cancellation if OPEN, OR past 24h grace period after deadline with 0 submitted pages & no physical handoff
  const isPastGrace = Date.now() > new Date(contract.deadline_at).getTime() + 24 * 3600 * 1000;
  const evidenceCount = (db.prepare('SELECT COUNT(*) as count FROM page_evidence WHERE contract_id = ?').get(contract.id) as { count: number }).count;
  const deliveryHandoffStarted = (db.prepare(`SELECT COUNT(*) as count FROM delivery_legs WHERE writing_contract_id = ? AND status IN ('PICKUP_CONFIRMED', 'DROPOFF_CONFIRMED', 'COMPLETED')`).get(contract.id) as { count: number }).count > 0;

  let canCancel = false;
  let reason = '';
  if (contract.status === 'OPEN') {
    canCancel = true;
    reason = 'Requester cancelled before writer acceptance';
  } else if (['ACCEPTED', 'IN_PROGRESS'].includes(contract.status) && isPastGrace && evidenceCount === 0 && !deliveryHandoffStarted) {
    canCancel = true;
    reason = 'Eligible late cancellation: deadline grace period expired without submitted work or physical handoff';
  }

  if (!canCancel) {
    throw new ApiError(409, 'CANCELLATION_REVIEW_REQUIRED', 'After acceptance, cancellation requires passing the 24-hour late grace period without submitted pages or physical handoffs.');
  }

  const amount = contract.reward + (contract.paper_mode === 'REQUESTER_NOTEBOOK' ? contract.delivery_reward * 2 : 0);
  db.transaction(() => {
    postLedgerTransaction(db, {
      idempotencyKey: `cancel-${contract.id}`,
      kind: 'ESCROW_RELEASE',
      reason,
      actorId: user.id,
      contractId: contract.id,
      lines: [{ userId: user.id, available: amount, locked: -amount }],
    });
    db.prepare('UPDATE writing_contracts SET status = ?, updated_at = ? WHERE id = ?').run('CANCELLED', now(), contract.id);
    db.prepare("UPDATE delivery_legs SET status = 'CANCELLED', updated_at = ? WHERE writing_contract_id = ?").run(now(), contract.id);
    addAudit(db, user.id, 'CANCEL_CONTRACT', 'writing_contract', contract.id, reason);
  })();
  res.json({ data: { id: contract.id, status: 'CANCELLED' } });
});

// Evidence & OCR
app.post('/api/contracts/:id/evidence', upload.single('file'), (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  if (!req.file) throw new ApiError(400, 'EVIDENCE_REQUIRED', 'Capture or choose a page image.');
  const contract = getContract(String(req.params.id)) as unknown as { id: string; writer_id: string | null; status: string; page_count: number; requester_id: string };
  if (contract.writer_id !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Only the assigned writer can submit page evidence.');
  if (!['ACCEPTED', 'IN_PROGRESS'].includes(contract.status)) throw new ApiError(409, 'INVALID_STATE', 'Evidence can be added after acceptance and before completion.');
  const pageNumber = Number(req.body.pageNumber);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > contract.page_count) throw new ApiError(400, 'PAGE_INVALID', 'Use a page number within the contract page count.');
  if (db.prepare('SELECT 1 FROM page_evidence WHERE contract_id = ? AND page_number = ?').get(contract.id, pageNumber)) throw new ApiError(409, 'PAGE_EXISTS', 'That page already has evidence.');

  const asset = createAsset(user.id, req.file);
  const receiptHash = createHash('sha256').update(`${asset.id}:${contract.id}:${pageNumber}:${now()}`).digest('hex');
  const evidenceId = id();

  db.transaction(() => {
    db.prepare('INSERT INTO page_evidence (id, contract_id, page_number, asset_id, receipt_hash, ocr_status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(evidenceId, contract.id, pageNumber, asset.id, receiptHash, 'QUEUED', now());
    const count = (db.prepare('SELECT COUNT(*) as count FROM page_evidence WHERE contract_id = ?').get(contract.id) as { count: number }).count;
    db.prepare('UPDATE writing_contracts SET status = ?, submitted_at = CASE WHEN ? = ? THEN ? ELSE submitted_at END, updated_at = ? WHERE id = ?')
      .run(count === contract.page_count ? 'SUBMITTED' : 'IN_PROGRESS', count, contract.page_count, now(), now(), contract.id);
    if (count === contract.page_count) {
      notify(db, contract.requester_id, 'PAGE_SUBMISSION', 'All page evidence is ready for review', 'Review each submitted page individually within 48 hours.', `/contracts/${contract.id}`);
    }
    addAudit(db, user.id, 'SUBMIT_PAGE_EVIDENCE', 'writing_contract', contract.id, undefined, { pageNumber, receiptHash });
  })();

  // Process advisory OCR on the evidence image
  processEvidenceOcr(db, evidenceId, req.file.path, req.file.mimetype, req.file.originalname);

  res.status(201).json({ data: { asset, pageNumber, receiptHash } });
});

app.get('/api/contracts/:id/ocr-comparison/:pageNumber', (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const contract = getContract(String(req.params.id));
  if (!canSeeContract(user, contract)) throw new ApiError(403, 'FORBIDDEN', 'Contract is private.');
  const pageNumber = Number(req.params.pageNumber);
  const evidence = db.prepare('SELECT * FROM page_evidence WHERE contract_id = ? AND page_number = ?').get(contract.id, pageNumber) as { ocr_text: string | null; ocr_status: string; ocr_confidence: number | null } | undefined;
  if (!evidence) throw new ApiError(404, 'NOT_FOUND', 'Page evidence not found.');
  const coverage = calculateAdvisoryCoverage(contract.source_ocr_text as string | null, evidence.ocr_text);
  res.json({
    data: {
      pageNumber,
      status: evidence.ocr_status,
      confidence: evidence.ocr_confidence,
      coveragePercent: coverage.matchPercent,
      advisoryNote: coverage.advisoryNote,
      disclaimer: 'Advisory only. No OCR result can settle or decide a dispute, payment, or reliability event.',
    },
  });
});

// Page Reviews & Disputes
app.post('/api/contracts/:id/reviews', (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  const input = parse(req.body, z.object({ evidenceId: z.string().uuid(), action: z.literal('ACCEPT'), note: z.string().max(300).optional() }));
  const contract = getContract(String(req.params.id)) as unknown as { id: string; requester_id: string; writer_id: string | null; status: string };
  if (contract.requester_id !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Only the requester may review submitted pages.');
  if (!['SUBMITTED', 'IN_REVIEW', 'DISPUTED'].includes(contract.status)) throw new ApiError(409, 'INVALID_STATE', 'There are no submitted pages ready to review.');
  const evidence = db.prepare('SELECT * FROM page_evidence WHERE id = ? AND contract_id = ?').get(input.evidenceId, contract.id) as { id: string; page_number: number } | undefined;
  if (!evidence) throw new ApiError(404, 'NOT_FOUND', 'Page evidence not found.');
  if (db.prepare('SELECT 1 FROM page_reviews WHERE evidence_id = ?').get(evidence.id)) throw new ApiError(409, 'ALREADY_REVIEWED', 'This page already has a review.');

  db.transaction(() => {
    db.prepare('INSERT INTO page_reviews (id, evidence_id, contract_id, page_number, status, note, reviewed_by, payout_percent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id(), evidence.id, contract.id, evidence.page_number, 'ACCEPTED', input.note || null, user.id, 100, now());
    db.prepare('UPDATE writing_contracts SET status = ?, updated_at = ? WHERE id = ?').run('IN_REVIEW', now(), contract.id);
    addAudit(db, user.id, 'ACCEPT_PAGE', 'page_evidence', evidence.id);
  })();
  settleIfReady(contract.id, user.id);
  res.json({ data: { accepted: true } });
});

app.post('/api/contracts/:id/disputes', (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  const input = parse(req.body, z.object({
    evidenceId: z.string().uuid(),
    reason: z.enum(['MISSING_PAGE', 'ILLEGIBLE', 'SOURCE_MISMATCH', 'SPEC_NOT_MET']),
    note: z.string().max(300).optional(),
  }));
  const contract = getContract(String(req.params.id)) as unknown as { id: string; requester_id: string; writer_id: string | null; status: string };
  if (contract.requester_id !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Only the requester may dispute a page.');
  if (!['SUBMITTED', 'IN_REVIEW', 'DISPUTED'].includes(contract.status)) throw new ApiError(409, 'INVALID_STATE', 'There are no submitted pages ready to dispute.');
  const evidence = db.prepare('SELECT * FROM page_evidence WHERE id = ? AND contract_id = ?').get(input.evidenceId, contract.id) as { id: string; page_number: number } | undefined;
  if (!evidence) throw new ApiError(404, 'NOT_FOUND', 'Page evidence not found.');
  if (db.prepare('SELECT 1 FROM page_reviews WHERE evidence_id = ?').get(evidence.id)) throw new ApiError(409, 'ALREADY_REVIEWED', 'This page already has a review.');

  const disputeId = id();
  db.transaction(() => {
    db.prepare('INSERT INTO disputes (id, contract_id, evidence_id, page_number, reason, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(disputeId, contract.id, evidence.id, evidence.page_number, input.reason, input.note || null, 'OPEN', now());
    db.prepare('INSERT INTO page_reviews (id, evidence_id, contract_id, page_number, status, reason, note, reviewed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id(), evidence.id, contract.id, evidence.page_number, 'DISPUTED', input.reason, input.note || null, user.id, now());
    db.prepare('UPDATE writing_contracts SET status = ?, updated_at = ? WHERE id = ?').run('DISPUTED', now(), contract.id);
    notify(db, contract.writer_id!, 'DISPUTE', 'A page needs moderator review', 'Settlement continues only on pages not under dispute.', `/contracts/${contract.id}`);
    addAudit(db, user.id, 'FILE_PAGE_DISPUTE', 'dispute', disputeId, input.reason);
  })();
  res.status(201).json({ data: { id: disputeId, status: 'OPEN' } });
});

// 48-Hour Auto-Accept Trigger
app.post('/api/contracts/:id/auto-accept', (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const contract = getContract(String(req.params.id)) as unknown as { id: string; requester_id: string; status: string; page_count: number; submitted_at: string | null };
  if (!['SUBMITTED', 'IN_REVIEW'].includes(contract.status)) throw new ApiError(409, 'INVALID_STATE', 'No submitted pages pending auto-acceptance.');
  const evidences = db.prepare('SELECT id, page_number FROM page_evidence WHERE contract_id = ?').all(contract.id) as { id: string; page_number: number }[];
  let count = 0;
  db.transaction(() => {
    for (const ev of evidences) {
      const existing = db.prepare('SELECT 1 FROM page_reviews WHERE evidence_id = ?').get(ev.id);
      if (!existing) {
        db.prepare('INSERT INTO page_reviews (id, evidence_id, contract_id, page_number, status, reason, note, reviewed_by, payout_percent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id(), ev.id, contract.id, ev.page_number, 'AUTO_ACCEPTED', '48h auto-acceptance without dispute', 'Auto-accepted per policy', user.id, 100, now());
        count++;
      }
    }
  })();
  settleIfReady(contract.id, user.id);
  res.json({ data: { autoAcceptedPages: count } });
});

// -----------------------------------------------------------------------------
// Delivery Marketplace & Chain of Custody
// -----------------------------------------------------------------------------

app.get('/api/delivery', (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const scope = String(req.query.scope || 'market');
  const rows = scope === 'mine'
    ? db.prepare(`SELECT d.*, r.display_name requester_name, p.display_name recipient_name, c.display_name courier_name, s.name safe_point_name, s.hours safe_point_hours FROM delivery_legs d JOIN users r ON r.id=d.requester_id JOIN users p ON p.id=d.recipient_id LEFT JOIN users c ON c.id=d.courier_id JOIN safe_points s ON s.id=d.safe_point_id WHERE d.requester_id=? OR d.recipient_id=? OR d.courier_id=? ORDER BY d.created_at DESC`).all(user.id, user.id, user.id)
    : db.prepare(`SELECT d.*, r.display_name requester_name, p.display_name recipient_name, s.name safe_point_name, s.hours safe_point_hours FROM delivery_legs d JOIN users r ON r.id=d.requester_id JOIN users p ON p.id=d.recipient_id JOIN safe_points s ON s.id=d.safe_point_id WHERE d.status='OPEN' AND d.requester_id != ? AND d.recipient_id != ? ORDER BY d.created_at DESC`).all(user.id, user.id);
  res.json({ data: rows });
});

app.get('/api/delivery/:id', (req: AuthedRequest, res) => {
  requireUser(req);
  const leg = getDelivery(String(req.params.id));
  const handoffs = db.prepare('SELECT id, step, created_at, consumed_at, initiated_by, confirmed_by FROM handoff_codes WHERE delivery_leg_id = ? ORDER BY created_at DESC').all(leg.id);
  res.json({ data: { ...leg, handoffs } });
});

app.post('/api/delivery/:id/claim', (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  const leg = getDelivery(String(req.params.id)) as unknown as { id: string; status: string; requester_id: string; recipient_id: string; campus: string };
  if (leg.status !== 'OPEN') throw new ApiError(409, 'NOT_OPEN', 'This delivery leg is no longer open.');
  if (leg.requester_id === user.id || leg.recipient_id === user.id) throw new ApiError(403, 'HANDOFF_CONFLICT', 'A requester or recipient cannot courier their own delivery leg.');
  if (user.campus !== leg.campus) throw new ApiError(400, 'CAMPUS_MISMATCH', 'This delivery leg is for a different verified campus.');

  db.transaction(() => {
    db.prepare('UPDATE delivery_legs SET courier_id=?, status=?, updated_at=? WHERE id=?').run(user.id, 'CLAIMED', now(), leg.id);
    notify(db, leg.requester_id, 'DELIVERY_CLAIM', 'A courier claimed the delivery leg', 'Use the approved safe point and confirm custody with a one-time code.', '/delivery');
    notify(db, user.id, 'DELIVERY_CLAIM', 'Delivery leg claimed', 'Generate a short-lived code only at the physical handoff.', '/delivery');
    addAudit(db, user.id, 'CLAIM_DELIVERY', 'delivery_leg', leg.id);
  })();
  res.json({ data: getDelivery(leg.id) });
});

app.post('/api/delivery/:id/handoff/initiate', (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  const input = parse(req.body, z.object({ step: z.enum(['PICKUP', 'DROPOFF']) }));
  const leg = getDelivery(String(req.params.id)) as unknown as { id: string; courier_id: string | null; status: string };
  if (leg.courier_id !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Only the courier can initiate a handoff confirmation.');
  if ((input.step === 'PICKUP' && leg.status !== 'CLAIMED') || (input.step === 'DROPOFF' && leg.status !== 'PICKUP_CONFIRMED')) {
    throw new ApiError(409, 'INVALID_STATE', 'This handoff step is not ready.');
  }
  const code = String(randomInt(100000, 999999));
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO handoff_codes (id, delivery_leg_id, step, code_hash, expires_at, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id(), leg.id, input.step, createHash('sha256').update(code).digest('hex'), expires, user.id, now());
  addAudit(db, user.id, 'INITIATE_HANDOFF_CODE', 'delivery_leg', leg.id, input.step);
  res.json({ data: { code, expiresAt: expires, step: input.step, warning: 'Show this code only in person at the approved safe point.' } });
});

app.post('/api/delivery/:id/handoff/confirm', (req: AuthedRequest, res) => {
  const user = requireStudent(req);
  const input = parse(req.body, z.object({ step: z.enum(['PICKUP', 'DROPOFF']), code: z.string().regex(/^\d{6}$/) }));
  const leg = getDelivery(String(req.params.id)) as unknown as { id: string; requester_id: string; recipient_id: string; courier_id: string | null; status: string; reward: number };
  if (!leg.courier_id || user.id === leg.courier_id || ![leg.requester_id, leg.recipient_id].includes(user.id)) {
    throw new ApiError(403, 'HANDOFF_CONFLICT', 'Only the receiving party can confirm this handoff.');
  }
  const code = db.prepare('SELECT * FROM handoff_codes WHERE delivery_leg_id=? AND step=? AND code_hash=? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .get(leg.id, input.step, createHash('sha256').update(input.code).digest('hex')) as { id: string; expires_at: string } | undefined;
  if (!code || new Date(code.expires_at) < new Date()) {
    throw new ApiError(400, 'HANDOFF_CODE_INVALID', 'That handoff code is invalid, expired, or already used.');
  }
  const nextStatus = input.step === 'PICKUP' ? 'PICKUP_CONFIRMED' : 'COMPLETED';
  db.transaction(() => {
    db.prepare('UPDATE handoff_codes SET consumed_at=?, confirmed_by=? WHERE id=?').run(now(), user.id, code.id);
    db.prepare('UPDATE delivery_legs SET status=?, updated_at=? WHERE id=?').run(nextStatus, now(), leg.id);
    if (input.step === 'DROPOFF') {
      postLedgerTransaction(db, {
        idempotencyKey: `delivery-settlement-${leg.id}`,
        kind: 'SETTLEMENT',
        reason: 'Confirmed safe-point delivery',
        actorId: user.id,
        contractId: leg.id,
        lines: [
          { userId: leg.requester_id, available: 0, locked: -leg.reward },
          { userId: leg.courier_id!, available: leg.reward, locked: 0, earned: leg.reward },
        ],
      });
      notify(db, leg.courier_id!, 'SETTLEMENT', 'Delivery reward released', `${leg.reward} Dime was released after confirmed custody.`, '/delivery');
      addReliabilityEvent(db, leg.courier_id!, 1, 'POSITIVE_COMPLETION', 'Confirmed safe-point delivery', undefined, user.id);
    }
    addAudit(db, user.id, 'CONFIRM_HANDOFF', 'delivery_leg', leg.id, input.step);
  })();
  res.json({ data: { status: nextStatus } });
});

// Reports
app.post('/api/reports', (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const input = parse(req.body, z.object({
    kind: z.string().trim().min(3).max(60),
    detail: z.string().trim().min(10).max(1000),
    deliveryLegId: z.string().uuid().optional(),
    contractId: z.string().optional(),
  }));
  const reportId = id();
  db.prepare('INSERT INTO reports (id, reporter_id, delivery_leg_id, contract_id, kind, detail, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(reportId, user.id, input.deliveryLegId || null, input.contractId || null, input.kind, input.detail, 'OPEN', now());
  addAudit(db, user.id, 'SUBMIT_REPORT', 'report', reportId, input.kind);
  notify(db, 'mod-ops', 'REPORT', 'New report filed', `${user.display_name} reported: ${input.kind}`, '/admin');
  res.status(201).json({ data: { id: reportId, status: 'OPEN' } });
});

// -----------------------------------------------------------------------------
// Notifications
// -----------------------------------------------------------------------------

app.get('/api/notifications', (req: AuthedRequest, res) => {
  const user = requireUser(req);
  res.json({ data: db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(user.id) });
});

app.post('/api/notifications/:id/read', (req: AuthedRequest, res) => {
  const user = requireUser(req);
  db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(now(), String(req.params.id), user.id);
  res.json({ data: { read: true } });
});

app.post('/api/notifications/read-all', (req: AuthedRequest, res) => {
  const user = requireUser(req);
  db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(), user.id);
  res.json({ data: { readAll: true } });
});

// -----------------------------------------------------------------------------
// Guardian Controls & Consent
// -----------------------------------------------------------------------------

app.get('/api/guardian/controls', (req: AuthedRequest, res) => {
  const guardian = requireRole(req, 'GUARDIAN');
  const controls = db.prepare('SELECT gc.*, u.display_name student_name, u.verified_at FROM guardian_controls gc JOIN users u ON u.id=gc.student_id WHERE gc.guardian_id=?').all(guardian.id);
  res.json({ data: controls });
});

app.get('/api/guardian/activity', (req: AuthedRequest, res) => {
  const guardian = requireRole(req, 'GUARDIAN');
  const relations = db.prepare('SELECT student_id FROM guardian_relationships WHERE guardian_id=?').all(guardian.id) as { student_id: string }[];
  const studentIds = relations.map((r) => r.student_id);
  if (!studentIds.length) return res.json({ data: { contracts: [], ledger: [] } });
  const placeholders = studentIds.map(() => '?').join(',');
  const contracts = db.prepare(`SELECT c.id, c.title, c.reward, c.status, c.created_at, u.display_name student_name FROM writing_contracts c JOIN users u ON u.id = c.requester_id WHERE c.requester_id IN (${placeholders}) ORDER BY c.created_at DESC LIMIT 20`).all(...studentIds);
  const ledger = db.prepare(`SELECT l.*, t.kind, t.reason, t.created_at, u.display_name student_name FROM ledger_lines l JOIN ledger_transactions t ON t.id = l.transaction_id JOIN users u ON u.id = l.user_id WHERE l.user_id IN (${placeholders}) ORDER BY t.created_at DESC LIMIT 30`).all(...studentIds);
  res.json({ data: { contracts, ledger } });
});

app.put('/api/guardian/controls', (req: AuthedRequest, res) => {
  const guardian = requireRole(req, 'GUARDIAN');
  const input = parse(req.body, z.object({
    studentId: z.string(),
    maxPerContract: z.number().int().min(0).max(100000),
    maxPerRollingPeriod: z.number().int().min(0).max(100000),
  }));
  const relation = db.prepare('SELECT 1 FROM guardian_relationships WHERE guardian_id=? AND student_id=? AND consented_at IS NOT NULL').get(guardian.id, input.studentId);
  if (!relation) throw new ApiError(403, 'FORBIDDEN', 'You may only update controls for a consented linked student.');
  db.prepare('UPDATE guardian_controls SET max_per_contract=?, max_per_rolling_period=?, updated_at=? WHERE student_id=? AND guardian_id=?')
    .run(input.maxPerContract, input.maxPerRollingPeriod, now(), input.studentId, guardian.id);
  addAudit(db, guardian.id, 'UPDATE_GUARDIAN_CONTROLS', 'guardian_controls', input.studentId);
  res.json({ data: { updated: true } });
});

app.post('/api/guardian/consent', (req: AuthedRequest, res) => {
  const guardian = requireRole(req, 'GUARDIAN');
  const input = parse(req.body, z.object({ studentId: z.string() }));
  db.prepare('UPDATE guardian_relationships SET consented_at=? WHERE guardian_id=? AND student_id=?').run(now(), guardian.id, input.studentId);
  notify(db, input.studentId, 'GUARDIAN_CONSENT', 'Guardian consent confirmed', 'Your marketplace participation is now unlocked.', '/settings');
  addAudit(db, guardian.id, 'GRANT_GUARDIAN_CONSENT', 'guardian_relationship', input.studentId);
  res.json({ data: { consented: true } });
});

app.post('/api/verification/request', (req: AuthedRequest, res) => {
  const user = requireRole(req, 'STUDENT');
  addAudit(db, user.id, 'REQUEST_VERIFICATION', 'user', user.id);
  notify(db, 'mod-ops', 'VERIFICATION', 'Demo verification request', `${user.display_name} requested pilot verification.`, '/admin');
  res.status(201).json({ data: { status: 'PENDING_REVIEW' } });
});

// -----------------------------------------------------------------------------
// Moderator & Operations Console
// -----------------------------------------------------------------------------

app.get('/api/admin/overview', (req: AuthedRequest, res) => {
  requireModerator(req);
  const data = {
    verification: db.prepare("SELECT id, display_name, campus, age, created_at FROM users WHERE role='STUDENT' AND verified_at IS NULL").all(),
    disputes: db.prepare(`SELECT d.*, c.title, c.reward, c.page_count, c.paper_mode, c.acceptance_criteria,
      r.display_name requester_name, w.display_name writer_name,
      pe.receipt_hash, pe.ocr_status evidence_ocr_status, pe.ocr_confidence evidence_ocr_confidence, pe.ocr_text evidence_ocr_text,
      sa.original_name source_file_name, sa.ocr_text source_ocr_text
      FROM disputes d
      JOIN writing_contracts c ON c.id = d.contract_id
      JOIN users r ON r.id = c.requester_id
      LEFT JOIN users w ON w.id = c.writer_id
      JOIN page_evidence pe ON pe.id = d.evidence_id
      JOIN source_assets sa ON sa.id = pe.asset_id
      WHERE d.status='OPEN' ORDER BY d.created_at`).all(),
    safePoints: db.prepare('SELECT * FROM safe_points ORDER BY active DESC, name').all(),
    reports: db.prepare("SELECT r.*, u.display_name reporter_name FROM reports r JOIN users u ON u.id = r.reporter_id WHERE r.status='OPEN' ORDER BY r.created_at DESC").all(),
    restrictions: db.prepare('SELECT id, display_name, restriction_reason, restricted_at FROM users WHERE restricted_at IS NOT NULL').all(),
    reliability: db.prepare('SELECT u.display_name, r.* FROM reliability_events r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 30').all(),
  };
  addAudit(db, req.user!.id, 'VIEW_ADMIN_OVERVIEW', 'admin', 'overview');
  res.json({ data });
});

app.post('/api/admin/disputes/:id/resolve', (req: AuthedRequest, res) => {
  const moderator = requireModerator(req);
  const input = parse(req.body, z.object({
    outcome: z.enum(['REQUESTER', 'WRITER', 'INCONCLUSIVE']),
    completionPercent: z.number().int().min(0).max(100).optional(),
    reason: z.string().trim().min(5).max(500),
    flagDeliberateMisuse: z.boolean().optional(),
  }));
  const dispute = db.prepare('SELECT * FROM disputes WHERE id=?').get(String(req.params.id)) as {
    id: string; status: string; contract_id: string; evidence_id: string; page_number: number;
  } | undefined;
  if (!dispute) throw new ApiError(404, 'NOT_FOUND', 'Dispute not found.');
  if (dispute.status !== 'OPEN') throw new ApiError(409, 'ALREADY_RESOLVED', 'This dispute has already been resolved.');

  const percent = input.outcome === 'REQUESTER' ? 0 : input.outcome === 'WRITER' ? 100 : (input.completionPercent ?? 50);
  const contract = getContract(dispute.contract_id);

  db.transaction(() => {
    db.prepare("UPDATE disputes SET status='RESOLVED', outcome=?, completion_percent=?, moderator_id=?, moderator_reason=?, resolved_at=? WHERE id=?")
      .run(input.outcome, percent, moderator.id, input.reason, now(), dispute.id);
    db.prepare("UPDATE page_reviews SET status='ADJUDICATED', payout_percent=?, reviewed_by=?, note=? WHERE evidence_id=?")
      .run(percent, moderator.id, input.reason, dispute.evidence_id);

    // Apply reliability consequences if deliberate misuse
    if (input.flagDeliberateMisuse) {
      addReliabilityEvent(db, contract.requester_id as string, -3, 'DELIBERATE_FALSE_DISPUTE', `Moderator determined deliberate false dispute: ${input.reason}`, contract.id as string, moderator.id);
    }

    addAudit(db, moderator.id, 'RESOLVE_DISPUTE', 'dispute', dispute.id, input.reason, { outcome: input.outcome, percent, flagDeliberateMisuse: input.flagDeliberateMisuse });
  })();

  settleIfReady(dispute.contract_id, moderator.id);
  res.json({ data: { resolved: true, payoutPercent: percent } });
});

app.post('/api/admin/users/:id/verify', (req: AuthedRequest, res) => {
  const moderator = requireModerator(req);
  const input = parse(req.body, z.object({ verified: z.boolean(), reason: z.string().trim().max(300).optional() }));
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(String(req.params.id)) as User | undefined;
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
  db.prepare('UPDATE users SET verified_at=? WHERE id=?').run(input.verified ? now() : null, target.id);
  notify(db, target.id, 'VERIFICATION', input.verified ? 'Student status verified' : 'Student verification updated', input.verified ? 'You may now participate in marketplace contracts.' : 'Verification review completed.', '/settings');
  addAudit(db, moderator.id, input.verified ? 'APPROVE_VERIFICATION' : 'REVOKE_VERIFICATION', 'user', target.id, input.reason);
  res.json({ data: { verified: input.verified } });
});

app.post('/api/admin/users/:id/restrict', (req: AuthedRequest, res) => {
  const moderator = requireModerator(req);
  const input = parse(req.body, z.object({ reason: z.string().trim().min(5).max(300), restricted: z.boolean() }));
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(String(req.params.id)) as User | undefined;
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
  if (target.role !== 'STUDENT') throw new ApiError(400, 'INVALID_TARGET', 'Only a student account may be restricted in this MVP.');
  db.prepare('UPDATE users SET restricted_at=?, restriction_reason=? WHERE id=?').run(input.restricted ? now() : null, input.restricted ? input.reason : null, target.id);
  if (input.restricted) {
    addReliabilityEvent(db, target.id, -2, 'SUBSTANTIATED_FAILURE', input.reason, undefined, moderator.id);
  }
  notify(db, target.id, 'RESTRICTION', input.restricted ? 'Marketplace access temporarily restricted' : 'Marketplace access restored', input.reason, '/settings');
  addAudit(db, moderator.id, input.restricted ? 'RESTRICT_ACCOUNT' : 'RESTORE_ACCOUNT', 'user', target.id, input.reason);
  res.json({ data: { restricted: input.restricted } });
});

app.post('/api/admin/safe-points', (req: AuthedRequest, res) => {
  const moderator = requireModerator(req);
  const input = parse(req.body, z.object({
    name: z.string().trim().min(4).max(100),
    campus: z.string().trim().min(3).max(100),
    area: z.string().trim().min(4).max(160),
    hours: z.string().trim().min(4).max(100),
  }));
  const safePointId = id();
  db.prepare('INSERT INTO safe_points (id,name,campus,area,hours) VALUES (?,?,?,?,?)')
    .run(safePointId, input.name, input.campus, input.area, input.hours);
  addAudit(db, moderator.id, 'CREATE_SAFE_POINT', 'safe_point', safePointId, 'Approved safe point created');
  res.status(201).json({ data: { id: safePointId, ...input } });
});

app.put('/api/admin/safe-points/:id', (req: AuthedRequest, res) => {
  const moderator = requireModerator(req);
  const input = parse(req.body, z.object({ active: z.boolean() }));
  db.prepare('UPDATE safe_points SET active=? WHERE id=?').run(input.active ? 1 : 0, String(req.params.id));
  addAudit(db, moderator.id, 'UPDATE_SAFE_POINT', 'safe_point', String(req.params.id), `Active toggled to ${input.active}`);
  res.json({ data: { updated: true } });
});

app.post('/api/admin/reports/:id/resolve', (req: AuthedRequest, res) => {
  const moderator = requireModerator(req);
  const input = parse(req.body, z.object({ note: z.string().trim().min(5).max(400) }));
  db.prepare("UPDATE reports SET status='RESOLVED', resolution_note=?, resolved_at=?, moderator_id=? WHERE id=?")
    .run(input.note, now(), moderator.id, String(req.params.id));
  addAudit(db, moderator.id, 'RESOLVE_REPORT', 'report', String(req.params.id), input.note);
  res.json({ data: { resolved: true } });
});

app.get('/api/admin/audit', (req: AuthedRequest, res) => {
  requireModerator(req);
  res.json({ data: db.prepare('SELECT a.*, u.display_name actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 100').all() });
});

app.post('/api/admin/grants', (req: AuthedRequest, res) => {
  const moderator = requireModerator(req);
  const input = parse(req.body, z.object({
    userId: z.string(),
    amount: z.number().int().min(1).max(100000),
    reason: z.string().trim().min(5).max(300),
    idempotencyKey: z.string().trim().min(8).max(100),
  }));
  const student = db.prepare('SELECT role FROM users WHERE id=?').get(input.userId) as { role: string } | undefined;
  if (!student || student.role !== 'STUDENT') throw new ApiError(400, 'INVALID_TARGET', 'Grants are only for verified student demo wallets.');
  postLedgerTransaction(db, {
    idempotencyKey: input.idempotencyKey,
    kind: 'GRANT',
    reason: input.reason,
    actorId: moderator.id,
    lines: [{ userId: input.userId, available: input.amount, locked: 0 }],
  });
  notify(db, input.userId, 'GRANT', 'Audited platform grant received', `An operations grant of ${input.amount} Dime was added to your balance: ${input.reason}`, '/wallet');
  addAudit(db, moderator.id, 'AUDITED_GRANT', 'wallet', input.userId, input.reason, { amount: input.amount });
  res.status(201).json({ data: { granted: input.amount } });
});

// Periodic background auto-accept check (runs every 60s)
if (process.env.VITEST !== 'true') {
  setInterval(() => {
    try {
      autoAcceptExpiredReviews(db, 48);
    } catch {
      // background silent catch
    }
  }, 60000);
}

const distDir = join(process.cwd(), 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      return res.sendFile(join(distDir, 'index.html'));
    }
    next();
  });
}

app.use((_req, _res) => {
  throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const err = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Unexpected server error.');
  if (!(error instanceof ApiError)) console.error(error);
  res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
});

if (process.env.VITEST !== 'true') {
  app.listen(port, () => console.log(`Assingly API listening on http://localhost:${port}`));
}

export { app, db };
