import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: mocks.from } }));

import { GET } from '@/app/api/firm/dashboard/route';

function query(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order']) chain[method] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => result);
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

beforeEach(() => vi.clearAllMocks());

describe('firm dashboard', () => {
  it('requires authentication before querying company data', async () => {
    mocks.requireUser.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('loads only memberships belonging to the signed-in user and scopes every metric by realm', async () => {
    mocks.requireUser.mockResolvedValue({ id: 'user-1', app_metadata: { realm_id: 'realm-1' } });
    const membershipQuery = query({ data: [{ realm_id: 'realm-1', company_name: 'Demo Co', created_at: '2026-01-01' }], error: null });
    const tokenQuery = query({ data: { expires_at: '2099-01-01T00:00:00Z' }, error: null });
    const registerQuery = query({ data: [{ register_state: 'MISSING' }, { register_state: 'MATCHED' }], error: null });
    const inboxQuery = query({ data: [{ processing_status: 'processed' }], error: null });
    mocks.from.mockImplementation((table: string) => ({ qbo_company_memberships: membershipQuery, quickbooks_tokens: tokenQuery, qbo_evidence_register: registerQuery, inbox_documents: inboxQuery }[table]));

    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.companies[0]).toMatchObject({ realmId: 'realm-1', active: true, connection: 'connected', transactions: 2, matched: 1, missing: 1, inboxDocuments: 1 });
    expect((membershipQuery.eq as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('user_id', 'user-1');
    expect((registerQuery.eq as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('realm_id', 'realm-1');
    expect((inboxQuery.eq as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('realm_id', 'realm-1');
  });
});
