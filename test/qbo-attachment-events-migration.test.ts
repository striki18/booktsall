import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20261114000500_add_qbo_attachment_events.sql', 'utf8');

describe('QBO attachment event migration', () => {
  it('stores realm-scoped append-only events linked without cascading evidence deletion', () => {
    expect(migration).toMatch(/CREATE TABLE public\.qbo_attachment_events/i);
    expect(migration).toMatch(/FOREIGN KEY \(realm_id, evidence_item_id\)[\s\S]*?ON DELETE RESTRICT/i);
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE ON public\.qbo_attachment_events/i);
    expect(migration).toMatch(/qbo_attachment_events is append-only/i);
  });

  it('prevents more than one upload attempt per evidence item', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX qbo_attachment_events_one_attempt_per_item_uq[\s\S]*?WHERE event_type = 'attempt_started'/i);
  });

  it('grants authenticated users read access only and trusted service writes only by insert', () => {
    expect(migration).toMatch(/FOR SELECT TO authenticated[\s\S]*?app_metadata[\s\S]*?realm_id/i);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.qbo_attachment_events FROM PUBLIC, anon, authenticated, service_role/i);
    expect(migration).toMatch(/GRANT SELECT, INSERT ON TABLE public\.qbo_attachment_events TO service_role/i);
    expect(migration).not.toMatch(/GRANT[^;]*(UPDATE|DELETE|TRUNCATE)[^;]*qbo_attachment_events/i);
  });
});
