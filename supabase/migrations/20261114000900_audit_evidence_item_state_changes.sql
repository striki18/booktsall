-- Record evidence-item lifecycle changes without copying extracted document data.
-- Existing items are not backfilled with synthetic events.

DO $$
BEGIN
  IF to_regclass('public.qbo_evidence_items') IS NULL THEN
    RAISE EXCEPTION 'Required table public.qbo_evidence_items does not exist';
  END IF;
  IF to_regclass('public.qbo_evidence_item_events') IS NOT NULL THEN
    RAISE EXCEPTION 'Table public.qbo_evidence_item_events already exists; inspect it before applying this migration';
  END IF;
  IF to_regprocedure('public.audit_qbo_evidence_item_change()') IS NOT NULL
     OR to_regprocedure('public.reject_qbo_evidence_item_delete()') IS NOT NULL THEN
    RAISE EXCEPTION 'Evidence-item audit function name is already in use';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.qbo_evidence_items'::regclass
      AND contype = 'u'
      AND conname = 'qbo_evidence_items_realm_id_id_uq'
  ) THEN
    RAISE EXCEPTION 'Required same-realm evidence-item key is missing';
  END IF;
END;
$$;

CREATE TABLE public.qbo_evidence_item_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id text NOT NULL,
  evidence_item_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created', 'updated')),
  actor_user_id uuid,
  changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  before_state jsonb,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qbo_evidence_item_events_same_realm_fk
    FOREIGN KEY (realm_id, evidence_item_id)
    REFERENCES public.qbo_evidence_items (realm_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX qbo_evidence_item_events_item_created_idx
  ON public.qbo_evidence_item_events (realm_id, evidence_item_id, created_at, id);

CREATE FUNCTION public.audit_qbo_evidence_item_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  old_state jsonb;
  new_state jsonb;
  changed_fields text[] := ARRAY[]::text[];
BEGIN
  new_state := jsonb_build_object(
    'register_entry_id', NEW.register_entry_id,
    'proposed_register_entry_id', NEW.proposed_register_entry_id,
    'candidate_qbo_txn_ids', NEW.candidate_qbo_txn_ids,
    'source_type', NEW.source_type,
    'inbox_document_id', NEW.inbox_document_id,
    'qbo_attachable_id', NEW.qbo_attachable_id,
    'content_sha256', NEW.content_sha256,
    'match_status', NEW.match_status,
    'review_status', NEW.review_status,
    'evidence_role', NEW.evidence_role,
    'qbo_attachment_status', NEW.qbo_attachment_status,
    'duplicate_of_item_id', NEW.duplicate_of_item_id
  );

  IF TG_OP = 'UPDATE' THEN
    old_state := jsonb_build_object(
      'register_entry_id', OLD.register_entry_id,
      'proposed_register_entry_id', OLD.proposed_register_entry_id,
      'candidate_qbo_txn_ids', OLD.candidate_qbo_txn_ids,
      'source_type', OLD.source_type,
      'inbox_document_id', OLD.inbox_document_id,
      'qbo_attachable_id', OLD.qbo_attachable_id,
      'content_sha256', OLD.content_sha256,
      'match_status', OLD.match_status,
      'review_status', OLD.review_status,
      'evidence_role', OLD.evidence_role,
      'qbo_attachment_status', OLD.qbo_attachment_status,
      'duplicate_of_item_id', OLD.duplicate_of_item_id
    );

    SELECT COALESCE(array_agg(changes.field_name ORDER BY changes.field_name), ARRAY[]::text[])
      INTO changed_fields
      FROM (VALUES
        ('register_entry_id', old_state->'register_entry_id', new_state->'register_entry_id'),
        ('proposed_register_entry_id', old_state->'proposed_register_entry_id', new_state->'proposed_register_entry_id'),
        ('candidate_qbo_txn_ids', old_state->'candidate_qbo_txn_ids', new_state->'candidate_qbo_txn_ids'),
        ('source_type', old_state->'source_type', new_state->'source_type'),
        ('inbox_document_id', old_state->'inbox_document_id', new_state->'inbox_document_id'),
        ('qbo_attachable_id', old_state->'qbo_attachable_id', new_state->'qbo_attachable_id'),
        ('content_sha256', old_state->'content_sha256', new_state->'content_sha256'),
        ('match_confidence', to_jsonb(OLD.match_confidence), to_jsonb(NEW.match_confidence)),
        ('match_evidence', OLD.match_evidence, NEW.match_evidence),
        ('match_status', old_state->'match_status', new_state->'match_status'),
        ('review_status', old_state->'review_status', new_state->'review_status'),
        ('evidence_role', old_state->'evidence_role', new_state->'evidence_role'),
        ('qbo_attachment_status', old_state->'qbo_attachment_status', new_state->'qbo_attachment_status'),
        ('duplicate_of_item_id', old_state->'duplicate_of_item_id', new_state->'duplicate_of_item_id')
      ) AS changes(field_name, old_value, new_value)
      WHERE changes.old_value IS DISTINCT FROM changes.new_value;

    IF cardinality(changed_fields) = 0 THEN
      RETURN NEW;
    END IF;
  ELSE
    changed_fields := ARRAY['created'];
  END IF;

  INSERT INTO public.qbo_evidence_item_events (
    realm_id, evidence_item_id, event_type, actor_user_id,
    changed_fields, before_state, after_state
  ) VALUES (
    NEW.realm_id, NEW.id, CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END, auth.uid(),
    changed_fields, old_state, new_state
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reject_qbo_evidence_item_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'qbo_evidence_items cannot be deleted; preserve and mark evidence instead';
END;
$$;

CREATE FUNCTION public.reject_qbo_evidence_item_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'qbo_evidence_item_events is append-only';
END;
$$;

CREATE TRIGGER qbo_evidence_items_audit_changes
  AFTER INSERT OR UPDATE ON public.qbo_evidence_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_qbo_evidence_item_change();

CREATE TRIGGER qbo_evidence_items_no_delete
  BEFORE DELETE ON public.qbo_evidence_items
  FOR EACH ROW EXECUTE FUNCTION public.reject_qbo_evidence_item_delete();

CREATE TRIGGER qbo_evidence_items_no_truncate
  BEFORE TRUNCATE ON public.qbo_evidence_items
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_qbo_evidence_item_delete();

CREATE TRIGGER qbo_evidence_item_events_append_only
  BEFORE UPDATE OR DELETE ON public.qbo_evidence_item_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_qbo_evidence_item_event_mutation();

CREATE TRIGGER qbo_evidence_item_events_no_truncate
  BEFORE TRUNCATE ON public.qbo_evidence_item_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_qbo_evidence_item_event_mutation();

ALTER TABLE public.qbo_evidence_item_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY qbo_evidence_item_events_company_select
  ON public.qbo_evidence_item_events
  FOR SELECT TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

REVOKE ALL ON TABLE public.qbo_evidence_item_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.qbo_evidence_item_events TO authenticated;
GRANT SELECT ON TABLE public.qbo_evidence_item_events TO service_role;

REVOKE ALL ON FUNCTION public.audit_qbo_evidence_item_change() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reject_qbo_evidence_item_delete() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reject_qbo_evidence_item_event_mutation() FROM PUBLIC, anon, authenticated, service_role;
