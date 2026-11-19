import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireOwned: vi.fn(), storageFrom: vi.fn(), upload: vi.fn(), remove: vi.fn(), from: vi.fn(), insert: vi.fn() }));
vi.mock('@/lib/resource-access', () => ({ requireOwnedEvidenceRequest: mocks.requireOwned, ownershipErrorStatus: () => null }));
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { storage: { from: mocks.storageFrom } } }));

import { POST } from '@/app/api/evidence/request/[id]/upload/route';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

beforeEach(() => {
  vi.clearAllMocks();
  const requestQuery: any = {};
  requestQuery.select = vi.fn(() => requestQuery);
  requestQuery.eq = vi.fn(() => requestQuery);
  requestQuery.single = vi.fn().mockResolvedValue({ data: { id: requestId, engagement_id: 'eng-1' }, error: null });
  mocks.insert.mockImplementation(() => ({ select: vi.fn().mockResolvedValue({ data: [{ id: 'document-1', uploaded_at: '2026-11-14T00:00:00Z' }], error: null }) }));
  mocks.from.mockImplementation((table: string) => table === 'evidence_requests' ? requestQuery : ({ insert: mocks.insert }));
  mocks.requireOwned.mockResolvedValue({ supabase: { from: mocks.from } });
  mocks.storageFrom.mockReturnValue({ upload: mocks.upload, remove: mocks.remove });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.remove.mockResolvedValue({ error: null });
});

async function postSameNameFile() {
  const form = new FormData();
  form.append('file', new File(['%PDF-1.7 sample'], '../receipt.pdf', { type: 'application/pdf' }));
  const request = new Request('http://localhost/api/evidence/request/upload', { method: 'POST', body: form });
  return POST(request as never, { params: Promise.resolve({ id: requestId }) });
}

describe('evidence request upload immutability', () => {
  it('stores repeated same-name uploads at separate safe paths without deleting existing objects', async () => {
    const first = await postSameNameFile();
    const second = await postSameNameFile();
    const firstPath = mocks.upload.mock.calls[0][0];
    const secondPath = mocks.upload.mock.calls[1][0];

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstPath.startsWith('eng-1/123e4567-e89b-42d3-a456-426614174000/')).toBe(true);
    expect(firstPath).not.toContain('/../');
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
