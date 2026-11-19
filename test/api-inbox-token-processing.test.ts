import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  upload: vi.fn(),
  processInboxDocument: vi.fn(),
  updateRegisterForDocument: vi.fn(),
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: mocks.from,
    storage: { from: vi.fn(() => ({ upload: mocks.upload })) },
  })),
}));
vi.mock('@/lib/document-extraction', () => ({ processInboxDocument: mocks.processInboxDocument }));
vi.mock('@/lib/qbo-evidence-register', () => ({ updateRegisterForDocument: mocks.updateRegisterForDocument }));

import { POST } from '@/app/api/inbox/[token]/documents/route';

function requestWithFile() {
  return {
    formData: async () => ({ getAll: () => [{ name: 'receipt.pdf', type: 'application/pdf', size: 12 }] }),
  } as never;
}

function makeQuery(table: string) {
  const query: Record<string, any> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.single = vi.fn(async () => table === 'company_inboxes'
    ? { data: { realm_id: 'realm-1' }, error: null }
    : table === 'collection_requests'
      ? { data: { id: 'request-1' }, error: null }
      : { data: { id: 'document-1', filename: 'receipt.pdf', content_type: 'application/pdf', file_size: 12 }, error: null });
  query.insert = vi.fn(() => query);
  query.update = vi.fn((payload: Record<string, unknown>) => {
    mocks.updates.push(payload);
    return query;
  });
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
  return query;
}

describe('public inbox evidence processing status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updates.length = 0;
    mocks.from.mockImplementation((table: string) => makeQuery(table));
    mocks.upload.mockResolvedValue({ error: null });
    mocks.updateRegisterForDocument.mockResolvedValue(undefined);
  });

  it('persists and returns a failed processing state while preserving the uploaded file', async () => {
    mocks.processInboxDocument.mockRejectedValue(new Error('private provider detail'));
    const response = await POST(requestWithFile(), { params: Promise.resolve({ token: 'public-token' }) } as never);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.documents[0]).toMatchObject({
      id: 'document-1',
      processing_status: 'failed',
      processing_error: 'Evidence processing failed; retry required',
    });
    expect(mocks.updates).toContainEqual({ processing_status: 'failed', processing_error: 'Evidence processing failed; retry required' });
    expect(JSON.stringify(body)).not.toContain('private provider detail');
  });

  it('marks successful extraction and register update as processed', async () => {
    mocks.processInboxDocument.mockResolvedValue({ matchResult: {}, extractedFields: {}, isDuplicate: false, duplicateOfDocumentId: null });
    const response = await POST(requestWithFile(), { params: Promise.resolve({ token: 'public-token' }) } as never);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.documents[0].processing_status).toBe('processed');
    expect(mocks.updates).toContainEqual({ processing_status: 'processed', processing_error: null });
    expect(mocks.updateRegisterForDocument).toHaveBeenCalledWith('document-1', 'realm-1', 'request-1', {}, {}, false, null);
  });
});
