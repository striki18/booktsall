import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { rpc: mocks.rpc, from: mocks.from } }));

import { POST } from '@/app/api/transaction-questions/route';

function reloadQuery() {
  const builder: Record<string, any> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.single = vi.fn(async () => ({ data: { id: 'question-1', realm_id: 'realm-owned' }, error: null }));
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ realmId: 'realm-owned', user: { id: 'user-1' } });
  mocks.rpc.mockResolvedValue({ data: 'question-1', error: null });
  mocks.from.mockReturnValue(reloadQuery());
});

describe('transaction questions API', () => {
  it('derives company and actor from authentication and uses the atomic creation function', async () => {
    const response = await POST(new Request('http://localhost/api/transaction-questions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qboTxnId: 'txn-1', qboTxnType: 'Expense', audience: 'client', question: 'What was this for?' }),
    }) as never);
    expect(response.status).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledWith('create_transaction_question', expect.objectContaining({
      p_realm_id: 'realm-owned', p_qbo_txn_id: 'txn-1', p_actor_user_id: 'user-1', p_audience: 'client',
    }));
  });

  it('rejects missing content before any database call', async () => {
    const response = await POST(new Request('http://localhost/api/transaction-questions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ qboTxnId: 'txn-1', audience: 'client' }),
    }) as never);
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('denies anonymous creation before any database call', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await POST(new Request('http://localhost/api/transaction-questions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ qboTxnId: 'txn-1', audience: 'client', question: 'Question' }),
    }) as never);
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
