-- Migration: create_evidence_history
-- Creates the evidence_history table to store historical evidence ownership information.

CREATE TABLE IF NOT EXISTS evidence_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id uuid NOT NULL REFERENCES audit_evidence_catalog(id),
  company_name text NOT NULL,
  fiscal_year integer NOT NULL,
  provider_name text NOT NULL,
  job_title text,
  department text,
  provider_email text,
  days_to_receive integer,
  notes text,
  created_at timestamptz DEFAULT now()
);

-- Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_evidence_history_catalog_id ON evidence_history (catalog_id);
CREATE INDEX IF NOT EXISTS idx_evidence_history_company_name ON evidence_history (company_name);
CREATE INDEX IF NOT EXISTS idx_evidence_history_fiscal_year ON evidence_history (fiscal_year);
CREATE INDEX IF NOT EXISTS idx_evidence_history_provider_name ON evidence_history (provider_name);
