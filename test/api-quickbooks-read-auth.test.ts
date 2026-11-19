import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getTransactions: vi.fn(),
  getCompanyInfo: vi.fn(),
  getAttachables: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/quickbooks', () => ({
  getTransactions: mocks.getTransactions,
  getCompanyInfo: mocks.getCompanyInfo,
  getAttachables: mocks.getAttachables,
  normalizeAttachables: vi.fn(() => []),
  normalizeTransactionList: vi.fn(() => []),
  downloadFile: mocks.downloadFile,
}));

import { GET as transactions } from '@/app/api/quickbooks/transactions/route';
import { GET as companyInfo } from '@/app/api/quickbooks/companyInfo/route';
import { GET as attachables } from '@/app/api/quickbooks/attachables/route';
import { GET as download } from '@/app/api/quickbooks/attachables/[attachableId]/download/route';

beforeEach(() => vi.clearAllMocks());

describe('QuickBooks read routes', () => {
  it('rejects anonymous callers before invoking QuickBooks helpers', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('UNAUTHORIZED'));
    const responses = await Promise.all([
      transactions(new Request('http://localhost/api/quickbooks/transactions')),
      companyInfo(),
      attachables(new Request('http://localhost/api/quickbooks/attachables')),
      download(new Request('http://localhost/api/quickbooks/attachables/1/download') as never, {
        params: Promise.resolve({ attachableId: '1' }),
      }),
    ]);

    expect(responses.map(response => response.status)).toEqual([401, 401, 401, 401]);
    expect(mocks.getTransactions).not.toHaveBeenCalled();
    expect(mocks.getCompanyInfo).not.toHaveBeenCalled();
    expect(mocks.getAttachables).not.toHaveBeenCalled();
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  });

  it('passes the authenticated realm to transaction and company read helpers', async () => {
    mocks.requireAuth.mockResolvedValue({ realmId: 'realm-owned' });
    mocks.getTransactions.mockResolvedValue({});
    mocks.getCompanyInfo.mockResolvedValue({ companyName: 'Test Company' });

    await transactions(new Request('http://localhost/api/quickbooks/transactions?startDate=2025-01-01&endDate=2025-01-31'));
    await companyInfo();

    expect(mocks.getTransactions).toHaveBeenCalledWith('2025-01-01', '2025-01-31', 'realm-owned');
    expect(mocks.getCompanyInfo).toHaveBeenCalledWith('realm-owned');
  });

  it('passes the authenticated realm to attachable listing', async () => {
    mocks.requireAuth.mockResolvedValue({ realmId: 'realm-owned' });
    mocks.getAttachables.mockResolvedValue({ attachables: [] });

    await attachables(new Request('http://localhost/api/quickbooks/attachables'));

    expect(mocks.getAttachables).toHaveBeenCalledWith('realm-owned');
  });
});