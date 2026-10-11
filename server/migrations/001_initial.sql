PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('STUDENT','GUARDIAN','MODERATOR')),
  age INTEGER NOT NULL CHECK (age >= 0 AND age < 130),
  campus TEXT,
  verified_at TEXT,
  restricted_at TEXT,
  restriction_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guardian_relationships (
  id TEXT PRIMARY KEY,
  guardian_id TEXT NOT NULL REFERENCES users(id),
  student_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  consented_at TEXT,
  UNIQUE(guardian_id, student_id)
);

CREATE TABLE IF NOT EXISTS guardian_controls (
  student_id TEXT PRIMARY KEY REFERENCES users(id),
  guardian_id TEXT NOT NULL REFERENCES users(id),
  max_per_contract INTEGER NOT NULL CHECK(max_per_contract >= 0),
  max_per_rolling_period INTEGER NOT NULL CHECK(max_per_rolling_period >= 0),
  rolling_period_days INTEGER NOT NULL DEFAULT 30 CHECK(rolling_period_days BETWEEN 1 AND 365),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS safe_points (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  campus TEXT NOT NULL,
  area TEXT NOT NULL,
  hours TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  available INTEGER NOT NULL DEFAULT 0 CHECK(available >= 0),
  locked INTEGER NOT NULL DEFAULT 0 CHECK(locked >= 0),
  lifetime_earned INTEGER NOT NULL DEFAULT 0 CHECK(lifetime_earned >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('GRANT','ESCROW_LOCK','ESCROW_RELEASE','SETTLEMENT','REFUND','ADJUSTMENT')),
  reason TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  contract_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger_lines (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  available_delta INTEGER NOT NULL DEFAULT 0,
  locked_delta INTEGER NOT NULL DEFAULT 0,
  earned_delta INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ledger_lines_user_created ON ledger_lines(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS source_assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0),
  sha256 TEXT NOT NULL,
  ocr_status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(ocr_status IN ('QUEUED','READY','LOW_CONFIDENCE','FAILED')),
  ocr_confidence REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS writing_contracts (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id),
  writer_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','ACCEPTED','IN_PROGRESS','SUBMITTED','IN_REVIEW','DISPUTED','SETTLED','CANCELLED')),
  paper_mode TEXT NOT NULL CHECK(paper_mode IN ('WRITER_SUPPLIED','REQUESTER_NOTEBOOK')),
  page_count INTEGER NOT NULL CHECK(page_count BETWEEN 1 AND 100),
  reward INTEGER NOT NULL CHECK(reward > 0),
  delivery_reward INTEGER NOT NULL DEFAULT 0 CHECK(delivery_reward >= 0),
  deadline_at TEXT NOT NULL,
  safe_point_id TEXT NOT NULL REFERENCES safe_points(id),
  source_asset_id TEXT NOT NULL REFERENCES source_assets(id),
  acceptance_criteria TEXT NOT NULL,
  copying_attested_at TEXT NOT NULL,
  accepted_version INTEGER,
  submitted_at TEXT,
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS writing_contracts_status_deadline ON writing_contracts(status, deadline_at);
CREATE INDEX IF NOT EXISTS writing_contracts_requester ON writing_contracts(requester_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contract_versions (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES writing_contracts(id),
  version INTEGER NOT NULL,
  terms_json TEXT NOT NULL,
  source_asset_id TEXT NOT NULL REFERENCES source_assets(id),
  proposed_by TEXT NOT NULL REFERENCES users(id),
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(contract_id, version)
);

CREATE TABLE IF NOT EXISTS contract_offers (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES writing_contracts(id),
  proposer_id TEXT NOT NULL REFERENCES users(id),
  reward INTEGER,
  deadline_at TEXT,
  page_count INTEGER,
  status TEXT NOT NULL CHECK(status IN ('PENDING','ACCEPTED','DECLINED','EXPIRED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS page_evidence (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES writing_contracts(id),
  page_number INTEGER NOT NULL CHECK(page_number > 0),
  asset_id TEXT NOT NULL REFERENCES source_assets(id),
  receipt_hash TEXT NOT NULL,
  ocr_status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(ocr_status IN ('QUEUED','READY','LOW_CONFIDENCE','FAILED')),
  ocr_confidence REAL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(contract_id, page_number)
);

CREATE TABLE IF NOT EXISTS page_reviews (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL UNIQUE REFERENCES page_evidence(id),
  contract_id TEXT NOT NULL REFERENCES writing_contracts(id),
  page_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACCEPTED','DISPUTED','AUTO_ACCEPTED','ADJUDICATED')),
  reason TEXT,
  note TEXT,
  reviewed_by TEXT NOT NULL REFERENCES users(id),
  payout_percent INTEGER CHECK(payout_percent BETWEEN 0 AND 100),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES writing_contracts(id),
  evidence_id TEXT NOT NULL REFERENCES page_evidence(id),
  page_number INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('MISSING_PAGE','ILLEGIBLE','SOURCE_MISMATCH','SPEC_NOT_MET')),
  note TEXT,
  status TEXT NOT NULL CHECK(status IN ('OPEN','RESOLVED')),
  outcome TEXT CHECK(outcome IN ('REQUESTER','WRITER','INCONCLUSIVE')),
  completion_percent INTEGER CHECK(completion_percent BETWEEN 0 AND 100),
  moderator_id TEXT REFERENCES users(id),
  moderator_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS delivery_legs (
  id TEXT PRIMARY KEY,
  writing_contract_id TEXT REFERENCES writing_contracts(id),
  requester_id TEXT NOT NULL REFERENCES users(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  courier_id TEXT REFERENCES users(id),
  direction TEXT NOT NULL CHECK(direction IN ('INBOUND_NOTEBOOK','RETURN_WORK','INDEPENDENT')),
  status TEXT NOT NULL CHECK(status IN ('OPEN','CLAIMED','PICKUP_CONFIRMED','DROPOFF_CONFIRMED','COMPLETED','REPORTED','CANCELLED')),
  reward INTEGER NOT NULL CHECK(reward > 0),
  campus TEXT NOT NULL,
  safe_point_id TEXT NOT NULL REFERENCES safe_points(id),
  item_description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS delivery_legs_status ON delivery_legs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS handoff_codes (
  id TEXT PRIMARY KEY,
  delivery_leg_id TEXT NOT NULL REFERENCES delivery_legs(id),
  step TEXT NOT NULL CHECK(step IN ('PICKUP','DROPOFF')),
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  initiated_by TEXT NOT NULL REFERENCES users(id),
  confirmed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(delivery_leg_id, step, code_hash)
);

CREATE TABLE IF NOT EXISTS reliability_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('SUBSTANTIATED_FAILURE','DELIBERATE_FALSE_DISPUTE','POSITIVE_COMPLETION','MODERATOR_ADJUSTMENT')),
  reason TEXT NOT NULL,
  contract_id TEXT REFERENCES writing_contracts(id),
  actor_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  delivery_leg_id TEXT REFERENCES delivery_legs(id),
  contract_id TEXT REFERENCES writing_contracts(id),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  reason TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
