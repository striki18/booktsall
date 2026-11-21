-- Durable, company-scoped review decisions for individual uploaded evidence items.
-- The RPC atomically records a decision and changes only the evidence item's review state.

ALTER TABLE public.qbo_evidence_items
  DROP CONSTRAINT qbo_evidence_items_status_role_check;

ALTER TABLE public.qbo_evidence_items
  ADD CONSTRAINT qbo_evidence_items_status_role_check CHECK (
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
      AND review_status IN ('required', 'approved', 'discarded')
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
  );

CREATE TABLE public.qbo_evidence_item_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id text NOT NULL,
  evidence_item_id uuid NOT NULL,
  reviewer_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'approve_additional',
    'add_duplicate',
    'discard_additional',
    'discard_duplicate'
  )),
  selected_register_entry_id uuid,
  rationale text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qbo_evidence_item_review_events_item_same_realm_fk
    FOREIGN KEY (realm_id, evidence_item_id)
    REFERENCES public.qbo_evidence_items (realm_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT qbo_evidence_item_review_events_register_same_realm_fk
    FOREIGN KEY (realm_id, selected_register_entry_id)
    REFERENCES public.qbo_evidence_register (realm_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX qbo_evidence_item_review_events_item_created_idx
  ON public.qbo_evidence_item_review_events (realm_id, evidence_item_id, created_at, id);

CREATE FUNCTION public.reject_qbo_evidence_item_review_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'qbo_evidence_item_review_events is append-only';
END;
$$;

CREATE TRIGGER qbo_evidence_item_review_events_append_only
  BEFORE UPDATE OR DELETE ON public.qbo_evidence_item_review_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_qbo_evidence_item_review_event_mutation();

ALTER TABLE public.qbo_evidence_item_review_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY qbo_evidence_item_review_events_company_select
  ON public.qbo_evidence_item_review_events
  FOR SELECT TO authenticated
  USING (realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id'));

REVOKE ALL ON TABLE public.qbo_evidence_item_review_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.qbo_evidence_item_review_events TO authenticated;
GRANT SELECT, INSERT ON TABLE public.qbo_evidence_item_review_events TO service_role;
REVOKE ALL ON FUNCTION public.reject_qbo_evidence_item_review_event_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_qbo_evidence_item_review(
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
BEGIN
  IF p_action NOT IN ('approve_additional', 'add_duplicate', 'discard_additional', 'discard_duplicate') THEN
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

  IF p_action IN ('approve_additional', 'discard_additional') THEN
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
