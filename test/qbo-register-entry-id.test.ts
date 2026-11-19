import { describe, expect, it, vi } from 'vitest';

const mockQuery = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock('../lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => {
      const query: any = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        order: vi.fn(() => query),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: mockQuery.data, error: null }).then(resolve),
      };
      return query;
    }),
  },
}));

import { getRegisterEntries } from '../lib/qbo-evidence-register';

describe('persisted evidence register identity', () => {
  it('preserves the database entry ID for row-scoped review actions', async () => {
    mockQuery.data = [{ id: 'entry-1', realm_id: 'realm-1', qbo_txn_id: 'txn-1', register_state: 'REVIEW_REQUIRED' }];

    const entries = await getRegisterEntries('realm-1');

    expect(entries[0].id).toBe('entry-1');
    expect(entries[0].qboTxnId).toBe('txn-1');
  });
});
