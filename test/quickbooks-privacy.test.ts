import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }));

import { getAccessToken, getTransactions, storeToken } from '../lib/quickbooks';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('QuickBooks transaction log privacy', () => {
  it('does not log raw vendor or transaction values', async () => {
    const realmId = 'realm-test';
    const sentinel = 'PRIVATE_VENDOR_SENTINEL';
    await storeToken({ access_token: 'test-access', refresh_token: 'test-refresh', expires_at: new Date(Date.now() + 3600000).toISOString() }, realmId);
    const report = {
      Columns: { Column: [
        { ColTitle: 'Transaction Type' }, { ColTitle: 'Date' }, { ColTitle: 'Name' }, { ColTitle: 'Amount' }, { ColTitle: 'Num' },
      ] },
      Rows: { Row: [{ ColData: [
        { value: 'Bill', id: 'txn-private' }, { value: '2026-11-01' }, { value: sentinel }, { value: '81.25' }, { value: 'INV-private' },
      ] }] },
    };
    (fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => report });

    await getTransactions('2026-11-01', '2026-11-30', realmId);

    const logged = (console.log as any).mock.calls.flat().join(' ');
    expect(logged).not.toContain(sentinel);
    expect(logged).not.toContain('txn-private');
    expect(logged).not.toContain('INV-private');
    expect(logged).toContain('1 transactions');
  });

  it('does not reuse a cached token for a different company realm', async () => {
    await storeToken({ access_token: 'token-for-realm-a', refresh_token: 'refresh-a', expires_at: new Date(Date.now() + 3600000).toISOString() }, 'realm-a');

    await expect(getAccessToken('realm-b')).rejects.toThrow('No QuickBooks token found');
    expect(fetch).not.toHaveBeenCalled();
  });
});
