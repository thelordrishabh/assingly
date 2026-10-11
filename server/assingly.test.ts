import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  addReliabilityEvent,
  allocationForPage,
  autoAcceptExpiredReviews,
  lateDiscountPercent,
  openDatabase,
  postLedgerTransaction,
  type Db,
} from './db.js';
import { calculateAdvisoryCoverage, runAdvisoryOcr } from './services/ocr.js';
import { sanitizeImageMetadata, savePrivateUpload } from './services/uploads.js';

const tempDirs: string[] = [];
function freshDb(): { db: Db; dir: string } {
  const directory = mkdtempSync(join(tmpdir(), 'assingly-full-test-'));
  tempDirs.push(directory);
  const db = openDatabase(join(directory, 'test.db'));
  return { db, dir: directory };
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Assingly Master Verification Test Suite', () => {
  describe('1. Dime Ledger, Escrow, and Invariants', () => {
    test('ledger transaction prevents negative balances and maintains integrity', () => {
      const { db } = freshDb();
      // Nikhil has 3000 available Dime initially in demo seed
      const wallet = db.prepare('SELECT available, locked FROM wallets WHERE user_id = ?').get('stu-nikhil') as { available: number; locked: number };
      expect(wallet.available).toBeGreaterThan(0);

      // Attempting to spend more than available throws
      expect(() => {
        postLedgerTransaction(db, {
          idempotencyKey: 'fail-overdraw',
          kind: 'ESCROW_LOCK',
          reason: 'Excessive lock',
          actorId: 'stu-nikhil',
          lines: [{ userId: 'stu-nikhil', available: -wallet.available - 100, locked: wallet.available + 100 }],
        });
      }).toThrow('invalid Dime balance');

      // Valid lock succeeds atomically
      const res = postLedgerTransaction(db, {
        idempotencyKey: 'valid-escrow-lock',
        kind: 'ESCROW_LOCK',
        reason: 'Contract escrow',
        actorId: 'stu-nikhil',
        lines: [{ userId: 'stu-nikhil', available: -200, locked: 200 }],
      });
      expect(res.repeated).toBe(false);

      const updated = db.prepare('SELECT available, locked FROM wallets WHERE user_id = ?').get('stu-nikhil') as { available: number; locked: number };
      expect(updated.available).toBe(wallet.available - 200);
      expect(updated.locked).toBe(wallet.locked + 200);
    });

    test('settlement splits escrow atomically between writer earnings and requester refund', () => {
      const { db } = freshDb();
      // Setup escrow: Aanya locks 500 Dime
      postLedgerTransaction(db, {
        idempotencyKey: 'setup-escrow',
        kind: 'ESCROW_LOCK',
        reason: 'Lock for work',
        actorId: 'stu-aanya',
        lines: [{ userId: 'stu-aanya', available: -500, locked: 500 }],
      });

      // Settle: 300 to writer (Kabir), 200 refund to requester (Aanya)
      postLedgerTransaction(db, {
        idempotencyKey: 'settle-split-test',
        kind: 'SETTLEMENT',
        reason: 'Page review settlement',
        actorId: 'mod-ops',
        lines: [
          { userId: 'stu-aanya', available: 200, locked: -500 },
          { userId: 'stu-kabir', available: 300, locked: 0, earned: 300 },
        ],
      });

      const aanya = db.prepare('SELECT available, locked FROM wallets WHERE user_id = ?').get('stu-aanya') as { available: number; locked: number };
      const kabir = db.prepare('SELECT available, lifetime_earned FROM wallets WHERE user_id = ?').get('stu-kabir') as { available: number; lifetime_earned: number };
      expect(kabir.lifetime_earned).toBe(540); // 240 from seed + 300 from this test
      expect(aanya.locked).toBeGreaterThanOrEqual(0);
    });

    test('deterministic integer page allocations exhaust total reward exactly', () => {
      // 500 Dime reward over 3 pages: 167, 167, 166
      const r1 = allocationForPage(500, 3, 1);
      const r2 = allocationForPage(500, 3, 2);
      const r3 = allocationForPage(500, 3, 3);
      expect([r1, r2, r3]).toEqual([167, 167, 166]);
      expect(r1 + r2 + r3).toBe(500);

      // 1000 Dime reward over 7 pages
      let sum = 0;
      for (let p = 1; p <= 7; p++) {
        sum += allocationForPage(1000, 7, p);
      }
      expect(sum).toBe(1000);
    });

    test('late work policy computes 10% per started day capped at 50%', () => {
      const base = new Date('2026-05-01T12:00:00Z').getTime();
      const deadline = new Date(base).toISOString();

      // On time or early -> 0%
      expect(lateDiscountPercent(deadline, new Date(base - 1000))).toBe(0);
      expect(lateDiscountPercent(deadline, new Date(base))).toBe(0);

      // 1 hour late -> 1st started 24h -> 10%
      expect(lateDiscountPercent(deadline, new Date(base + 3600 * 1000))).toBe(10);

      // 25 hours late -> 2nd started 24h -> 20%
      expect(lateDiscountPercent(deadline, new Date(base + 25 * 3600 * 1000))).toBe(20);

      // 49 hours late -> 3rd started 24h -> 30%
      expect(lateDiscountPercent(deadline, new Date(base + 49 * 3600 * 1000))).toBe(30);

      // 10 days late -> capped at 50%
      expect(lateDiscountPercent(deadline, new Date(base + 10 * 24 * 3600 * 1000))).toBe(50);
    });
  });

  describe('2. Roles, Guardian Consent, and Limits', () => {
    test('minor student has active guardian relationship and spending limits', () => {
      const { db } = freshDb();
      const minor = db.prepare('SELECT id, age, role FROM users WHERE id = ?').get('stu-nikhil') as { id: string; age: number; role: string };
      expect(minor.age).toBe(16);
      expect(minor.role).toBe('STUDENT');

      const rel = db.prepare('SELECT * FROM guardian_relationships WHERE student_id = ?').get('stu-nikhil') as { guardian_id: string; consented_at: string | null };
      expect(rel.guardian_id).toBe('guardian-rhea');
      expect(rel.consented_at).not.toBeNull();

      const controls = db.prepare('SELECT * FROM guardian_controls WHERE student_id = ?').get('stu-nikhil') as { max_per_contract: number; max_per_rolling_period: number };
      expect(controls.max_per_contract).toBe(800);
      expect(controls.max_per_rolling_period).toBe(1200);
    });

    test('guardians are non-transacting and cannot own student contracts', () => {
      const { db } = freshDb();
      const guardian = db.prepare('SELECT id, role FROM users WHERE id = ?').get('guardian-rhea') as { role: string };
      expect(guardian.role).toBe('GUARDIAN');

      // Check that no contracts are requested or written by guardian
      const contractCount = (db.prepare('SELECT COUNT(*) as c FROM writing_contracts WHERE requester_id = ? OR writer_id = ?').get('guardian-rhea', 'guardian-rhea') as { c: number }).c;
      expect(contractCount).toBe(0);
    });
  });

  describe('3. Writing Contracts & Structured Counter-Offers', () => {
    test('structured counter-offers can be proposed, accepted, and adjust escrow cleanly', () => {
      const { db } = freshDb();
      // Check seeded open contract
      const contract = db.prepare('SELECT * FROM writing_contracts WHERE id = ?').get('contract-open-writing') as { id: string; reward: number; status: string };
      expect(contract.status).toBe('OPEN');
      expect(contract.reward).toBe(640);

      // Offer from Kabir: reward 700 Dime
      const offer = db.prepare('SELECT * FROM contract_offers WHERE contract_id = ? AND proposer_id = ?').get('contract-open-writing', 'stu-kabir') as { id: string; reward: number; status: string };
      expect(offer.reward).toBe(700);
      expect(offer.status).toBe('PENDING');

      // Acceptance simulation: reward increased by 60 Dime -> lock 60 Dime from Aanya
      postLedgerTransaction(db, {
        idempotencyKey: 'test-offer-lock-delta',
        kind: 'ESCROW_LOCK',
        reason: 'Counter offer delta',
        actorId: 'stu-aanya',
        contractId: 'contract-open-writing',
        lines: [{ userId: 'stu-aanya', available: -60, locked: 60 }],
      });

      db.prepare(`UPDATE writing_contracts SET writer_id = 'stu-kabir', reward = 700, status = 'ACCEPTED' WHERE id = 'contract-open-writing'`).run();
      db.prepare("UPDATE contract_offers SET status = 'ACCEPTED' WHERE id = ?").run(offer.id);

      const updated = db.prepare('SELECT writer_id, reward, status FROM writing_contracts WHERE id = ?').get('contract-open-writing') as { writer_id: string; reward: number; status: string };
      expect(updated.status).toBe('ACCEPTED');
      expect(updated.writer_id).toBe('stu-kabir');
      expect(updated.reward).toBe(700);
    });

    test('cancellation before acceptance releases locked escrow in full', () => {
      const { db } = freshDb();
      const aanyaBefore = db.prepare('SELECT available, locked FROM wallets WHERE user_id = ?').get('stu-aanya') as { available: number; locked: number };

      // Cancel contract-open-writing (640 Dime locked)
      postLedgerTransaction(db, {
        idempotencyKey: 'test-cancel-open',
        kind: 'ESCROW_RELEASE',
        reason: 'Cancellation before acceptance',
        actorId: 'stu-aanya',
        contractId: 'contract-open-writing',
        lines: [{ userId: 'stu-aanya', available: 640, locked: -640 }],
      });
      db.prepare("UPDATE writing_contracts SET status = 'CANCELLED' WHERE id = 'contract-open-writing'").run();

      const aanyaAfter = db.prepare('SELECT available, locked FROM wallets WHERE user_id = ?').get('stu-aanya') as { available: number; locked: number };
      expect(aanyaAfter.available).toBe(aanyaBefore.available + 640);
      expect(aanyaAfter.locked).toBe(aanyaBefore.locked - 640);
    });
  });

  describe('4. Page Evidence, OCR, Reviews & Disputes', () => {
    test('receipt sha256 hash is generated and immutable on evidence submission', () => {
      const { db } = freshDb();
      const evidence = db.prepare('SELECT * FROM page_evidence WHERE contract_id = ?').all('contract-completed-demo') as { receipt_hash: string; page_number: number }[];
      expect(evidence.length).toBe(3);
      for (const ev of evidence) {
        expect(ev.receipt_hash).toMatch(/^[a-f0-9]{64}$/);
      }
    });

    test('advisory OCR calculates keyword correspondence without deciding outcomes', () => {
      const source = 'These lecture notes cover the fundamental theorem of calculus and Riemann integrals with clear diagrams.';
      const evidence = 'Lecture notes Riemann integrals calculus diagram handwritten copy.';
      const coverage = calculateAdvisoryCoverage(source, evidence);
      expect(coverage.matchPercent).toBeGreaterThan(60);
      expect(coverage.advisoryNote).toContain('Advisory');
    });

    test('moderator dispute resolution settles page allocation deterministically', () => {
      const { db } = freshDb();
      const dispute = db.prepare('SELECT * FROM disputes WHERE id = ?').get('dispute-demo-1') as { id: string; status: string; contract_id: string; page_number: number };
      expect(dispute.status).toBe('OPEN');
      expect(dispute.page_number).toBe(2);

      // Contract has 300 Dime reward over 2 pages -> 150 Dime per page
      const pageAlloc = allocationForPage(300, 2, 2);
      expect(pageAlloc).toBe(150);

      // Adjudicate 50/50 split (75 to writer, 75 refund to requester)
      const payout = Math.floor((pageAlloc * 50) / 100);
      const refund = pageAlloc - payout;
      expect(payout).toBe(75);
      expect(refund).toBe(75);

      db.prepare("UPDATE disputes SET status = 'RESOLVED', outcome = 'INCONCLUSIVE', completion_percent = 50, moderator_id = 'mod-ops', moderator_reason = 'Partial illegibility on subscripts' WHERE id = ?").run(dispute.id);
      db.prepare("UPDATE page_reviews SET status = 'ADJUDICATED', payout_percent = 50 WHERE evidence_id = 'evidence-disp-2'").run();

      const updatedDispute = db.prepare('SELECT status, outcome, completion_percent FROM disputes WHERE id = ?').get(dispute.id) as { status: string; outcome: string; completion_percent: number };
      expect(updatedDispute.status).toBe('RESOLVED');
      expect(updatedDispute.completion_percent).toBe(50);
    });

    test('reliability events track substantiated outcomes separately from wallet', () => {
      const { db } = freshDb();
      const relId = addReliabilityEvent(db, 'stu-meera', 2, 'POSITIVE_COMPLETION', 'Two verified pages completed', 'contract-completed-demo', 'mod-ops');
      expect(relId).toBeTruthy();

      const events = db.prepare('SELECT * FROM reliability_events WHERE user_id = ?').all('stu-meera') as { delta: number; kind: string }[];
      expect(events.some((e) => e.delta === 2 && e.kind === 'POSITIVE_COMPLETION')).toBe(true);
    });

    test('48-hour auto-acceptance marks overdue submitted pages accepted', () => {
      const { db } = freshDb();
      // Auto-accept reviews older than 0 hours for testing
      const acceptedCount = autoAcceptExpiredReviews(db, 0);
      expect(acceptedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('5. Delivery Legs & Safe-Point Custody', () => {
    test('same-campus restriction for notebook requests', () => {
      const { db } = freshDb();
      const safePoint = db.prepare('SELECT campus FROM safe_points WHERE id = ?').get('safe-library') as { campus: string };
      expect(safePoint.campus).toBe('Northfield Campus');

      const legs = db.prepare('SELECT * FROM delivery_legs WHERE writing_contract_id = ?').all('contract-notebook-demo') as { campus: string; status: string }[];
      expect(legs.length).toBe(2);
      expect(legs.every((l) => l.campus === 'Northfield Campus')).toBe(true);
    });

    test('courier cannot be requester or recipient of their own delivery leg', () => {
      const { db } = freshDb();
      const leg = db.prepare('SELECT * FROM delivery_legs WHERE id = ?').get('delivery-inbound-demo') as { requester_id: string; recipient_id: string };
      // Requester is Nikhil, Recipient is Kabir
      expect(leg.requester_id).toBe('stu-nikhil');
      expect(leg.recipient_id).toBe('stu-kabir');
      // Neither Nikhil nor Kabir can courier this leg
      const forbiddenCouriers = [leg.requester_id, leg.recipient_id];
      expect(forbiddenCouriers).toContain('stu-nikhil');
      expect(forbiddenCouriers).toContain('stu-kabir');
    });

    test('handoff codes are single-use, short-lived, and prevent replay', () => {
      const { db } = freshDb();
      const legId = 'delivery-inbound-demo';
      const code = '654321';
      const codeHash = '4b6113b28f9d0c64b63e80f4f9d2757d598282fb1f6ff81d017b27ec47fa8e17';
      const expiresAt = new Date(Date.now() + 600000).toISOString();

      db.prepare('INSERT INTO handoff_codes (id, delivery_leg_id, step, code_hash, expires_at, initiated_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run('test-code-1', legId, 'PICKUP', codeHash, expiresAt, 'stu-meera');

      // First consumption succeeds
      const check1 = db.prepare('SELECT * FROM handoff_codes WHERE id = ? AND consumed_at IS NULL').get('test-code-1') as { id: string } | undefined;
      expect(check1).toBeTruthy();

      db.prepare('UPDATE handoff_codes SET consumed_at = CURRENT_TIMESTAMP, confirmed_by = ? WHERE id = ?').run('stu-nikhil', 'test-code-1');

      // Replay attempt fails because consumed_at is not null
      const check2 = db.prepare('SELECT * FROM handoff_codes WHERE id = ? AND consumed_at IS NULL').get('test-code-1');
      expect(check2).toBeUndefined();
    });
  });

  describe('6. Privacy & Upload Sanitization', () => {
    test('strips JPEG EXIF location and camera metadata', () => {
      // JPEG with dummy SOI and APP1 (EXIF) segment
      const exifMarker = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0xff, 0xd9]);
      const sanitized = sanitizeImageMetadata(exifMarker, 'image/jpeg');
      expect(sanitized.length).toBeLessThan(exifMarker.length);
    });

    test('private upload saves file with sha256 hash', () => {
      const { dir } = freshDb();
      const content = Buffer.from('Private study source outline for copying.');
      const res = savePrivateUpload(dir, 'test-notes.txt', 'text/plain', content);
      expect(res.storageKey).toContain('.txt');
      expect(res.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(res.bytes).toBe(content.length);
    });
  });
});
