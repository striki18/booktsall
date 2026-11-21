-- Retain legacy evidence bytes and metadata; archive only through an audited RPC.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.evidence_documents') IS NULL
     OR to_regclass('public.evidence_requests') IS NULL
     OR to_regclass('public.audit_engagements') IS NULL
     OR to_regclass('public.qbo_company_memberships') IS NULL THEN
    RAISE EXCEPTION 'Required evidence ownership tables are missing';
  END IF;
  IF to_regclass('public.evidence_document_events') IS NOT NULL
     OR to_regprocedure('public.archive_evidence_document(text,uuid,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy evidence archive objects already exist; inspect before applying';
  END IF;
END;
$$;

ALTER TABLE public.evidence_documents
  ADD COLUMN uploaded_by uuid,
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by uuid,
  ADD COLUMN archive_reason text;

CREATE TABLE public.evidence_document_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id text NOT NULL,
  document_id uuid NOT NULL REFERENCES public.evidence_documents(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('created', 'archived')),
  actor_user_id uuid,
  reason text CHECK (reason IS NULL OR length(reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_document_events_identity_uq UNIQUE(document_id, event_type),
  CONSTRAINT evidence_document_archive_actor_check CHECK (event_type <> 'archived' OR actor_user_id IS NOT NULL)
);
CREATE INDEX evidence_document_events_company_created_idx
  ON public.evidence_document_events(realm_id, created_at, id);
CREATE INDEX evidence_documents_active_request_idx
  ON public.evidence_documents(evidence_request_id, uploaded_at DESC) WHERE archived_at IS NULL;

CREATE FUNCTION public.protect_evidence_document_retention()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Evidence documents must be retained; use approved archiving';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NOT NULL OR NEW.archived_by IS NOT NULL OR NEW.archive_reason IS NOT NULL THEN
      RAISE EXCEPTION 'New evidence cannot already be archived';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'archived_at' - 'archived_by' - 'archive_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'archived_at' - 'archived_by' - 'archive_reason') THEN
    RAISE EXCEPTION 'Stored evidence identity and metadata cannot be overwritten';
  END IF;
  IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN RETURN NEW; END IF;
  IF OLD.archived_at IS NOT NULL OR NEW.archived_at IS NULL OR NEW.archived_by IS NULL THEN
    RAISE EXCEPTION 'Evidence archive history cannot be rewritten';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.evidence_document_events event
    WHERE event.document_id = NEW.id AND event.event_type = 'archived'
      AND event.actor_user_id = NEW.archived_by AND event.created_at = NEW.archived_at
      AND event.reason IS NOT DISTINCT FROM NEW.archive_reason
  ) THEN
    RAISE EXCEPTION 'An immutable approval event is required before archiving';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.audit_evidence_document_creation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE company_realm text;
BEGIN
  SELECT engagement.realm_id INTO company_realm
  FROM public.evidence_requests request
  JOIN public.audit_engagements engagement ON engagement.id = request.engagement_id
  WHERE request.id = NEW.evidence_request_id
  FOR SHARE OF request, engagement;
  IF nullif(btrim(company_realm), '') IS NULL THEN
    RAISE EXCEPTION 'Evidence requires a known company association';
  END IF;
  IF NEW.uploaded_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.qbo_company_memberships WHERE realm_id = company_realm AND user_id = NEW.uploaded_by
  ) THEN RAISE EXCEPTION 'Uploader is not an authorized company member'; END IF;
  INSERT INTO public.evidence_document_events(realm_id,document_id,event_type,actor_user_id)
    VALUES(company_realm,NEW.id,'created',NEW.uploaded_by);
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reject_evidence_document_event_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Evidence document events are append-only';
END;
$$;
CREATE TRIGGER evidence_documents_retention_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.evidence_documents
  FOR EACH ROW EXECUTE FUNCTION public.protect_evidence_document_retention();
CREATE TRIGGER evidence_documents_no_truncate
  BEFORE TRUNCATE ON public.evidence_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_evidence_document_retention();
CREATE TRIGGER evidence_documents_audit_creation
  AFTER INSERT ON public.evidence_documents
  FOR EACH ROW EXECUTE FUNCTION public.audit_evidence_document_creation();
CREATE TRIGGER evidence_document_events_append_only
  BEFORE UPDATE OR DELETE ON public.evidence_document_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_evidence_document_event_mutation();
CREATE TRIGGER evidence_document_events_no_truncate
  BEFORE TRUNCATE ON public.evidence_document_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_evidence_document_event_mutation();

CREATE FUNCTION public.archive_evidence_document(
  p_realm_id text, p_document_id uuid, p_actor_user_id uuid, p_reason text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE document_row record; archive_time timestamptz := now(); v_archive_reason text := nullif(btrim(p_reason),'');
BEGIN
  IF nullif(btrim(p_realm_id),'') IS NULL OR p_document_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Company, document and actor are required';
  END IF;
  IF p_reason IS NOT NULL AND length(p_reason) > 1000 THEN RAISE EXCEPTION 'Archive reason is too long'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.qbo_company_memberships WHERE realm_id = p_realm_id AND user_id = p_actor_user_id
  ) THEN RAISE EXCEPTION 'Actor is not an authorized company member'; END IF;
  SELECT document.id, document.archived_at INTO document_row
    FROM public.evidence_documents document
    JOIN public.evidence_requests request ON request.id = document.evidence_request_id
    JOIN public.audit_engagements engagement ON engagement.id = request.engagement_id
    WHERE document.id = p_document_id AND engagement.realm_id = p_realm_id
    FOR UPDATE OF document, request, engagement;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF document_row.archived_at IS NOT NULL THEN RETURN 'already_archived'; END IF;
  INSERT INTO public.evidence_document_events(realm_id,document_id,event_type,actor_user_id,reason,created_at)
    VALUES(p_realm_id,p_document_id,'archived',p_actor_user_id,v_archive_reason,archive_time);
  UPDATE public.evidence_documents
    SET archived_at = archive_time, archived_by = p_actor_user_id, archive_reason = v_archive_reason
    WHERE id = p_document_id;
  RETURN 'archived';
END;
$$;

ALTER TABLE public.evidence_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_document_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS evidence_documents_company_scope ON public.evidence_documents;
CREATE POLICY evidence_documents_company_scope ON public.evidence_documents FOR SELECT TO authenticated
  USING(EXISTS (
    SELECT 1 FROM public.evidence_requests request
    JOIN public.audit_engagements engagement ON engagement.id = request.engagement_id
    WHERE request.id = evidence_documents.evidence_request_id
      AND engagement.realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
  ));
CREATE POLICY evidence_document_events_company_select ON public.evidence_document_events FOR SELECT TO authenticated
  USING(realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));
REVOKE ALL ON public.evidence_documents, public.evidence_document_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.evidence_documents, public.evidence_document_events TO authenticated;
GRANT SELECT,INSERT,UPDATE ON public.evidence_documents TO service_role;
GRANT SELECT ON public.evidence_document_events TO service_role;
REVOKE ALL ON FUNCTION public.archive_evidence_document(text,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.archive_evidence_document(text,uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.protect_evidence_document_retention() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.audit_evidence_document_creation() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.reject_evidence_document_event_mutation() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
