import AdmZip from 'adm-zip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuthContext: vi.fn(),
  storageDownload: vi.fn(),
  storageUpload: vi.fn(),
  storageFrom: vi.fn(),
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
}));

vi.mock('@/lib/auth', () => ({ requireAuthContext: mocks.requireAuthContext }));
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { storage: { from: mocks.storageFrom } } }));

import { POST } from '@/app/api/evidence/package/[id]/zip/route';

const packageId = '123e4567-e89b-42d3-a456-426614174000';
const engagementId = '223e4567-e89b-42d3-a456-426614174000';
const documentId = '323e4567-e89b-42d3-a456-426614174000';
const item = { document_id: documentId, folder_name: 'Invoices', filename: 'invoice.pdf', storage_path: `${engagementId}/request-1/invoice.pdf` };

function queryFor(table: string) {
  const query: Record<string, any> = {};
  let updatePayload: Record<string, unknown> | null = null;
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => table === 'audit_engagements'
    ? { data: { id: engagementId }, error: null }
    : { data: { id: packageId, status: 'generating', filename: 'EvidencePackage.zip', package_version: 1, previous_package_id: null }, error: null });
  query.single = vi.fn(async () => ({ data: { id: packageId, engagement_id: engagementId, generated_package_id: packageId }, error: null }));
  query.update = vi.fn((payload: Record<string, unknown>) => { updatePayload = payload; mocks.updates.push({ table, payload }); return query; });
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === 'evidence_package_items' ? [item] : null, error: null }).then(resolve);
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updates.length = 0;
  mocks.requireAuthContext.mockResolvedValue({
    supabase: { from: queryFor },
    user: { id: 'user-1' },
    realmId: 'realm-1',
  });
  mocks.storageFrom.mockReturnValue({ download: mocks.storageDownload, upload: mocks.storageUpload });
  mocks.storageDownload.mockResolvedValue({ data: new Blob([Buffer.from('%PDF-evidence')]), error: null });
  mocks.storageUpload.mockResolvedValue({ data: { path: `packages/realm-1/${packageId}/EvidencePackage.zip` }, error: null });
});

function makeRequest() {
  return POST(new Request('http://localhost') as never, { params: Promise.resolve({ id: packageId }) });
}

describe('shared evidence package ZIP lifecycle', () => {
  it('downloads bytes, verifies the ZIP manifest, stores immutably, and finalizes shared and compatibility histories', async () => {
    const response = await makeRequest();
    const body = await response.json();
    const [zipPath, zipBuffer, options] = mocks.storageUpload.mock.calls[0];
    const zip = new AdmZip(zipBuffer);
    const manifest = JSON.parse(zip.readAsText('evidence_package_manifest.json'));

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'complete', documentCount: 1, failedDocumentCount: 0, packageVersion: 1 });
    expect(mocks.storageDownload).toHaveBeenCalledWith(item.storage_path);
    expect(zip.readAsText('attachments/Invoices/invoice.pdf')).toBe('%PDF-evidence');
    expect(manifest.files[0].documentId).toBe(documentId);
    expect(manifest.files[0].sha256).toBeTruthy();
    expect(zipPath).toBe(`packages/realm-1/${packageId}/EvidencePackage.zip`);
    expect(options).toMatchObject({ upsert: false, contentType: 'application/zip' });
    expect(mocks.updates).toContainEqual({ table: 'generated_evidence_packages', payload: expect.objectContaining({ status: 'complete', zip_path: zipPath }) });
    expect(mocks.updates).toContainEqual({ table: 'evidence_packages', payload: expect.objectContaining({ status: 'ready', zip_path: zipPath }) });
  });

  it('creates a partial ZIP with a per-file failure record and keeps the package downloadable', async () => {
    mocks.storageDownload.mockResolvedValue({ data: null, error: { message: 'private storage detail' } });
    const response = await makeRequest();
    const body = await response.json();
    const zip = new AdmZip(mocks.storageUpload.mock.calls[0][1]);
    const manifest = JSON.parse(zip.readAsText('evidence_package_manifest.json'));

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'partial', documentCount: 0, failedDocumentCount: 1 });
    expect(manifest).toMatchObject({ status: 'partial', files: [], failedFiles: [{ documentId, fileName: 'invoice.pdf' }] });
    expect(JSON.stringify(manifest)).not.toContain('private storage detail');
  });
});
