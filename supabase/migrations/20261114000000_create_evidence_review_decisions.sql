-- Append-only history for human review of evidence register entries.
-- Review decisions are not automatically applied to the computed register.
-- Compare this schema and migration history with the target database before applying.
CREATE TABLE IF NOT EXISTS public.evidence_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id text NOT NULL,
  register_entry_id uuid NOT NULL,
  evidence_document_id uuid REFERENCES public.inbox_documents(id) ON DELETE RESTRICT,
  reviewer_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('confirm_match', 'reject_match', 'mark_wrong_match', 'assign_transaction')),
  selected_qbo_txn_id text,
  rationale text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_review_decisions_assignment_target
    CHECK (action <> 'assign_transaction' OR selected_qbo_txn_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_evidence_review_decisions_entry_created
  ON public.evidence_review_decisions (realm_id, evidence_document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_review_decisions_register_created
  ON public.evidence_review_decisions (realm_id, register_entry_id, created_at DESC);

ALTER TABLE public.evidence_review_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS evidence_review_decisions_company_read ON public.evidence_review_decisions;
CREATE POLICY evidence_review_decisions_company_read
  ON public.evidence_review_decisions
  FOR SELECT TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

DROP POLICY IF EXISTS evidence_review_decisions_company_insert ON public.evidence_review_decisions;
CREATE POLICY evidence_review_decisions_company_insert
  ON public.evidence_review_decisions
  FOR INSERT TO authenticated
  WITH CHECK (
    realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')
    AND reviewer_user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.qbo_evidence_register r
      WHERE r.id = evidence_review_decisions.register_entry_id
        AND r.realm_id = evidence_review_decisions.realm_id
    )
    AND (
      evidence_review_decisions.evidence_document_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.inbox_documents d
        WHERE d.id = evidence_review_decisions.evidence_document_id
          AND d.realm_id = evidence_review_decisions.realm_id
      )
    )
  );

REVOKE ALL ON TABLE public.evidence_review_decisions FROM anon;
GRANT SELECT, INSERT ON TABLE public.evidence_review_decisions TO authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.evidence_review_decisions FROM authenticated;
