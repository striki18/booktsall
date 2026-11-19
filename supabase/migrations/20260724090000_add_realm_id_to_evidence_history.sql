-- Migration: add_realm_id_to_evidence_history
-- Adds company ownership without guessing a realm for existing rows.

-- 1. Add the column (nullable for now)
ALTER TABLE evidence_history
  ADD COLUMN IF NOT EXISTS realm_id text;

-- 2. Enforce ownership. A fresh install has no history rows because migration #7
-- no longer seeds synthetic data. Existing rows with unknown ownership cause
-- this migration to fail closed and must be assigned to a verified company first.
ALTER TABLE evidence_history
  ALTER COLUMN realm_id SET NOT NULL;

-- 3. Create an index for fast lookup by realm_id
CREATE INDEX IF NOT EXISTS idx_evidence_history_realm_id ON evidence_history (realm_id);
