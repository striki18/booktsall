-- Preserve uploaded evidence when removing an unlinked document from the inbox.
-- Archive metadata and its immutable event are written atomically by one function.

DO $$
BEGIN
  IF to_regclass('public.inbox_documents') IS NULL THEN
    RAISE EXCEPTION 'Required table public.inbox_documents does not exist';
  END IF;
  IF to_regclass('public.inbox_document_events') IS NOT NULL THEN
    RAISE EXCEPTION 'Table public.inbox_document_events already exists; inspect it before applying this migration';
  END IF;
  IF to_regprocedure('public.archive_inbox_document(text,uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.reject_inbox_document_mutation()') IS NOT NULL THEN
    RAISE EXCEPTION 'Inbox document archive function name is already in use';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inbox_documents'::regclass
      AND NOT tgisinternal
      AND tgname IN ('inbox_documents_no_delete', 'inbox_documents_no_truncate')
  ) THEN
    RAISE EXCEPTION 'Inbox document protection trigger name is already in use';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('archived_at', 'timestamp with time zone'),
      ('archived_by', 'uuid'),
      ('archive_reason', 'text')
    ) AS expected(column_name, data_type)
    JOIN information_schema.columns actual
      ON actual.table_schema = 'public'
     AND actual.table_name = 'inbox_documents'
     AND actual.column_name = expected.column_name
    WHERE actual.data_type <> expected.data_type
  ) THEN
    RAISE EXCEPTION 'An existing inbox archive column has an incompatible type';
  END IF;
END;
$$;

ALTER TABLE public.inbox_documents
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid,
  ADD COLUMN IF NOT EXISTS archive_reason text;

CREATE TABLE public.inbox_document_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id text NOT NULL,
  document_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type = 'archived'),
  actor_user_id uuid NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  file_size bigint NOT NULL CHECK (file_size >= 0),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_document_events_one_archive_per_document
    UNIQUE (realm_id, document_id, event_type)
);

CREATE INDEX inbox_document_events_realm_created_idx
  ON public.inbox_document_events (realm_id, created_at DESC);

CREATE FUNCTION public.reject_inbox_document_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Inbox document evidence and archive events cannot be deleted or rewritten';
END;
$$;

CREATE TRIGGER inbox_documents_no_delete
  BEFORE DELETE ON public.inbox_documents
  FOR EACH ROW EXECUTE FUNCTION public.reject_inbox_document_mutation();

CREATE TRIGGER inbox_documents_no_truncate
  BEFORE TRUNCATE ON public.inbox_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_inbox_document_mutation();

CREATE TRIGGER inbox_document_events_append_only
  BEFORE UPDATE OR DELETE ON public.inbox_document_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_inbox_document_mutation();

CREATE TRIGGER inbox_document_events_no_truncate
  BEFORE TRUNCATE ON public.inbox_document_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_inbox_document_mutation();

ALTER TABLE public.inbox_document_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY inbox_document_events_company_select
  ON public.inbox_document_events
  FOR SELECT TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

REVOKE ALL ON TABLE public.inbox_document_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.inbox_document_events TO authenticated;
GRANT SELECT, INSERT ON TABLE public.inbox_document_events TO service_role;

CREATE FUNCTION public.archive_inbox_document(
  p_realm_id text,
  p_document_id uuid,
  p_actor_user_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  document_row record;
BEGIN
  IF nullif(btrim(p_realm_id), '') IS NULL OR p_document_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Realm, document, and actor are required';
  END IF;
  IF p_reason IS NOT NULL AND length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'Archive reason is too long';
  END IF;

  SELECT id, realm_id, filename, content_type, file_size, archived_at
    INTO document_row
    FROM public.inbox_documents
   WHERE id = p_document_id AND realm_id = p_realm_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF document_row.archived_at IS NOT NULL THEN
    RETURN 'already_archived';
  END IF;

  UPDATE public.inbox_documents
     SET archived_at = now(), archived_by = p_actor_user_id,
         archive_reason = nullif(btrim(p_reason), '')
   WHERE id = p_document_id AND realm_id = p_realm_id;

  INSERT INTO public.inbox_document_events (
    realm_id, document_id, event_type, actor_user_id,
    filename, content_type, file_size, reason
  ) VALUES (
    document_row.realm_id, document_row.id, 'archived', p_actor_user_id,
    document_row.filename, document_row.content_type, document_row.file_size,
    nullif(btrim(p_reason), '')
  );

  RETURN 'archived';
END;
$$;

REVOKE ALL ON FUNCTION public.archive_inbox_document(text,uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_inbox_document(text,uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.reject_inbox_document_mutation() FROM PUBLIC, anon, authenticated, service_role;
