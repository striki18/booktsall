-- Immutable, company-scoped audit events for the one-shot QBO attachment flow.
-- A single attempt per evidence item is intentional: ambiguous outcomes must be
-- reconciled before any retry, so this model fails closed against duplicate POSTs.

CREATE TABLE public.qbo_attachment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id text NOT NULL,
  evidence_item_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'preflight_blocked',
    'attempt_started',
    'upload_succeeded',
    'upload_failed',
    'outcome_unknown',
    'verification_succeeded',
    'verification_failed'
  )),
  qbo_txn_type text,
  qbo_txn_id text NOT NULL,
  qbo_attachable_id text,
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qbo_attachment_events_item_same_realm_fk
    FOREIGN KEY (realm_id, evidence_item_id)
    REFERENCES public.qbo_evidence_items (realm_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT qbo_attachment_events_attempt_event_uq
    UNIQUE (realm_id, evidence_item_id, attempt_id, event_type)
);

CREATE UNIQUE INDEX qbo_attachment_events_one_attempt_per_item_uq
  ON public.qbo_attachment_events (realm_id, evidence_item_id)
  WHERE event_type = 'attempt_started';

CREATE INDEX qbo_attachment_events_item_created_idx
  ON public.qbo_attachment_events (realm_id, evidence_item_id, created_at, id);

CREATE FUNCTION public.reject_qbo_attachment_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'qbo_attachment_events is append-only';
END;
$$;

CREATE TRIGGER qbo_attachment_events_append_only
  BEFORE UPDATE OR DELETE ON public.qbo_attachment_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_qbo_attachment_event_mutation();

ALTER TABLE public.qbo_attachment_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY qbo_attachment_events_company_select
  ON public.qbo_attachment_events
  FOR SELECT TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

REVOKE ALL ON TABLE public.qbo_attachment_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.qbo_attachment_events TO authenticated;
GRANT SELECT, INSERT ON TABLE public.qbo_attachment_events TO service_role;
REVOKE ALL ON FUNCTION public.reject_qbo_attachment_event_mutation() FROM PUBLIC, anon, authenticated, service_role;
