import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  from: vi.fn(),
  updateUserById: vi.fn(),
  membership: null as { realm_id: string } | null,
  companies: [] as Array<{ realm_id: string; company_name: string | null }>,
}));
vi.mock('@/lib/auth', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: mocks.from,
    auth: { admin: { updateUserById: mocks.updateUserById } },
  },
}));

import { GET, POST } from '@/app/api/quickbooks/companies/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.membership = null;
  mocks.companies = [];
  mocks.requireUser.mockResolvedValue({ id: 'user-1', app_metadata: { realm_id: 'realm-1' } });
  mocks.updateUserById.mockResolvedValue({ error: null });
  mocks.from.mockImplementation(() => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order']) query[method] = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: mocks.membership, error: null }));
    query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve({ data: mocks.companies, error: null }).then(resolve, reject);
    return query;
  });
});

describe('QuickBooks company selection', () => {
  it('lists only memberships belonging to the authenticated user', async () => {
    mocks.companies = [{ realm_id: 'realm-1', company_name: 'Company One' }];
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mocks.from).toHaveBeenCalledWith('qbo_company_memberships');
    expect((await response.json()).activeRealmId).toBe('realm-1');
  });

  it('rejects a company that is not a membership of the signed-in user', async () => {
    const response = await POST(new Request('http://localhost/api/quickbooks/companies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ realmId: 'realm-other' }),
    }));
    expect(response.status).toBe(403);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it('updates only the server-controlled active company after membership verification', async () => {
    mocks.membership = { realm_id: 'realm-2' };
    const response = await POST(new Request('http://localhost/api/quickbooks/companies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ realmId: 'realm-2' }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateUserById).toHaveBeenCalledWith('user-1', { app_metadata: { realm_id: 'realm-2' } });
    expect(await response.json()).toEqual({ activeRealmId: 'realm-2' });
  });
});
