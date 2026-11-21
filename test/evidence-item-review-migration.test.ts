import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261114000600_add_evidence_item_review_decisions.sql', 'utf8');

describe('evidence-item review migration contract', () => {
  it('records same-company item decisions in an append-only table', () => {
    expect(sql).toMatch(/CREATE TABLE public\.qbo_evidence_item_review_events/);
    expect(sql).toMatch(/FOREIGN KEY \(realm_id, evidence_item_id\)[\s\S]*?REFERENCES public\.qbo_evidence_items \(realm_id, id\)[\s\S]*?ON DELETE RESTRICT/);
    expect(sql).toMatch(/FOREIGN KEY \(realm_id, selected_register_entry_id\)[\s\S]*?REFERENCES public\.qbo_evidence_register \(realm_id, id\)[\s\S]*?ON DELETE RESTRICT/);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.qbo_evidence_item_review_events/);
  });

  it('limits direct access and makes decisions atomic under a row lock', () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/USING \(realm_id = \(auth\.jwt\(\) -> 'app_metadata' ->> 'realm_id'\)\)/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.qbo_evidence_item_review_events FROM PUBLIC, anon, authenticated, service_role/);
    expect(sql).toMatch(/GRANT SELECT, INSERT ON TABLE public\.qbo_evidence_item_review_events TO service_role/);
    expect(sql).toMatch(/record_qbo_evidence_item_review[\s\S]*?FOR UPDATE/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.record_qbo_evidence_item_review[\s\S]*?TO service_role/);
  });

  it('supports approved additional evidence, duplicate Add, and non-destructive Discard', () => {
    expect(sql).toMatch(/'approve_additional'[\s\S]*?'add_duplicate'[\s\S]*?'discard_additional'[\s\S]*?'discard_duplicate'/);
    expect(sql).toMatch(/SET match_status = 'verified', review_status = 'approved', evidence_role = 'additional'/);
    expect(sql).toMatch(/SET review_status = 'discarded', updated_at = now\(\)/);
    expect(sql).not.toMatch(/DELETE FROM public\.qbo_evidence_items|TRUNCATE|DROP TABLE/);
  });
});
