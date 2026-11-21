import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  query: {} as Record<string, any>,
  single: vi.fn(),
  createSignedUrl: vi.fn(),
  rpc: vi.fn(),
  storageRemove: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => mocks.query),
    rpc: mocks.rpc,
    storage: { from: vi.fn(() => ({ createSignedUrl: mocks.createSignedUrl, remove: mocks.storageRemove })) },
  },
}));

import { DELETE, GET } from '@/app/api/firm/inbox/documents/[id]/route';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.query, {
    select: vi.fn(() => mocks.query),
    eq: vi.fn(() => mocks.query),
    single: mocks.single,
  });
});

describe('firm inbox document download', () => {
  it('denies anonymous access before querying documents', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await GET(new Request('http://localhost'), { params: Promise.resolve({ id: 'doc-1' }) });
    expect(response.status).toBe(401);
    expect(mocks.single).not.toHaveBeenCalled();
  });

  it('scopes document lookup to the authenticated realm', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { id: 'u1' }, realmId: 'realm-1' });
    mocks.single.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const response = await GET(new Request('http://localhost'), { params: Promise.resolve({ id: 'doc-2' }) });
    expect(response.status).toBe(404);
    expect(mocks.query.eq).toHaveBeenCalledWith('realm_id', 'realm-1');
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('signs a URL only for a document in the authenticated realm', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { id: 'u1' }, realmId: 'realm-1' });
    mocks.single.mockResolvedValue({ data: { id: 'doc-1', realm_id: 'realm-1', storage_path: 'inbox/realm-1/file.pdf' }, error: null });
    mocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://storage.invalid/signed' }, error: null });
    const response = await GET(new Request('http://localhost'), { params: Promise.resolve({ id: 'doc-1' }) });
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://storage.invalid/signed');
    expect(mocks.createSignedUrl).toHaveBeenCalledWith('inbox/realm-1/file.pdf', 600);
  });
});

describe('firm inbox document archive', () => {
  const documentId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    mocks.requireAuth.mockResolvedValue({ user: { id: 'user-1' }, realmId: 'realm-1' });
  });

  it('requires explicit confirmation before calling the archive function', async () => {
    const response = await DELETE(new Request('http://localhost', { method: 'DELETE', body: JSON.stringify({}) }), { params: Promise.resolve({ id: documentId }) });
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('archives within the authenticated realm and retains the evidence file', async () => {
    mocks.rpc.mockResolvedValue({ data: 'archived', error: null });
    const response = await DELETE(new Request('http://localhost', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed: true, reason: 'Duplicate upload' }),
    }), { params: Promise.resolve({ id: documentId }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ archived: true, retained: true, auditRecorded: true });
    expect(mocks.rpc).toHaveBeenCalledWith('archive_inbox_document', {
      p_realm_id: 'realm-1', p_document_id: documentId, p_actor_user_id: 'user-1', p_reason: 'Duplicate upload',
    });
    expect(mocks.storageRemove).not.toHaveBeenCalled();
  });

  it('does not expose a company document outside the authorized realm', async () => {
    mocks.rpc.mockResolvedValue({ data: 'not_found', error: null });
    const response = await DELETE(new Request('http://localhost', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
    }), { params: Promise.resolve({ id: documentId }) });
    expect(response.status).toBe(404);
    expect(mocks.rpc).toHaveBeenCalledWith('archive_inbox_document', expect.objectContaining({ p_realm_id: 'realm-1' }));
  });
});
