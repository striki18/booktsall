-- Company-authored evidence requirements. Deliberately contains no seeded rules.

CREATE TABLE public.evidence_requirement_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  transaction_type text NOT NULL CHECK (transaction_type ~ '^[A-Za-z][A-Za-z0-9]{0,63}$'),
  amount_min numeric,
  amount_max numeric,
  document_type text NOT NULL CHECK (document_type ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_requirement_rules_amount_range_check
    CHECK (amount_min IS NULL OR amount_max IS NULL OR amount_min <= amount_max),
  CONSTRAINT evidence_requirement_rules_realm_id_id_uq UNIQUE (realm_id, id)
);

CREATE INDEX evidence_requirement_rules_realm_active_type_idx
  ON public.evidence_requirement_rules (realm_id, is_active, transaction_type);

CREATE FUNCTION public.set_evidence_requirement_rule_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER evidence_requirement_rules_updated_at
  BEFORE UPDATE ON public.evidence_requirement_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_evidence_requirement_rule_updated_at();

ALTER TABLE public.evidence_requirement_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY evidence_requirement_rules_company_scope
  ON public.evidence_requirement_rules
  FOR ALL TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'))
  WITH CHECK (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

REVOKE ALL ON TABLE public.evidence_requirement_rules FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.evidence_requirement_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.evidence_requirement_rules TO service_role;

REVOKE ALL ON FUNCTION public.set_evidence_requirement_rule_updated_at() FROM PUBLIC, anon, authenticated, service_role;
