import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireOwnedEvidenceRequest: vi.fn(),
  requireOwnedEngagement: vi.fn(),
  requireAuth: vi.fn(),
  requireAuthContext: vi.fn(),
  sessionFrom: vi.fn(),
  supabaseSingle: vi.fn(),
  adminSingle: vi.fn(),
  storageRemove: vi.fn(),
  storageUpload: vi.fn(),
  storageSignedUrl: vi.fn(),
  storageFrom: vi.fn(),
}));

const supabaseQuery: Record<string, any> = {};
const adminQuery: Record<string, any> = {};

vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth, requireAuthContext: mocks.requireAuthContext }));
vi.mock('@/lib/resource-access', () => ({
  requireOwnedEvidenceRequest: mocks.requireOwnedEvidenceRequest,
  requireOwnedEngagement: mocks.requireOwnedEngagement,
  ownershipErrorStatus: (error: Error) => error.message === 'UNAUTHORIZED' ? 401 : error.message === 'FORBIDDEN' ? 403 : null,
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(() => supabaseQuery) } }));
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => adminQuery),
    storage: { from: mocks.storageFrom },
  },
}));

import { GET as getEvidenceDocument, DELETE as deleteEvidenceDocument } from '@/app/api/evidence/document/[id]/route';
import { GET as downloadPackage } from '@/app/api/evidence/package/[id]/download/route';
import { POST as buildPackageZip } from '@/app/api/evidence/package/[id]/zip/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user: { id: 'u1' }, realmId: 'realm-1' });
  mocks.sessionFrom.mockReturnValue(supabaseQuery);
  mocks.requireAuthContext.mockResolvedValue({ supabase: { from: mocks.sessionFrom }, user: { id: 'u1' }, realmId: 'realm-1' });
  Object.assign(supabaseQuery, {
    select: vi.fn(() => supabaseQuery),
    eq: vi.fn(() => supabaseQuery),
    single: mocks.supabaseSingle,
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
  });
  Object.assign(adminQuery, {
    select: vi.fn(() => adminQuery),
    eq: vi.fn(() => adminQuery),
    single: mocks.adminSingle,
  });
  mocks.supabaseSingle.mockResolvedValue({ data: { id: 'doc-1', evidence_request_id: 'request-1', storage_path: 'private/doc.pdf' }, error: null });
  mocks.requireOwnedEvidenceRequest.mockRejectedValue(new Error('FORBIDDEN'));
  mocks.requireOwnedEngagement.mockRejectedValue(new Error('FORBIDDEN'));
  mocks.storageFrom.mockReturnValue({
    remove: mocks.storageRemove,
    upload: mocks.storageUpload,
    createSignedUrl: mocks.storageSignedUrl,
  });
});

describe('private artifact ownership gates', () => {
  it('rejects anonymous callers before looking up private artifacts', async () => {
    mocks.requireAuthContext.mockRejectedValue(new Error('UNAUTHORIZED'));
    const params = { params: Promise.resolve({ id: '123e4567-e89b-42d3-a456-426614174000' }) };
    const documentResponse = await getEvidenceDocument(new Request('http://localhost') as never, params);
    const packageResponse = await downloadPackage(new Request('http://localhost/api/evidence/package/123e4567-e89b-42d3-a456-426614174000/download') as never);

    expect(documentResponse.status).toBe(401);
    expect(packageResponse.status).toBe(401);
    expect(mocks.supabaseSingle).not.toHaveBeenCalled();
    expect(mocks.supabaseSingle).not.toHaveBeenCalled();
  });
  it('blocks cross-company document signing and deletion', async () => {
    const params = { params: Promise.resolve({ id: '123e4567-e89b-42d3-a456-426614174000' }) };
    const getResponse = await getEvidenceDocument(new Request('http://localhost') as never, params);
    const deleteResponse = await deleteEvidenceDocument(new Request('http://localhost') as never, params);

    expect(getResponse.status).toBe(403);
    expect(deleteResponse.status).toBe(403);
    expect(mocks.requireOwnedEvidenceRequest).toHaveBeenCalledWith('request-1');
    expect(mocks.storageSignedUrl).not.toHaveBeenCalled();
    expect(mocks.storageRemove).not.toHaveBeenCalled();
  });

  it('blocks package ZIP upload and download before storage access', async () => {
    mocks.supabaseSingle.mockResolvedValue({ data: { id: 'package-1', engagement_id: 'engagement-1', status: 'ready', zip_path: 'private/package.zip' }, error: null });
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const getResponse = await downloadPackage(new Request(`http://localhost/api/evidence/package/${id}/download`) as never);
    const postResponse = await buildPackageZip(new Request('http://localhost') as never, {
      params: Promise.resolve({ id }),
    });

    expect(getResponse.status).toBe(403);
    expect(postResponse.status).toBe(404);
    expect(mocks.requireOwnedEngagement).toHaveBeenCalledWith('engagement-1');
    expect(mocks.storageSignedUrl).not.toHaveBeenCalled();
    expect(mocks.storageUpload).not.toHaveBeenCalled();
  });
});