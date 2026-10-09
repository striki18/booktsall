-- Migration: Create QBO Evidence Register table and upsert function
-- This migration is safe to run once against the existing schema.
-- It does not recreate existing indexes or columns unnecessarily.

-- 1. Ensure qbo_evidence_register table exists with qbo_txn_id nullable
-- (Partial unique index already exists: ux_qbo_evidence_register_one_per_txn)

DO $$
BEGIN
  -- Make qbo_txn_id nullable if it currently has NOT NULL constraint
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'qbo_evidence_register'
      AND column_name = 'qbo_txn_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.qbo_evidence_register
      ALTER COLUMN qbo_txn_id DROP NOT NULL;
  END IF;
END $$;

-- 2. Create the upsert function with exact parameter names matching TypeScript RPC calls
-- The function uses SECURITY DEFINER with fixed empty search_path for security
-- Only service_role can execute (application uses supabaseAdmin)

CREATE OR REPLACE FUNCTION public.upsert_qbo_evidence_register_txn(
  p_realm_id                   text,
  p_collection_request_id      text,
  p_qbo_txn_id                 text,
  p_qbo_txn_type               text,
  p_qbo_txn_date               date,
  p_qbo_txn_vendor             text,
  p_qbo_txn_amount             numeric,
  p_qbo_txn_doc_number         text,
  p_attachable_id              text,
  p_attachment_filename        text,
  p_attachment_file_size       bigint,
  p_attachment_download_url    text,
  p_register_state             public.qbo_register_state,
  p_matched_document_id        uuid,
  p_match_confidence           numeric,
  p_match_field_details        jsonb,
  p_correct_qbo_txn_id         text,
  p_review_candidate_txn_ids   text[],
  p_computed_at                timestamptz
)
RETURNS public.qbo_evidence_register
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.qbo_evidence_register;
BEGIN
  -- Atomic upsert using ON CONFLICT matching the partial unique index:
  -- ux_qbo_evidence_register_one_per_txn (realm_id, qbo_txn_id) WHERE qbo_txn_id IS NOT NULL
  INSERT INTO public.qbo_evidence_register (
    realm_id,
    collection_request_id,
    qbo_txn_id,
    qbo_txn_type,
    qbo_txn_date,
    qbo_txn_vendor,
    qbo_txn_amount,
    qbo_txn_doc_number,
    attachable_id,
    attachment_filename,
    attachment_file_size,
    attachment_download_url,
    register_state,
    matched_document_id,
    match_confidence,
    match_field_details,
    correct_qbo_txn_id,
    review_candidate_txn_ids,
    computed_at
  ) VALUES (
    p_realm_id,
    p_collection_request_id,
    p_qbo_txn_id,
    p_qbo_txn_type,
    p_qbo_txn_date,
    p_qbo_txn_vendor,
    p_qbo_txn_amount,
    p_qbo_txn_doc_number,
    p_attachable_id,
    p_attachment_filename,
    p_attachment_file_size,
    p_attachment_download_url,
    p_register_state,
    p_matched_document_id,
    p_match_confidence,
    p_match_field_details,
    p_correct_qbo_txn_id,
    p_review_candidate_txn_ids,
    p_computed_at
  )
  ON CONFLICT (realm_id, qbo_txn_id) WHERE qbo_txn_id IS NOT NULL
  DO UPDATE SET
    collection_request_id      = EXCLUDED.collection_request_id,
    qbo_txn_type               = EXCLUDED.qbo_txn_type,
    qbo_txn_date               = EXCLUDED.qbo_txn_date,
    qbo_txn_vendor             = EXCLUDED.qbo_txn_vendor,
    qbo_txn_amount             = EXCLUDED.qbo_txn_amount,
    qbo_txn_doc_number         = EXCLUDED.qbo_txn_doc_number,
    attachable_id              = EXCLUDED.attachable_id,
    attachment_filename        = EXCLUDED.attachment_filename,
    attachment_file_size       = EXCLUDED.attachment_file_size,
    attachment_download_url    = EXCLUDED.attachment_download_url,
    register_state             = EXCLUDED.register_state,
    matched_document_id        = EXCLUDED.matched_document_id,
    match_confidence           = EXCLUDED.match_confidence,
    match_field_details        = EXCLUDED.match_field_details,
    correct_qbo_txn_id         = EXCLUDED.correct_qbo_txn_id,
    review_candidate_txn_ids   = EXCLUDED.review_candidate_txn_ids,
    computed_at                = EXCLUDED.computed_at
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- 3. Security: Revoke execution from PUBLIC, grant only to service_role
REVOKE EXECUTE ON FUNCTION public.upsert_qbo_evidence_register_txn(text, text, text, text, date, text, numeric, text, text, text, bigint, text, public.qbo_register_state, uuid, numeric, jsonb, text, text[], timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_qbo_evidence_register_txn(text, text, text, text, date, text, numeric, text, text, text, bigint, text, public.qbo_register_state, uuid, numeric, jsonb, text, text[], timestamptz) TO service_role;