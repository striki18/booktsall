-- Extend generated_evidence_packages into the canonical package-run model.
-- Existing QBO package rows remain valid; legacy evidence_packages rows are retained
-- and linked to new canonical runs without rewriting or deleting their history.
ALTER TABLE public.generated_evidence_packages
  ALTER COLUMN start_date DROP NOT NULL,
  ALTER COLUMN end_date DROP NOT NULL,
  ALTER COLUMN zip_path DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS generated_evidence_packages_status_check,
  DROP CONSTRAINT IF EXISTS generated_evidence_packages_date_range;

ALTER TABLE public.generated_evidence_packages
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'qbo_period',
  ADD COLUMN IF NOT EXISTS engagement_id uuid REFERENCES public.audit_engagements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS error_summary text,
  ADD COLUMN IF NOT EXISTS package_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS previous_package_id uuid REFERENCES public.generated_evidence_packages(id) ON DELETE SET NULL;

ALTER TABLE public.generated_evidence_packages
  ADD CONSTRAINT generated_evidence_packages_status_check
    CHECK (status IN ('generating', 'complete', 'partial', 'failed')),
  ADD CONSTRAINT generated_evidence_packages_source_type_check
    CHECK (source_type IN ('qbo_period', 'engagement')),
  ADD CONSTRAINT generated_evidence_packages_date_range
    CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date),
  ADD CONSTRAINT generated_evidence_packages_version_positive
    CHECK (package_version > 0);

-- Assign stable, non-colliding versions to existing QBO runs before adding uniqueness.
WITH ranked_qbo_runs AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY realm_id, start_date, end_date ORDER BY created_at, id) AS version_number,
    lag(id) OVER (PARTITION BY realm_id, start_date, end_date ORDER BY created_at, id) AS prior_id
  FROM public.generated_evidence_packages
  WHERE source_type = 'qbo_period'
)
UPDATE public.generated_evidence_packages AS package
SET package_version = ranked_qbo_runs.version_number,
    previous_package_id = ranked_qbo_runs.prior_id
FROM ranked_qbo_runs
WHERE package.id = ranked_qbo_runs.id;
CREATE INDEX IF NOT EXISTS idx_generated_evidence_packages_engagement_created
  ON public.generated_evidence_packages (engagement_id, created_at DESC)
  WHERE engagement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generated_evidence_packages_previous
  ON public.generated_evidence_packages (previous_package_id)
  WHERE previous_package_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_evidence_packages_qbo_version
  ON public.generated_evidence_packages (realm_id, start_date, end_date, package_version)
  WHERE source_type = 'qbo_period';
CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_evidence_packages_engagement_version
  ON public.generated_evidence_packages (realm_id, engagement_id, package_version)
  WHERE source_type = 'engagement' AND engagement_id IS NOT NULL;

ALTER TABLE public.evidence_packages
  ADD COLUMN IF NOT EXISTS generated_package_id uuid REFERENCES public.generated_evidence_packages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_packages_generated_package
  ON public.evidence_packages (generated_package_id)
  WHERE generated_package_id IS NOT NULL;
