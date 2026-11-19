import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  query: {} as Record<string, any>,
  single: vi.fn(),
  createSignedUrl: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => mocks.query),
    storage: { from: vi.fn(() => ({ createSignedUrl: mocks.createSignedUrl })) },
  },
}));

import { GET } from '@/app/api/firm/inbox/documents/[id]/route';

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