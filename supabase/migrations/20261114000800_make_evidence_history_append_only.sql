-- Keep evidence history readable and appendable within a company, but immutable.
-- Existing history rows are not changed by this migration.

DO $$
BEGIN
  IF to_regclass('public.evidence_history') IS NULL THEN
    RAISE EXCEPTION 'Required table public.evidence_history does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'evidence_history'
      AND column_name = 'realm_id'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Required non-null public.evidence_history.realm_id is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.evidence_history
    WHERE realm_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Unowned evidence_history rows exist; refusing to change access controls';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'evidence_history'
      AND policyname <> 'evidence_history_company_scope'
  ) THEN
    RAISE EXCEPTION 'Unexpected evidence_history RLS policy exists; review before continuing';
  END IF;

  IF to_regprocedure('public.reject_evidence_history_mutation()') IS NOT NULL THEN
    RAISE EXCEPTION 'Function public.reject_evidence_history_mutation() already exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.evidence_history'::regclass
      AND tgname IN ('evidence_history_immutable', 'evidence_history_no_truncate')
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'An evidence_history immutability trigger name is already in use';
  END IF;
END;
$$;

CREATE FUNCTION public.reject_evidence_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'public.evidence_history is append-only';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_evidence_history_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER evidence_history_immutable
  BEFORE UPDATE OR DELETE ON public.evidence_history
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_evidence_history_mutation();

CREATE TRIGGER evidence_history_no_truncate
  BEFORE TRUNCATE ON public.evidence_history
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.reject_evidence_history_mutation();

ALTER TABLE public.evidence_history ENABLE ROW LEVEL SECURITY;

DROP POLICY evidence_history_company_scope ON public.evidence_history;

CREATE POLICY evidence_history_company_select
  ON public.evidence_history
  FOR SELECT TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

CREATE POLICY evidence_history_company_insert
  ON public.evidence_history
  FOR INSERT TO authenticated
  WITH CHECK (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.evidence_history
  FROM PUBLIC, anon;

REVOKE UPDATE, DELETE, TRUNCATE
  ON TABLE public.evidence_history
  FROM authenticated, service_role;

GRANT SELECT, INSERT
  ON TABLE public.evidence_history
  TO authenticated, service_role;
