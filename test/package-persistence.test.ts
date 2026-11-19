import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(), remove: vi.fn(), from: vi.fn(), storageFrom: vi.fn(),
  latestSingle: vi.fn(), insertSingle: vi.fn(), updateSingle: vi.fn(),
  inserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
}));
vi.mock('../lib/supabase-admin', () => ({ supabaseAdmin: {
  from: mocks.from,
  storage: { from: mocks.storageFrom },
} }));

import { persistPipelinePackage } from '../lib/package-persistence';

function queryFor(table: string) {
  const query: Record<string, any> = {};
  let operation = '';
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.maybeSingle = vi.fn(() => mocks.latestSingle());
  query.insert = vi.fn((payload: Record<string, unknown>) => { operation = 'insert'; mocks.inserts.push(payload); return query; });
  query.update = vi.fn((payload: Record<string, unknown>) => { operation = 'update'; mocks.updates.push(payload); return query; });
  query.single = vi.fn(() => operation === 'insert' ? mocks.insertSingle() : mocks.updateSingle());
  query.then = (resolve: (result: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserts.length = 0;
  mocks.updates.length = 0;
  mocks.storageFrom.mockReturnValue({ upload: mocks.upload, remove: mocks.remove });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.remove.mockResolvedValue({ error: null });
  mocks.latestSingle.mockResolvedValue({ data: null, error: null });
  mocks.insertSingle.mockResolvedValue({ data: { id: 'package-id', package_version: 1, previous_package_id: null }, error: null });
  mocks.updateSingle.mockImplementation(async () => ({
    data: { id: 'package-id', realm_id: 'realm-1', status: 'partial', zip_path: mocks.upload.mock.calls[0]?.[0], filename: 'AuditPackage_realm-1.zip', created_at: '2026-11-13T00:00:00Z', package_version: 1, previous_package_id: null },
    error: null,
  }));
  mocks.from.mockImplementation((table: string) => queryFor(table));
});

const validInput = () => ({
  realmId: 'realm-1', createdBy: 'user-1', startDate: '2026-01-01', endDate: '2026-01-31',
  filename: 'AuditPackage_realm-1.zip', zipBuffer: Buffer.from('zip-bytes'), status: 'partial' as const,
  stats: { failedDownloadCount: 1, successfulDownloadCount: 2 },
});

describe('shared package run persistence', () => {
  it('creates a versioned QBO run and uploads an immutable object before finalizing its status', async () => {
    const result = await persistPipelinePackage(validInput());
    const [storagePath, buffer, options] = mocks.upload.mock.calls[0];
    expect(storagePath).toBe('packages/realm-1/package-id/AuditPackage_realm-1.zip');
    expect(buffer).toEqual(Buffer.from('zip-bytes'));
    expect(options.upsert).toBe(false);
    expect(result.status).toBe('partial');
    expect(result.zip_path).toBe(storagePath);
    expect(mocks.inserts[0]).toMatchObject({ source_type: 'qbo_period', status: 'generating', package_version: 1, previous_package_id: null });
    expect(mocks.updates.at(-1)).toMatchObject({ status: 'partial', error_summary: 'One or more files could not be included' });
  });

  it('links reruns to the prior package version without overwriting it', async () => {
    mocks.latestSingle.mockResolvedValue({ data: { id: 'previous-package', package_version: 4 }, error: null });
    await persistPipelinePackage(validInput());

    expect(mocks.inserts[0]).toMatchObject({ package_version: 5, previous_package_id: 'previous-package' });
    expect(mocks.upload.mock.calls[0][0]).not.toContain('previous-package');
    expect(mocks.upload.mock.calls[0][2].upsert).toBe(false);
  });

  it('does not upload ZIP bytes when a package run cannot be recorded', async () => {
    mocks.insertSingle.mockResolvedValue({ data: null, error: { message: 'database error' } });
    await expect(persistPipelinePackage(validInput())).rejects.toThrow('Unable to create package run');
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('does not write an empty ZIP object or package run', async () => {
    await expect(persistPipelinePackage({ ...validInput(), zipBuffer: Buffer.alloc(0) })).rejects.toThrow('Cannot persist an empty package');
    expect(mocks.inserts).toHaveLength(0);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
