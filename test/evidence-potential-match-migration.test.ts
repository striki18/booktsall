import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261114000700_confirm_potential_evidence_matches.sql', 'utf8');
const manualSelectionSql = readFileSync('supabase/migrations/20261114001300_allow_reviewed_transaction_selection.sql', 'utf8');

describe('reviewer transaction selection', () => {
  it('accepts a deliberate selection outside suggestions while retaining company and audit guards', () => {
    expect(manualSelectionSql).not.toContain('selected transaction is not among the recorded candidates');
    expect(manualSelectionSql).toMatch(/WHERE realm_id = p_realm_id AND id = p_selected_register_entry_id[\s\S]*?FOR UPDATE/);
    expect(manualSelectionSql).toContain('INSERT INTO public.qbo_evidence_item_review_events');
    expect(manualSelectionSql).toContain("RAISE EXCEPTION 'reviewer is required'");
    expect(manualSelectionSql).toContain("review_status = 'required', evidence_role = 'additional'");
    expect(manualSelectionSql).toMatch(/FROM PUBLIC, anon, authenticated/);
    expect(manualSelectionSql).toMatch(/TO service_role/);
  });
});

describe('potential-match confirmation migration contract', () => {
  it('allows an append-only confirm-match event and keeps the RPC service-role-only', () => {
    expect(sql).toMatch(/'confirm_match'/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.record_qbo_evidence_item_review[\s\S]*FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.record_qbo_evidence_item_review[\s\S]*TO service_role/);
  });

  it('checks the selected candidate and locks its same-realm transaction register row', () => {
    expect(sql).toMatch(/WHERE realm_id = p_realm_id AND id = p_selected_register_entry_id[\s\S]*?FOR UPDATE/);
    expect(sql).toMatch(/target_txn_id = ANY\(item\.candidate_qbo_txn_ids\)/);
    expect(sql).toMatch(/other_item\.realm_id = p_realm_id/);
  });

  it('uses primary only when no active Zevidt item exists and otherwise requires another approval', () => {
    expect(sql).toMatch(/existing_evidence THEN[\s\S]*?evidence_role = 'additional'[\s\S]*?review_status = 'required'/);
    expect(sql).toMatch(/SET match_status = 'verified', review_status = 'not_required', evidence_role = 'primary'/);
    expect(sql).toMatch(/EXCEPTION WHEN unique_violation THEN[\s\S]*?review_status = 'required'[\s\S]*?evidence_role = 'additional'/);
    expect(sql).toMatch(/target_register_state = 'MATCHED'[\s\S]*?target_matched_document_id <> item\.inbox_document_id/);
  });

  it('does not delete or modify QuickBooks transaction financial data', () => {
    expect(sql).not.toMatch(/DELETE FROM public\.(qbo_evidence_items|qbo_evidence_register)|TRUNCATE|DROP TABLE|UPDATE public\.qbo_evidence_register/);
    expect(sql).toContain('INSERT INTO public.qbo_evidence_item_review_events');
  });
});
