-- Reviewers may explicitly select another transaction within their company.
-- Keep the existing RPC signature, row locks, review ledger and server permissions.
BEGIN;

CREATE OR REPLACE FUNCTION public.record_qbo_evidence_item_review(
  p_realm_id text,
  p_evidence_item_id uuid,
  p_reviewer_user_id uuid,
  p_action text,
  p_selected_register_entry_id uuid DEFAULT NULL,
  p_rationale text DEFAULT NULL
)
RETURNS public.qbo_evidence_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  item public.qbo_evidence_items%ROWTYPE;
  target_txn_id text;
  target_register_state text;
  target_matched_document_id uuid;
  existing_evidence boolean;
BEGIN
  IF p_action NOT IN ('approve_additional', 'add_duplicate', 'discard_additional', 'discard_duplicate', 'confirm_match') THEN
    RAISE EXCEPTION 'unsupported evidence item review action';
  END IF;
  IF p_reviewer_user_id IS NULL THEN
    RAISE EXCEPTION 'reviewer is required';
  END IF;

  SELECT * INTO item
    FROM public.qbo_evidence_items
    WHERE realm_id = p_realm_id AND id = p_evidence_item_id
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'evidence item not found'; END IF;
  IF item.review_status <> 'required' OR item.qbo_attachment_status <> 'not_requested' THEN
    RAISE EXCEPTION 'evidence item is not awaiting a review decision';
  END IF;

  IF p_action = 'confirm_match' THEN
    IF item.match_status <> 'potential' OR item.evidence_role <> 'unassigned' OR item.register_entry_id IS NOT NULL OR p_selected_register_entry_id IS NULL THEN
      RAISE EXCEPTION 'potential evidence requires a selected transaction';
    END IF;

    SELECT qbo_txn_id, register_state, matched_document_id
      INTO target_txn_id, target_register_state, target_matched_document_id
      FROM public.qbo_evidence_register
      WHERE realm_id = p_realm_id AND id = p_selected_register_entry_id
      FOR UPDATE;
    IF NOT FOUND OR target_txn_id IS NULL THEN RAISE EXCEPTION 'selected transaction is unavailable'; END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.qbo_evidence_items AS other_item
      WHERE other_item.realm_id = p_realm_id
        AND other_item.register_entry_id = p_selected_register_entry_id
        AND other_item.id <> p_evidence_item_id
        AND other_item.review_status <> 'discarded'
    ) INTO existing_evidence;
    existing_evidence := existing_evidence OR (
      target_register_state = 'MATCHED'
      AND target_matched_document_id IS NOT NULL
      AND target_matched_document_id <> item.inbox_document_id
    );

    IF existing_evidence THEN
      UPDATE public.qbo_evidence_items
        SET match_status = 'verified', review_status = 'required', evidence_role = 'additional',
            register_entry_id = p_selected_register_entry_id, proposed_register_entry_id = NULL,
            candidate_qbo_txn_ids = ARRAY[target_txn_id], updated_at = now()
        WHERE realm_id = p_realm_id AND id = p_evidence_item_id
        RETURNING * INTO item;
    ELSE
      BEGIN
        UPDATE public.qbo_evidence_items
          SET match_status = 'verified', review_status = 'not_required', evidence_role = 'primary',
              register_entry_id = p_selected_register_entry_id, proposed_register_entry_id = NULL,
              candidate_qbo_txn_ids = ARRAY[target_txn_id], updated_at = now()
          WHERE realm_id = p_realm_id AND id = p_evidence_item_id
          RETURNING * INTO item;
      EXCEPTION WHEN unique_violation THEN
        UPDATE public.qbo_evidence_items
          SET match_status = 'verified', review_status = 'required', evidence_role = 'additional',
              register_entry_id = p_selected_register_entry_id, proposed_register_entry_id = NULL,
              candidate_qbo_txn_ids = ARRAY[target_txn_id], updated_at = now()
          WHERE realm_id = p_realm_id AND id = p_evidence_item_id
          RETURNING * INTO item;
      END;
    END IF;
  ELSIF p_action IN ('approve_additional', 'discard_additional') THEN
    IF item.match_status <> 'verified' OR item.evidence_role <> 'additional' OR item.register_entry_id IS NULL THEN
      RAISE EXCEPTION 'evidence item is not additional evidence awaiting review';
    END IF;
    IF p_selected_register_entry_id IS NOT NULL AND p_selected_register_entry_id <> item.register_entry_id THEN
      RAISE EXCEPTION 'additional evidence transaction cannot be reassigned by this action';
    END IF;
  ELSIF p_action = 'add_duplicate' THEN
    IF item.match_status <> 'duplicate' OR item.evidence_role <> 'unassigned' OR p_selected_register_entry_id IS NULL THEN
      RAISE EXCEPTION 'duplicate requires a selected transaction before it can be added';
    END IF;
    SELECT qbo_txn_id INTO target_txn_id
      FROM public.qbo_evidence_register
      WHERE realm_id = p_realm_id AND id = p_selected_register_entry_id
      FOR SHARE;
    IF NOT FOUND OR target_txn_id IS NULL THEN RAISE EXCEPTION 'selected transaction is unavailable'; END IF;
    UPDATE public.qbo_evidence_items
      SET match_status = 'verified', review_status = 'approved', evidence_role = 'additional',
          register_entry_id = p_selected_register_entry_id, proposed_register_entry_id = NULL,
          candidate_qbo_txn_ids = ARRAY[target_txn_id], updated_at = now()
      WHERE realm_id = p_realm_id AND id = p_evidence_item_id
      RETURNING * INTO item;
  ELSE
    IF item.match_status <> 'duplicate' OR item.evidence_role <> 'unassigned' THEN
      RAISE EXCEPTION 'evidence item is not a duplicate awaiting review';
    END IF;
    UPDATE public.qbo_evidence_items
      SET review_status = 'discarded', updated_at = now()
      WHERE realm_id = p_realm_id AND id = p_evidence_item_id
      RETURNING * INTO item;
  END IF;

  IF p_action = 'approve_additional' THEN
    UPDATE public.qbo_evidence_items
      SET review_status = 'approved', updated_at = now()
      WHERE realm_id = p_realm_id AND id = p_evidence_item_id
      RETURNING * INTO item;
  ELSIF p_action = 'discard_additional' THEN
    UPDATE public.qbo_evidence_items
      SET review_status = 'discarded', updated_at = now()
      WHERE realm_id = p_realm_id AND id = p_evidence_item_id
      RETURNING * INTO item;
  END IF;

  INSERT INTO public.qbo_evidence_item_review_events (
    realm_id, evidence_item_id, reviewer_user_id, action,
    selected_register_entry_id, rationale
  ) VALUES (
    p_realm_id, p_evidence_item_id, p_reviewer_user_id, p_action,
    COALESCE(p_selected_register_entry_id, item.register_entry_id), p_rationale
  );
  RETURN item;
END;
$$;

REVOKE ALL ON FUNCTION public.record_qbo_evidence_item_review(text, uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_qbo_evidence_item_review(text, uuid, uuid, text, uuid, text) TO service_role;

COMMIT;
