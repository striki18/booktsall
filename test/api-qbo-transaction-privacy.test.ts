import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), getTransactions: vi.fn(), normalizeTransactionList: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/quickbooks', () => ({ getTransactions: mocks.getTransactions, normalizeTransactionList: mocks.normalizeTransactionList }));

import { GET } from '@/app/api/quickbooks/transactions/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ realmId: 'realm-1' });
  mocks.getTransactions.mockResolvedValue({ report: 'raw' });
  mocks.normalizeTransactionList.mockReturnValue([{ vendor: 'PRIVATE_VENDOR_SENTINEL' }]);
});
afterEach(() => vi.restoreAllMocks());

describe('QuickBooks transaction route log privacy', () => {
  it('returns normalized rows without writing transaction details to logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = await GET(new Request('http://localhost/api/quickbooks/transactions'));
    expect(response.status).toBe(200);
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_VENDOR_SENTINEL');
  });
});
