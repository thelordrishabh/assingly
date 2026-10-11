import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Db = Database.Database;
export type LedgerLine = { userId: string; available: number; locked: number; earned?: number };

const iso = () => new Date().toISOString();
const id = () => randomUUID();

export function openDatabase(path = process.env.DATABASE_PATH || './data/assingly.db') {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8'));

  // Ensure extended columns exist if DB was created previously
  try { db.exec('ALTER TABLE reports ADD COLUMN resolution_note TEXT;'); } catch {}
  try { db.exec('ALTER TABLE reports ADD COLUMN resolved_at TEXT;'); } catch {}
  try { db.exec('ALTER TABLE reports ADD COLUMN moderator_id TEXT REFERENCES users(id);'); } catch {}
  try { db.exec('ALTER TABLE contract_offers ADD COLUMN note TEXT;'); } catch {}
  try { db.exec('ALTER TABLE source_assets ADD COLUMN ocr_text TEXT;'); } catch {}
  try { db.exec('ALTER TABLE page_evidence ADD COLUMN ocr_text TEXT;'); } catch {}

  seedDatabase(db);
  return db;
}

export function postLedgerTransaction(
  db: Db,
  input: { idempotencyKey: string; kind: string; reason: string; actorId?: string; contractId?: string; lines: LedgerLine[] },
) {
  const existing = db.prepare('SELECT id FROM ledger_transactions WHERE idempotency_key = ?').get(input.idempotencyKey) as { id: string } | undefined;
  if (existing) return { id: existing.id, repeated: true };
  if (!input.lines.length) throw new Error('A ledger transaction needs a line.');
  const transactionId = id();
  const now = iso();

  db.transaction(() => {
    const combined = new Map<string, LedgerLine>();
    for (const line of input.lines) {
      const previous = combined.get(line.userId) || { userId: line.userId, available: 0, locked: 0, earned: 0 };
      combined.set(line.userId, {
        userId: line.userId,
        available: previous.available + line.available,
        locked: previous.locked + line.locked,
        earned: (previous.earned || 0) + (line.earned || 0),
      });
    }
    for (const line of combined.values()) {
      const wallet = db.prepare('SELECT available, locked, lifetime_earned FROM wallets WHERE user_id = ?').get(line.userId) as { available: number; locked: number; lifetime_earned: number } | undefined;
      if (!wallet) throw new Error('Wallet not found.');
      if (wallet.available + line.available < 0 || wallet.locked + line.locked < 0 || wallet.lifetime_earned + (line.earned || 0) < 0) {
        throw new Error('This action would create an invalid Dime balance.');
      }
    }
    db.prepare('INSERT INTO ledger_transactions (id, idempotency_key, kind, reason, actor_id, contract_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(transactionId, input.idempotencyKey, input.kind, input.reason, input.actorId || null, input.contractId || null, now);
    for (const line of input.lines) {
      db.prepare('INSERT INTO ledger_lines (id, transaction_id, user_id, available_delta, locked_delta, earned_delta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id(), transactionId, line.userId, line.available, line.locked, line.earned || 0, now);
    }
    for (const line of combined.values()) {
      db.prepare('UPDATE wallets SET available = available + ?, locked = locked + ?, lifetime_earned = lifetime_earned + ?, updated_at = ? WHERE user_id = ?')
        .run(line.available, line.locked, line.earned || 0, now, line.userId);
    }
  })();
  return { id: transactionId, repeated: false };
}

export function addAudit(db: Db, actorId: string | undefined, action: string, entityType: string, entityId: string, reason?: string, metadata?: unknown) {
  db.prepare('INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, reason, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id(), actorId || null, action, entityType, entityId, reason || null, metadata ? JSON.stringify(metadata) : null, iso());
}

export function notify(db: Db, userId: string, kind: string, title: string, body: string, link?: string) {
  db.prepare('INSERT INTO notifications (id, user_id, kind, title, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id(), userId, kind, title, body, link || null, iso());
}

export function addReliabilityEvent(
  db: Db,
  userId: string,
  delta: number,
  kind: 'SUBSTANTIATED_FAILURE' | 'DELIBERATE_FALSE_DISPUTE' | 'POSITIVE_COMPLETION' | 'MODERATOR_ADJUSTMENT',
  reason: string,
  contractId?: string,
  actorId?: string,
) {
  const eventId = id();
  db.prepare('INSERT INTO reliability_events (id, user_id, delta, kind, reason, contract_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(eventId, userId, delta, kind, reason, contractId || null, actorId || null, iso());
  return eventId;
}

export function allocationForPage(reward: number, pageCount: number, pageNumber: number) {
  const base = Math.floor(reward / pageCount);
  return base + (pageNumber <= reward % pageCount ? 1 : 0);
}

export function lateDiscountPercent(deadlineAt: string, at = new Date()) {
  const overdue = at.getTime() - new Date(deadlineAt).getTime();
  if (overdue <= 0) return 0;
  return Math.min(50, Math.ceil(overdue / (24 * 60 * 60 * 1000)) * 10);
}

export function autoAcceptExpiredReviews(db: Db, cutoffHours = 48): number {
  const cutoffTime = new Date(Date.now() - cutoffHours * 3600000).toISOString();
  // Find contracts in SUBMITTED or IN_REVIEW where submitted_at is older than cutoff
  const contracts = db.prepare(`SELECT id, requester_id, page_count FROM writing_contracts WHERE status IN ('SUBMITTED', 'IN_REVIEW') AND submitted_at IS NOT NULL AND submitted_at <= ?`).all(cutoffTime) as { id: string; requester_id: string; page_count: number }[];
  let count = 0;
  for (const contract of contracts) {
    const evidences = db.prepare('SELECT id, page_number FROM page_evidence WHERE contract_id = ?').all(contract.id) as { id: string; page_number: number }[];
    for (const ev of evidences) {
      const existing = db.prepare('SELECT 1 FROM page_reviews WHERE evidence_id = ?').get(ev.id);
      if (!existing) {
        db.prepare('INSERT INTO page_reviews (id, evidence_id, contract_id, page_number, status, reason, note, reviewed_by, payout_percent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id(), ev.id, contract.id, ev.page_number, 'AUTO_ACCEPTED', '48h auto-acceptance without dispute', 'Auto-accepted per policy', contract.requester_id, 100, iso());
        count++;
      }
    }
  }
  return count;
}

function seedDatabase(db: Db) {
  const count = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  if (count) return;
  const users = [
    ['stu-aanya', 'aanya@example.test', 'Aanya Rao', 'STUDENT', 20, 'Northfield Campus', true],
    ['stu-kabir', 'kabir@example.test', 'Kabir Verma', 'STUDENT', 21, 'Northfield Campus', true],
    ['stu-meera', 'meera@example.test', 'Meera Shah', 'STUDENT', 19, 'Northfield Campus', true],
    ['stu-nikhil', 'nikhil@example.test', 'Nikhil Patel', 'STUDENT', 16, 'Northfield Campus', true],
    ['guardian-rhea', 'rhea@example.test', 'Rhea Patel', 'GUARDIAN', 42, null, true],
    ['mod-ops', 'ops@example.test', 'Assingly Operations', 'MODERATOR', 30, null, true],
  ] as const;
  const now = iso();
  for (const [userId, email, name, role, age, campus, verified] of users) {
    db.prepare('INSERT INTO users (id, email, display_name, role, age, campus, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, email, name, role, age, campus, verified ? now : null, now);
    db.prepare('INSERT INTO wallets (user_id) VALUES (?)').run(userId);
  }
  for (const [userId, , , role] of users) {
    if (role === 'STUDENT') postLedgerTransaction(db, { idempotencyKey: `seed-grant-${userId}`, kind: 'GRANT', reason: 'Clearly labelled local demo grant', actorId: 'mod-ops', lines: [{ userId, available: 3000, locked: 0 }] });
  }
  db.prepare('INSERT INTO guardian_relationships (id, guardian_id, student_id, consented_at) VALUES (?, ?, ?, ?)').run(id(), 'guardian-rhea', 'stu-nikhil', now);
  db.prepare('INSERT INTO guardian_controls (student_id, guardian_id, max_per_contract, max_per_rolling_period, rolling_period_days, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('stu-nikhil', 'guardian-rhea', 800, 1200, 30, now);
  const safePoints = [
    ['safe-library', 'Library Help Desk', 'Northfield Campus', 'Ground floor, main library', 'Mon–Sat, 09:00–18:00'],
    ['safe-gate', 'North Gate Security Desk', 'Northfield Campus', 'North entrance staffed desk', 'Daily, 08:00–20:00'],
  ];
  for (const point of safePoints) db.prepare('INSERT INTO safe_points (id, name, campus, area, hours) VALUES (?, ?, ?, ?, ?)').run(...point);
  const uploadDir = process.env.UPLOAD_DIR || './data/private-uploads';
  mkdirSync(uploadDir, { recursive: true });
  const makeSource = (ownerId: string, fileName: string, contents: string) => {
    const assetId = `asset-${fileName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
    const storageKey = `${assetId}.txt`;
    const location = join(uploadDir, storageKey);
    if (!existsSync(location)) writeFileSync(location, contents);
    db.prepare('INSERT INTO source_assets (id, owner_id, storage_key, original_name, content_type, bytes, sha256, ocr_status, ocr_confidence, ocr_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(assetId, ownerId, storageKey, fileName, 'text/plain', Buffer.byteLength(contents), createHash('sha256').update(contents).digest('hex'), 'READY', 0.96, contents, now);
    return assetId;
  };
  const openSource = makeSource('stu-aanya', 'History_notes.txt', 'Demo source material: a complete authorized copying-only outline about local history.');
  const notebookSource = makeSource('stu-nikhil', 'Biology_diagrams.txt', 'Demo source material: labelled biology diagrams provided by the requester.');
  const closedSource = makeSource('stu-aanya', 'Literature_extract.txt', 'Demo source material: licensed literature class extract for copying practice.');
  const disputeSource = makeSource('stu-aanya', 'Chemistry_formulas.txt', 'Demo source material: complete chemistry lecture notes for handwritten copy.');
  const future = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const createContract = (values: { id: string; requester: string; writer?: string; title: string; summary: string; status: string; paper: string; pages: number; reward: number; delivery: number; source: string; submittedAt?: string }) => {
    db.prepare(`INSERT INTO writing_contracts (id, requester_id, writer_id, title, summary, status, paper_mode, page_count, reward, delivery_reward, deadline_at, safe_point_id, source_asset_id, acceptance_criteria, copying_attested_at, accepted_version, submitted_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'safe-library', ?, 'Ruled paper, blue or black pen, legible headings.', ?, ?, ?, ?, ?)`)
      .run(values.id, values.requester, values.writer || null, values.title, values.summary, values.status, values.paper, values.pages, values.reward, values.delivery, future, values.source, now, values.writer ? 1 : null, values.submittedAt || null, now, now);
    const terms = JSON.stringify({ pageCount: values.pages, reward: values.reward, paperMode: values.paper, deadlineAt: future, lateDiscount: '10% per started day, capped at 50%' });
    db.prepare('INSERT INTO contract_versions (id, contract_id, version, terms_json, source_asset_id, proposed_by, accepted_at, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
      .run(id(), values.id, terms, values.source, values.requester, values.writer ? now : null, now);
  };
  createContract({ id: 'contract-open-writing', requester: 'stu-aanya', title: 'Copy seminar notes into 4 clear pages', summary: 'Complete supplied notes only. No answers or new content.', status: 'OPEN', paper: 'WRITER_SUPPLIED', pages: 4, reward: 640, delivery: 0, source: openSource });
  postLedgerTransaction(db, { idempotencyKey: 'seed-lock-open-writing', kind: 'ESCROW_LOCK', reason: 'Demo writing contract escrow', actorId: 'stu-aanya', contractId: 'contract-open-writing', lines: [{ userId: 'stu-aanya', available: -640, locked: 640 }] });

  // Seed structured counter-offer on open writing contract from Kabir
  db.prepare('INSERT INTO contract_offers (id, contract_id, proposer_id, reward, deadline_at, page_count, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('offer-demo-1', 'contract-open-writing', 'stu-kabir', 700, new Date(Date.now() + 96 * 60 * 60 * 1000).toISOString(), 4, 'PENDING', 'I can produce clean calligraphy with indexed margins', now);

  createContract({ id: 'contract-notebook-demo', requester: 'stu-nikhil', writer: 'stu-kabir', title: 'Copy labelled biology diagrams', summary: 'A requester-supplied notebook uses safe-point delivery legs.', status: 'ACCEPTED', paper: 'REQUESTER_NOTEBOOK', pages: 3, reward: 480, delivery: 50, source: notebookSource });
  postLedgerTransaction(db, { idempotencyKey: 'seed-lock-notebook', kind: 'ESCROW_LOCK', reason: 'Demo notebook contract and delivery escrow', actorId: 'stu-nikhil', contractId: 'contract-notebook-demo', lines: [{ userId: 'stu-nikhil', available: -580, locked: 580 }] });
  for (const [legId, recipient, direction, description] of [
    ['delivery-inbound-demo', 'stu-kabir', 'INBOUND_NOTEBOOK', 'Sealed requester-supplied notebook'],
    ['delivery-return-demo', 'stu-nikhil', 'RETURN_WORK', 'Completed notebook in sealed folder'],
  ]) db.prepare('INSERT INTO delivery_legs (id, writing_contract_id, requester_id, recipient_id, direction, status, reward, campus, safe_point_id, item_description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(legId, 'contract-notebook-demo', 'stu-nikhil', recipient, direction, 'OPEN', 50, 'Northfield Campus', 'safe-library', description, now, now);

  // Seed contract with open dispute for moderator review
  createContract({ id: 'contract-disputed-demo', requester: 'stu-aanya', writer: 'stu-meera', title: 'Copy chemistry lecture formulas', summary: 'Contract with submitted evidence and an open page dispute for demonstration.', status: 'DISPUTED', paper: 'WRITER_SUPPLIED', pages: 2, reward: 300, delivery: 0, source: disputeSource, submittedAt: now });
  postLedgerTransaction(db, { idempotencyKey: 'seed-lock-disputed', kind: 'ESCROW_LOCK', reason: 'Demo disputed contract escrow', actorId: 'stu-aanya', contractId: 'contract-disputed-demo', lines: [{ userId: 'stu-aanya', available: -300, locked: 300 }] });
  const ev1 = 'evidence-disp-1'; const ev2 = 'evidence-disp-2';
  db.prepare('INSERT INTO page_evidence (id, contract_id, page_number, asset_id, receipt_hash, ocr_status, ocr_confidence, ocr_text, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ev1, 'contract-disputed-demo', 1, disputeSource, createHash('sha256').update('disp-1').digest('hex'), 'READY', 0.94, 'Page 1 formulas: H2O + CO2 -> H2CO3', now);
  db.prepare('INSERT INTO page_evidence (id, contract_id, page_number, asset_id, receipt_hash, ocr_status, ocr_confidence, ocr_text, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ev2, 'contract-disputed-demo', 2, disputeSource, createHash('sha256').update('disp-2').digest('hex'), 'LOW_CONFIDENCE', 0.68, 'Page 2 formula symbols illegible or smudged', now);
  // Page 1 accepted, page 2 disputed
  db.prepare('INSERT INTO page_reviews (id, evidence_id, contract_id, page_number, status, reason, reviewed_by, payout_percent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id(), ev1, 'contract-disputed-demo', 1, 'ACCEPTED', 'Clear and legible equations', 'stu-aanya', 100, now);
  db.prepare('INSERT INTO page_reviews (id, evidence_id, contract_id, page_number, status, reason, note, reviewed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id(), ev2, 'contract-disputed-demo', 2, 'DISPUTED', 'ILLEGIBLE', 'Equation subscripts are smudged on lines 4-8', 'stu-aanya', now);
  db.prepare('INSERT INTO disputes (id, contract_id, evidence_id, page_number, reason, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('dispute-demo-1', 'contract-disputed-demo', ev2, 2, 'ILLEGIBLE', 'Equation subscripts are smudged on lines 4-8', 'OPEN', now);

  // Seed sample report on delivery
  db.prepare("INSERT INTO reports (id, reporter_id, delivery_leg_id, kind, detail, status, created_at) VALUES (?, ?, ?, ?, ?, 'OPEN', ?)")
    .run('report-demo-1', 'stu-nikhil', 'delivery-inbound-demo', 'SAFE_POINT_QUERY', 'Desk was briefly unstaffed between 14:00-14:15. Resolved upon second visit.', now);

  createContract({ id: 'contract-completed-demo', requester: 'stu-aanya', writer: 'stu-kabir', title: 'Copy a literature extract', summary: 'Closed demo contract with payout and refund ledger history.', status: 'SETTLED', paper: 'WRITER_SUPPLIED', pages: 3, reward: 360, delivery: 0, source: closedSource });
  db.prepare('UPDATE writing_contracts SET settled_at = ? WHERE id = ?').run(now, 'contract-completed-demo');
  postLedgerTransaction(db, { idempotencyKey: 'seed-lock-completed', kind: 'ESCROW_LOCK', reason: 'Historical demo escrow', actorId: 'stu-aanya', contractId: 'contract-completed-demo', lines: [{ userId: 'stu-aanya', available: -360, locked: 360 }] });
  postLedgerTransaction(db, { idempotencyKey: 'seed-completed-settlement', kind: 'SETTLEMENT', reason: 'Historical demo pro-rata settlement', actorId: 'mod-ops', contractId: 'contract-completed-demo', lines: [
    { userId: 'stu-aanya', available: 120, locked: -360 }, { userId: 'stu-kabir', available: 240, locked: 0, earned: 240 },
  ] });
  for (let page = 1; page <= 3; page++) {
    const evidenceId = `evidence-completed-${page}`;
    db.prepare('INSERT INTO page_evidence (id, contract_id, page_number, asset_id, receipt_hash, ocr_status, ocr_confidence, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(evidenceId, 'contract-completed-demo', page, closedSource, createHash('sha256').update(`evidence-${page}`).digest('hex'), 'READY', 0.89, now);
    db.prepare('INSERT INTO page_reviews (id, evidence_id, contract_id, page_number, status, reason, reviewed_by, payout_percent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id(), evidenceId, 'contract-completed-demo', page, 'ADJUDICATED', 'Demo review', 'mod-ops', page === 3 ? 0 : 100, now);
  }
  db.prepare('INSERT INTO reliability_events (id, user_id, delta, kind, reason, contract_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id(), 'stu-kabir', 2, 'POSITIVE_COMPLETION', 'Two accepted pages in demo settlement', 'contract-completed-demo', 'mod-ops', now);
  notify(db, 'stu-aanya', 'REVIEW', 'A request is ready for writers', 'Your 4-page copying request is published and securely funded.', '/opportunities');
  notify(db, 'stu-kabir', 'OPPORTUNITY', 'A copying request matches your campus', 'Review the terms before accepting. You never stake Dime.', '/opportunities');
  notify(db, 'stu-nikhil', 'HANDOFF', 'Notebook delivery leg is ready to claim', 'A courier can claim it at the Library Help Desk.', '/delivery');
  addAudit(db, 'mod-ops', 'SEED_DEMO', 'workspace', 'local-demo', 'Fictional demo data created');
}
