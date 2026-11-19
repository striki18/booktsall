import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAuthContext: vi.fn(), download: vi.fn(), storageFrom: vi.fn(), single: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAuthContext: mocks.requireAuthContext, requireAuth: vi.fn() }));
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { storage: { from: mocks.storageFrom } } }));

import { GET } from '@/app/api/download/route';

const packageId = '123e4567-e89b-42d3-a456-426614174000';
beforeEach(() => {
  vi.clearAllMocks();
  const query = { select: vi.fn(() => query), eq: vi.fn(() => query), single: mocks.single };
  mocks.requireAuthContext.mockResolvedValue({ realmId: 'realm-1', user: { id: 'u1' }, supabase: { from: vi.fn(() => query) } });
  mocks.single.mockResolvedValue({ data: { id: packageId, realm_id: 'realm-1', status: 'complete', zip_path: `packages/realm-1/${packageId}/package.zip`, filename: 'package.zip' }, error: null });
  mocks.storageFrom.mockReturnValue({ download: mocks.download });
  mocks.download.mockResolvedValue({ data: new Blob([Buffer.from('zip-bytes')]), error: null });
});

describe('generated package download authorization', () => {
  it('downloads only the package owned by the authenticated realm', async () => {
    const response = await GET(new Request(`http://localhost/api/download?packageId=${packageId}`) as never);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(bytes.toString()).toBe('zip-bytes');
    expect(mocks.storageFrom).toHaveBeenCalledWith('evidence');
    expect(mocks.download).toHaveBeenCalledWith(`packages/realm-1/${packageId}/package.zip`);
  });
  it('does not download a run that is still generating', async () => {
    mocks.single.mockResolvedValue({ data: { id: packageId, realm_id: 'realm-1', status: 'generating', zip_path: null, filename: 'package.zip' }, error: null });
    const response = await GET(new Request(`http://localhost/api/download?packageId=${packageId}`) as never);
    expect(response.status).toBe(409);
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('returns not found and skips Storage when the realm-scoped row is absent', async () => {
    mocks.single.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const response = await GET(new Request(`http://localhost/api/download?packageId=${packageId}`) as never);
    expect(response.status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated package downloads', async () => {
    mocks.requireAuthContext.mockRejectedValue(new Error('UNAUTHORIZED'));
    const response = await GET(new Request(`http://localhost/api/download?packageId=${packageId}`) as never);
    expect(response.status).toBe(401);
    expect(mocks.download).not.toHaveBeenCalled();
  });
});