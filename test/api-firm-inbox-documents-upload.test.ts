import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  from: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  processInboxDocument: vi.fn(),
  updateRegisterForDocument: vi.fn(),
  recordProcessedEvidence: vi.fn(),
  insertedDocument: null as Record<string, unknown> | null,
}));
vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: mocks.from,
    storage: { from: () => ({ upload: mocks.upload, remove: mocks.remove }) },
  },
}));
vi.mock('@/lib/document-extraction', () => ({ processInboxDocument: mocks.processInboxDocument }));
vi.mock('@/lib/qbo-evidence-register', () => ({ updateRegisterForDocument: mocks.updateRegisterForDocument }));
vi.mock('@/lib/qbo-evidence-ingestion', () => ({ recordProcessedEvidence: mocks.recordProcessedEvidence }));

import { POST } from '@/app/api/firm/inbox/documents/route';

function makeUploadRequest(files: File[]) {
  const form = new FormData();
  files.forEach((file) => form.append('files', file));
  return new Request('http://localhost/api/firm/inbox/documents', { method: 'POST', body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user: { id: 'user-1' }, realmId: 'realm-1' });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.remove.mockResolvedValue({ error: null });
  mocks.insertedDocument = null;
  mocks.recordProcessedEvidence.mockResolvedValue({ evidenceItemId: null, evidenceRole: null, qboAttachmentStatus: null });
});

describe('firm inbox document upload', () => {
  it('requires authentication before reading or storing uploads', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await POST(makeUploadRequest([new File(['%PDF-1.4'], 'receipt.pdf', { type: 'application/pdf' })]));
    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('rejects unsupported files before database or Storage access', async () => {
    const response = await POST(makeUploadRequest([new File(['data'], 'receipt.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })]));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Unsupported');
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('rejects a batch over the configured file limit before database access', async () => {
    const files = Array.from({ length: 11 }, (_, index) => new File(['%PDF-1.4'], `receipt-${index}.pdf`, { type: 'application/pdf' }));
    const response = await POST(makeUploadRequest(files));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('maximum is 10');
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('stores the file under the authenticated company and persists metadata', async () => {
    const storedDocument = {
      realm_id: 'realm-1', filename: 'receipt.pdf', content_type: 'application/pdf',
      file_size: 8, uploaded_at: '2026-11-14T00:00:00.000Z', processing_status: 'pending', processing_error: null,
    };
    mocks.processInboxDocument.mockResolvedValue({
      matchResult: { status: 'unmatched' }, extractedFields: {}, isDuplicate: false, duplicateOfDocumentId: null,
    });
    mocks.from.mockImplementation((table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order', 'limit', 'update']) query[method] = vi.fn(() => query);
      query.insert = vi.fn((payload: Record<string, unknown>) => { mocks.insertedDocument = payload; return query; });
      query.maybeSingle = vi.fn(async () => ({ data: { id: 'request-1' }, error: null }));
      query.single = vi.fn(async () => ({ data: { ...storedDocument, id: mocks.insertedDocument?.id }, error: null }));
      query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve, reject);
      return query;
    });

    const response = await POST(makeUploadRequest([new File(['%PDF-1.4'], 'receipt.pdf', { type: 'application/pdf' })]));
    expect(response.status).toBe(201);
    expect(mocks.upload).toHaveBeenCalledWith(expect.stringMatching(/^inbox\/realm-1\/.+\/receipt\.pdf$/), expect.any(File), expect.objectContaining({ contentType: 'application/pdf', upsert: false }));
    expect(mocks.from).toHaveBeenCalledWith('inbox_documents');
    const insertedId = mocks.insertedDocument?.id;
    expect(insertedId).toEqual(expect.any(String));
    expect(mocks.processInboxDocument).toHaveBeenCalledWith(insertedId, 'request-1');
    expect(mocks.updateRegisterForDocument).toHaveBeenCalledWith(insertedId, 'realm-1', 'request-1', { status: 'unmatched' }, {}, false, null);
    expect(mocks.recordProcessedEvidence).toHaveBeenCalledWith({
      realmId: 'realm-1', documentId: insertedId, result: expect.objectContaining({ matchResult: { status: 'unmatched' } }), actorUserId: 'user-1',
    });
    expect((await response.json()).documents[0].processing_status).toBe('processed');
  });
});

describe('firm upload ambiguous metadata outcomes', () => {
  function prepare(recover: boolean) {
    mocks.from.mockImplementation((table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order', 'limit', 'update']) query[method] = vi.fn(() => query);
      query.insert = vi.fn((row: Record<string, unknown>) => { mocks.insertedDocument = row; return query; });
      query.single = vi.fn(async () => ({ data: null, error: { message: 'PRIVATE_INSERT_ERROR' } }));
      query.maybeSingle = vi.fn(async () => table === 'collection_requests'
        ? { data: null, error: null }
        : { data: recover ? { ...mocks.insertedDocument } : null, error: recover ? null : { message: 'PRIVATE_LOOKUP_ERROR' } });
      return query;
    });
  }

  it('reconciles a successful insert whose response was lost without deleting evidence', async () => {
    prepare(true);
    const response = await POST(makeUploadRequest([new File(['%PDF-1.4'], 'receipt.pdf', { type: 'application/pdf' })]));
    expect(response.status).toBe(201);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect((await response.json()).documents[0].id).toBe(mocks.insertedDocument?.id);
  });

  it('retains the file and returns a safe reference when persistence is uncertain', async () => {
    prepare(false);
    const response = await POST(makeUploadRequest([new File(['%PDF-1.4'], 'receipt.pdf', { type: 'application/pdf' })]));
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body).toMatchObject({ retained: true, documentId: mocks.insertedDocument?.id });
    expect(JSON.stringify(body)).not.toContain('PRIVATE_');
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});