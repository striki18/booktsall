-- Migration: Remove only the evidence_requests index duplicated by its unique constraint
-- Timestamp: 20260726000000

-- The UNIQUE (plan_id) constraint from migration #9 already provides an index
-- for plan_id lookups. Keep the engagement_id and status indexes: the application
-- filters evidence_requests by both columns, and neither has another index.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.evidence_requests'::regclass
      AND constraint_row.conname = 'uq_evidence_requests_plan'
      AND constraint_row.contype = 'u'
      AND pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (plan_id)'
  ) THEN
    DROP INDEX IF EXISTS public.idx_evidence_requests_plan_id;
  END IF;
END $$;
