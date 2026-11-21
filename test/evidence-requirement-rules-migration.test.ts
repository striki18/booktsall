import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261114001000_add_evidence_requirement_rules.sql', 'utf8');

describe('company evidence requirement rules migration contract', () => {
  it('creates an empty-by-default table with explicit transaction, range, and document-type fields', () => {
    expect(sql).toContain('CREATE TABLE public.evidence_requirement_rules');
    expect(sql).toContain('transaction_type text NOT NULL');
    expect(sql).toContain('amount_min numeric');
    expect(sql).toContain('amount_max numeric');
    expect(sql).toContain('document_type text NOT NULL');
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.evidence_requirement_rules/i);
  });

  it('enforces tenant RLS and grants only intended rule operations', () => {
    expect(sql).toContain('ALTER TABLE public.evidence_requirement_rules ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain("realm_id = (auth.jwt() -> 'app_metadata' ->> 'realm_id')");
    expect(sql).toContain('REVOKE ALL ON TABLE public.evidence_requirement_rules FROM PUBLIC, anon, authenticated, service_role');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE public.evidence_requirement_rules TO authenticated');
    expect(sql).not.toMatch(/GRANT\s+[^;]*\bDELETE\b[^;]*evidence_requirement_rules/i);
  });

  it('does not encode mandatory policy defaults or assume a rule for any audit type', () => {
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.evidence_requirement_rules/i);
    expect(sql).toContain("CHECK (amount_min IS NULL OR amount_max IS NULL OR amount_min <= amount_max)");
  });
});
