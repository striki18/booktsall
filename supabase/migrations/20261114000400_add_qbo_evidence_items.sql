-- Additive evidence-item model. Existing transaction-register rows and review history remain intact.
-- Backfill records only the references that are unambiguous and never upgrades them
-- to verified, primary, or approved evidence.

-- Composite keys let foreign keys enforce that linked records share the same realm.
CREATE UNIQUE INDEX IF NOT EXISTS qbo_evidence_register_realm_id_id_uq
  ON public.qbo_evidence_register (realm_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_documents_realm_id_id_uq
  ON public.inbox_documents (realm_id, id);

CREATE TABLE public.qbo_evidence_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id text NOT NULL,
  register_entry_id uuid,
  proposed_register_entry_id uuid,
  candidate_qbo_txn_ids text[] NOT NULL DEFAULT ARRAY[]::text[],

  source_type text NOT NULL
    CHECK (source_type IN ('client_upload', 'qbo_attachable')),
  inbox_document_id uuid,
  qbo_attachable_id text,
  content_sha256 text
    CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  match_confidence numeric,
  match_evidence jsonb,

  match_status text NOT NULL
    CHECK (match_status IN ('unreviewed', 'verified', 'potential', 'wrong_match', 'duplicate')),
  review_status text NOT NULL
    CHECK (review_status IN ('not_required', 'required', 'approved', 'discarded')),
  evidence_role text NOT NULL
    CHECK (evidence_role IN ('primary', 'additional', 'unassigned')),
  qbo_attachment_status text NOT NULL
    CHECK (qbo_attachment_status IN ('not_requested', 'pending', 'uploaded', 'verified', 'failed', 'unknown')),

  duplicate_of_item_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT qbo_evidence_items_realm_id_id_uq UNIQUE (realm_id, id),
  CONSTRAINT qbo_evidence_items_parent_same_realm_fk
    FOREIGN KEY (realm_id, register_entry_id)
    REFERENCES public.qbo_evidence_register (realm_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT qbo_evidence_items_proposal_same_realm_fk
    FOREIGN KEY (realm_id, proposed_register_entry_id)
    REFERENCES public.qbo_evidence_register (realm_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT qbo_evidence_items_document_same_realm_fk
    FOREIGN KEY (realm_id, inbox_document_id)
    REFERENCES public.inbox_documents (realm_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT qbo_evidence_items_duplicate_same_realm_fk
    FOREIGN KEY (realm_id, duplicate_of_item_id)
    REFERENCES public.qbo_evidence_items (realm_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT qbo_evidence_items_source_identity_check
    CHECK (
      (source_type = 'client_upload' AND inbox_document_id IS NOT NULL)
      OR (source_type = 'qbo_attachable' AND qbo_attachable_id IS NOT NULL)
    ),
  CONSTRAINT qbo_evidence_items_status_role_check
    CHECK (
      (match_status = 'unreviewed'
        AND review_status = 'required'
        AND evidence_role = 'unassigned')
      OR (match_status = 'verified'
        AND evidence_role = 'primary'
        AND review_status IN ('not_required', 'approved')
        AND register_entry_id IS NOT NULL
        AND proposed_register_entry_id IS NULL)
      OR (match_status = 'verified'
        AND evidence_role = 'additional'
        AND review_status IN ('required', 'approved')
        AND register_entry_id IS NOT NULL
        AND proposed_register_entry_id IS NULL)
      OR (match_status = 'potential'
        AND review_status = 'required'
        AND evidence_role = 'unassigned'
        AND register_entry_id IS NULL)
      OR (match_status = 'wrong_match'
        AND review_status = 'required'
        AND evidence_role = 'unassigned')
      OR (match_status = 'duplicate'
        AND review_status IN ('required', 'discarded')
        AND evidence_role = 'unassigned')
    ),
  CONSTRAINT qbo_evidence_items_no_self_duplicate_check
    CHECK (duplicate_of_item_id IS NULL OR duplicate_of_item_id <> id)
);

CREATE UNIQUE INDEX qbo_evidence_items_document_identity_uq
  ON public.qbo_evidence_items (realm_id, inbox_document_id)
  WHERE inbox_document_id IS NOT NULL;

CREATE UNIQUE INDEX qbo_evidence_items_attachable_identity_uq
  ON public.qbo_evidence_items (realm_id, qbo_attachable_id)
  WHERE qbo_attachable_id IS NOT NULL;

CREATE UNIQUE INDEX qbo_evidence_items_one_primary_per_transaction_uq
  ON public.qbo_evidence_items (realm_id, register_entry_id)
  WHERE evidence_role = 'primary' AND register_entry_id IS NOT NULL;

CREATE INDEX qbo_evidence_items_realm_status_idx
  ON public.qbo_evidence_items (realm_id, match_status, review_status);

CREATE INDEX qbo_evidence_items_realm_register_entry_idx
  ON public.qbo_evidence_items (realm_id, register_entry_id);

CREATE INDEX qbo_evidence_items_realm_proposed_entry_idx
  ON public.qbo_evidence_items (realm_id, proposed_register_entry_id)
  WHERE proposed_register_entry_id IS NOT NULL;

CREATE INDEX qbo_evidence_items_duplicate_idx
  ON public.qbo_evidence_items (realm_id, duplicate_of_item_id)
  WHERE duplicate_of_item_id IS NOT NULL;

CREATE FUNCTION public.reject_qbo_evidence_item_id_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'qbo_evidence_items.id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER qbo_evidence_items_id_immutable
  BEFORE UPDATE OF id ON public.qbo_evidence_items
  FOR EACH ROW EXECUTE FUNCTION public.reject_qbo_evidence_item_id_change();

CREATE FUNCTION public.set_qbo_evidence_item_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER qbo_evidence_items_updated_at
  BEFORE UPDATE ON public.qbo_evidence_items
  FOR EACH ROW EXECUTE FUNCTION public.set_qbo_evidence_item_updated_at();

ALTER TABLE public.qbo_evidence_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY qbo_evidence_items_company_select
  ON public.qbo_evidence_items
  FOR SELECT TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

REVOKE ALL ON TABLE public.qbo_evidence_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.qbo_evidence_items TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.qbo_evidence_items TO service_role;

REVOKE ALL ON FUNCTION public.reject_qbo_evidence_item_id_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_qbo_evidence_item_updated_at() FROM PUBLIC, anon, authenticated;

-- Backfill each source reference independently. If a reference appears on more
-- than one legacy row, skip it as ambiguous. Existing register/document rows are
-- never updated. Existing associations are represented as potential or unreviewed,
-- requiring review and never being promoted to primary or approved by this migration.
WITH document_references AS (
  SELECT
    r.realm_id,
    r.id AS register_entry_id,
    r.matched_document_id AS inbox_document_id,
    r.match_confidence,
    r.match_field_details,
    COALESCE(r.review_candidate_txn_ids, ARRAY[]::text[]) AS candidate_qbo_txn_ids,
    count(*) OVER (PARTITION BY r.realm_id, r.matched_document_id) AS reference_count
  FROM public.qbo_evidence_register AS r
  WHERE r.matched_document_id IS NOT NULL
), document_rows AS (
  SELECT
    refs.*,
    CASE
      WHEN cardinality(refs.candidate_qbo_txn_ids) = 1 THEN candidate.id
      WHEN cardinality(refs.candidate_qbo_txn_ids) = 0 AND parent.qbo_txn_id IS NOT NULL THEN parent.id
      ELSE NULL
    END AS proposed_register_entry_id
  FROM document_references AS refs
  JOIN public.inbox_documents AS doc
    ON doc.id = refs.inbox_document_id
   AND doc.realm_id = refs.realm_id
  LEFT JOIN public.qbo_evidence_register AS parent
    ON parent.realm_id = refs.realm_id
   AND parent.id = refs.register_entry_id
  LEFT JOIN public.qbo_evidence_register AS candidate
    ON candidate.realm_id = refs.realm_id
   AND candidate.qbo_txn_id = refs.candidate_qbo_txn_ids[1]
  WHERE refs.reference_count = 1
)
INSERT INTO public.qbo_evidence_items (
  realm_id, proposed_register_entry_id, candidate_qbo_txn_ids,
  source_type, inbox_document_id, match_confidence, match_evidence,
  match_status, review_status, evidence_role, qbo_attachment_status
)
SELECT
  realm_id, proposed_register_entry_id, candidate_qbo_txn_ids,
  'client_upload', inbox_document_id, match_confidence, match_field_details,
  'potential', 'required', 'unassigned', 'not_requested'
FROM document_rows
ON CONFLICT DO NOTHING;

WITH attachable_references AS (
  SELECT
    r.realm_id,
    r.id AS register_entry_id,
    r.attachable_id AS qbo_attachable_id,
    COALESCE(r.review_candidate_txn_ids, ARRAY[]::text[]) AS candidate_qbo_txn_ids,
    count(*) OVER (PARTITION BY r.realm_id, r.attachable_id) AS reference_count
  FROM public.qbo_evidence_register AS r
  WHERE r.attachable_id IS NOT NULL
)
INSERT INTO public.qbo_evidence_items (
  realm_id, register_entry_id, candidate_qbo_txn_ids,
  source_type, qbo_attachable_id, match_confidence, match_evidence,
  match_status, review_status, evidence_role, qbo_attachment_status
)
SELECT
  refs.realm_id,
  CASE WHEN parent.qbo_txn_id IS NOT NULL THEN parent.id ELSE NULL END,
  refs.candidate_qbo_txn_ids,
  'qbo_attachable', refs.qbo_attachable_id, parent.match_confidence, parent.match_field_details,
  'unreviewed', 'required', 'unassigned', 'unknown'
FROM attachable_references AS refs
JOIN public.qbo_evidence_register AS parent
  ON parent.realm_id = refs.realm_id
 AND parent.id = refs.register_entry_id
WHERE refs.reference_count = 1
ON CONFLICT DO NOTHING;
