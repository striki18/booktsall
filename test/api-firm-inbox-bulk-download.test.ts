import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), query: {} as Record<string, any>, is: vi.fn(), download: vi.fn(), buildZip: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/evidence-package-zip', () => ({ buildEvidencePackageZip: mocks.buildZip }));
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => mocks.query),
    storage: { from: vi.fn(() => ({ download: mocks.download })) },
  },
}));

import { POST } from '@/app/api/firm/inbox/documents/bulk-download/route';

const documentId = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.query, {
    select: vi.fn(() => mocks.query), eq: vi.fn(() => mocks.query), in: vi.fn(() => mocks.query), is: mocks.is,
  });
});

describe('firm inbox bulk document download', () => {
  it('rejects anonymous requests before reading document metadata', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ documentIds: [documentId] }) }));
    expect(response.status).toBe(401);
    expect(mocks.query.select).not.toHaveBeenCalled();
  });

  it('downloads only active documents in the authenticated realm and returns a ZIP', async () => {
    mocks.requireAuth.mockResolvedValue({ realmId: 'realm-1' });
    mocks.is.mockResolvedValue({ data: [{ id: documentId, filename: 'receipt.pdf', storage_path: 'inbox/realm-1/receipt.pdf' }], error: null });
    mocks.download.mockResolvedValue({ data: new Blob(['pdf-bytes']), error: null });
    mocks.buildZip.mockResolvedValue(Buffer.from('zip-bytes'));

    const response = await POST(new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentIds: [documentId] }) }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(mocks.query.eq).toHaveBeenCalledWith('realm_id', 'realm-1');
    expect(mocks.query.is).toHaveBeenCalledWith('archived_at', null);
    expect(mocks.download).toHaveBeenCalledWith('inbox/realm-1/receipt.pdf');
    expect(mocks.buildZip).toHaveBeenCalledWith(expect.stringMatching(/^selection-/), [expect.objectContaining({ documentId, fileName: 'receipt.pdf' })], []);
  });
});
