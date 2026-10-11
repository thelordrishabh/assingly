import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { allocationForPage, lateDiscountPercent, openDatabase, postLedgerTransaction, type Db } from './db.js';

const paths: string[] = [];
function freshDb(): Db {
  const directory = mkdtempSync(join(tmpdir(), 'assingly-test-'));
  paths.push(directory);
  return openDatabase(join(directory, 'test.db'));
}
afterEach(() => { while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true }); });

describe('Dime ledger invariants', () => {
  test('an idempotency key never locks the same Dime twice', () => {
    const db = freshDb();
    const before = db.prepare('SELECT available, locked FROM wallets WHERE user_id=?').get('stu-aanya') as { available: number; locked: number };
    const transaction = { idempotencyKey: 'test-lock-once', kind: 'ESCROW_LOCK', reason: 'test', actorId: 'stu-aanya', lines: [{ userId: 'stu-aanya', available: -120, locked: 120 }] };
    expect(postLedgerTransaction(db, transaction).repeated).toBe(false);
    expect(postLedgerTransaction(db, transaction).repeated).toBe(true);
    const after = db.prepare('SELECT available, locked FROM wallets WHERE user_id=?').get('stu-aanya') as { available: number; locked: number };
    expect(after).toEqual({ available: before.available - 120, locked: before.locked + 120 });
  });

  test('a ledger transaction cannot make an available balance negative', () => {
    const db = freshDb();
    expect(() => postLedgerTransaction(db, { idempotencyKey: 'test-negative', kind: 'ESCROW_LOCK', reason: 'test', lines: [{ userId: 'stu-meera', available: -999999, locked: 999999 }] })).toThrow('invalid Dime balance');
  });

  test('page allocations are integer-only and deterministically exhaust the reward', () => {
    expect([1, 2, 3, 4].map((page) => allocationForPage(10, 4, page))).toEqual([3, 3, 2, 2]);
    expect([1, 2, 3, 4].reduce((sum, page) => sum + allocationForPage(10, 4, page), 0)).toBe(10);
  });

  test('late adjustment starts per 24-hour period and is capped at fifty percent', () => {
    const deadline = '2026-01-01T00:00:00.000Z';
    expect(lateDiscountPercent(deadline, new Date('2026-01-01T00:00:00.001Z'))).toBe(10);
    expect(lateDiscountPercent(deadline, new Date('2026-01-04T12:00:00.000Z'))).toBe(40);
    expect(lateDiscountPercent(deadline, new Date('2026-01-12T00:00:00.000Z'))).toBe(50);
  });
});
