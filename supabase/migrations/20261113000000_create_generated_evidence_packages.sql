-- Durable records for pipeline-generated QBO evidence packages.
-- Apply only after comparing the target database schema and migration history.
CREATE TABLE IF NOT EXISTS public.generated_evidence_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('complete', 'partial')),
  zip_path text NOT NULL UNIQUE,
  filename text NOT NULL,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generated_evidence_packages_date_range CHECK (start_date <= end_date)
);

CREATE INDEX IF NOT EXISTS idx_generated_evidence_packages_realm_created
  ON public.generated_evidence_packages (realm_id, created_at DESC);