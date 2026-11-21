import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261114000900_audit_evidence_item_state_changes.sql', 'utf8');

describe('evidence-item lifecycle audit migration contract', () => {
  it('fails closed unless the evidence-item base table and same-realm identity exist', () => {
    expect(sql.indexOf("to_regclass('public.qbo_evidence_items') IS NULL")).toBeLessThan(sql.indexOf('CREATE TABLE public.qbo_evidence_item_events'));
    expect(sql).toContain("conname = 'qbo_evidence_items_realm_id_id_uq'");
    expect(sql).toContain('FOREIGN KEY (realm_id, evidence_item_id)');
    expect(sql).toContain('ON DELETE RESTRICT');
  });

  it('records create and meaningful update events without copying extracted match data', () => {
    expect(sql).toContain("CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END");
    expect(sql).toContain('AFTER INSERT OR UPDATE ON public.qbo_evidence_items');
    expect(sql).toContain('changed_fields, before_state, after_state');
    expect(sql).toContain("('match_evidence', OLD.match_evidence, NEW.match_evidence)");
    expect(sql).not.toContain("'match_evidence', NEW.match_evidence");
    expect(sql).toContain('IF cardinality(changed_fields) = 0 THEN');
  });

  it('blocks evidence deletion and makes audit events append-only', () => {
    expect(sql).toContain('BEFORE DELETE ON public.qbo_evidence_items');
    expect(sql).toContain('BEFORE TRUNCATE ON public.qbo_evidence_items');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON public.qbo_evidence_item_events');
    expect(sql).toContain('BEFORE TRUNCATE ON public.qbo_evidence_item_events');
    expect(sql).toContain('qbo_evidence_items cannot be deleted');
    expect(sql).toContain('qbo_evidence_item_events is append-only');
  });

  it('restricts event reads to the authenticated company and denies direct writes', () => {
    expect(sql).toContain('ALTER TABLE public.qbo_evidence_item_events ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain("realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')");
    expect(sql).toContain('REVOKE ALL ON TABLE public.qbo_evidence_item_events FROM PUBLIC, anon, authenticated, service_role');
    expect(sql).toContain('GRANT SELECT ON TABLE public.qbo_evidence_item_events TO authenticated');
    expect(sql).not.toMatch(/GRANT\s+[^;]*\bINSERT\b[^;]*qbo_evidence_item_events/i);
  });

  it('does not fabricate events for historical items', () => {
    expect(sql).toContain('Existing items are not backfilled with synthetic events');
    const normalizedSql = sql.replace(/\s+/g, ' ').toLowerCase();
    expect(normalizedSql).not.toMatch(/insert into public\.qbo_evidence_item_events\s*\([^)]*\)\s*select/);
  });
});
