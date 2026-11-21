import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  upload: vi.fn(),
  processInboxDocument: vi.fn(),
  updateRegisterForDocument: vi.fn(),
  recordProcessedEvidence: vi.fn(),
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
vi.mock('@/lib/qbo-evidence-ingestion', () => ({ recordProcessedEvidence: mocks.recordProcessedEvidence }));

import { POST } from '@/app/api/inbox/[token]/documents/route';

function pdfFile() {
  return new File(['%PDF-1.4 sample invoice'], 'receipt.pdf', { type: 'application/pdf' });
}

function requestWithFiles(files: FormDataEntryValue[] = [pdfFile()]) {
  return {
    formData: async () => ({ getAll: () => files }),
  } as never;
}

function makeQuery(table: string) {
  type MockQuery = {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    single: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    then: (resolve: (value: unknown) => unknown) => Promise<unknown>;
  };
  const query = {} as MockQuery;
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
    mocks.recordProcessedEvidence.mockResolvedValue({ evidenceItemId: 'item-1', evidenceRole: 'primary', qboAttachmentStatus: 'verified' });
  });

  it('keeps provider details out of upload errors and operational logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mocks.upload.mockResolvedValue({ error: { message: 'PRIVATE_PROVIDER_SECRET', detail: 'PRIVATE_CUSTOMER_DATA' } });
      const response = await POST(requestWithFiles(), { params: Promise.resolve({ token: 'public-token' }) } as never);
      const body = await response.json();
      expect(response.status).toBe(500);
      expect(JSON.stringify(body)).not.toContain('PRIVATE_');
      expect(log).toHaveBeenCalledWith('Inbox Storage upload failed');
      expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_');
      expect(mocks.processInboxDocument).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('rejects unsupported file bytes before uploading or saving metadata', async () => {
    const invalidFile = new File(['not a document'], 'receipt.pdf', { type: 'application/pdf' });
    const response = await POST(requestWithFiles([invalidFile]), { params: Promise.resolve({ token: 'public-token' }) } as never);

    expect(response.status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.from('inbox_documents').insert).not.toHaveBeenCalled();
  });

  it('rejects batches above the shared upload file limit before storing any files', async () => {
    const response = await POST(requestWithFiles(Array.from({ length: 11 }, () => pdfFile())), { params: Promise.resolve({ token: 'public-token' }) } as never);

    expect(response.status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.from('inbox_documents').insert).not.toHaveBeenCalled();
  });

  it('persists and returns a failed processing state while preserving the uploaded file', async () => {
    mocks.processInboxDocument.mockRejectedValue(new Error('private provider detail'));
    const response = await POST(requestWithFiles(), { params: Promise.resolve({ token: 'public-token' }) } as never);
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
    const response = await POST(requestWithFiles(), { params: Promise.resolve({ token: 'public-token' }) } as never);
    const body = await response.json();

    expect(response.status).toBe(201);
    const storagePath = mocks.upload.mock.calls[0][0] as string;
    expect(storagePath).toMatch(/^inbox\/realm-1\/[0-9a-f-]{36}\/document\.pdf$/);
    expect(storagePath).not.toContain('public-token');
    expect(body.documents[0].processing_status).toBe('processed');
    expect(mocks.updates).toContainEqual({ processing_status: 'processed', processing_error: null });
    expect(mocks.updateRegisterForDocument).toHaveBeenCalledWith('document-1', 'realm-1', 'request-1', {}, {}, false, null);
    expect(mocks.recordProcessedEvidence).toHaveBeenCalledWith({ realmId: 'realm-1', documentId: 'document-1', result: expect.any(Object), actorUserId: null });
    expect(body.documents[0].evidence).toMatchObject({ evidenceItemId: 'item-1', qboAttachmentStatus: 'verified' });
  });
});
