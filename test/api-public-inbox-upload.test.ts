import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), storageFrom: vi.fn(), upload: vi.fn(), remove: vi.fn(), insert: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mocks.from, storage: { from: mocks.storageFrom } }) }));

import { POST } from '@/app/api/inbox/[token]/route';

beforeEach(() => {
  vi.clearAllMocks();
  const inboxQuery: any = {};
  inboxQuery.select = vi.fn(() => inboxQuery);
  inboxQuery.eq = vi.fn(() => inboxQuery);
  inboxQuery.single = vi.fn().mockResolvedValue({ data: { id: 'inbox-1', realm_id: 'realm-1' }, error: null });
  mocks.insert.mockImplementation(() => ({ select: () => ({ single: vi.fn().mockResolvedValue({ data: null, error: { message: 'metadata insert failed' } }) }) }));
  mocks.from.mockImplementation((table: string) => table === 'company_inboxes' ? inboxQuery : ({ insert: mocks.insert }));
  mocks.storageFrom.mockReturnValue({ upload: mocks.upload, remove: mocks.remove });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.remove.mockResolvedValue({ error: null });
});

function postFiles(files: File[]) {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  const request = new Request('http://localhost/api/inbox/token', { method: 'POST', body: form });
  return POST(request as never, { params: Promise.resolve({ token: 'token-1' }) });
}

describe('public inbox upload validation and storage cleanup', () => {
  it('rejects MIME spoofing before any Storage upload', async () => {
    const spoofed = new File(['%PDF-1.7 sample'], 'receipt.pdf', { type: 'image/png' });
    const response = await postFiles([spoofed]);
    expect(response.status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('removes the uploaded object if metadata persistence fails', async () => {
    const validPdf = new File(['%PDF-1.7 sample'], 'receipt.pdf', { type: 'application/pdf' });
    const response = await postFiles([validPdf]);
    expect(response.status).toBe(500);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith([mocks.upload.mock.calls[0][0]]);
  });
});
