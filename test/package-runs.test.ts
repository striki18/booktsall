import { describe, expect, it, vi } from 'vitest';
import { createPackageRun } from '@/lib/package-runs';

describe('shared package run versioning', () => {
  it('versions engagement package runs independently and links the previous version', async () => {
    const inserted: Record<string, unknown>[] = [];
    const filters: Array<[string, unknown]> = [];
    const database = {
      from: vi.fn(() => {
        const query: Record<string, any> = {};
        query.select = vi.fn(() => query);
        query.eq = vi.fn((column: string, value: unknown) => { filters.push([column, value]); return query; });
        query.order = vi.fn(() => query);
        query.limit = vi.fn(() => query);
        query.maybeSingle = vi.fn(async () => ({ data: { id: 'older-run', package_version: 3 }, error: null }));
        query.insert = vi.fn((row: Record<string, unknown>) => { inserted.push(row); return query; });
        query.single = vi.fn(async () => ({ data: { ...inserted[0], id: 'new-run' }, error: null }));
        return query;
      }),
    };

    const run = await createPackageRun({
      database,
      realmId: 'realm-1',
      createdBy: 'user-1',
      sourceType: 'engagement',
      engagementId: 'engagement-1',
      filename: 'EvidencePackage.zip',
      stats: { expectedAttachmentCount: 2 },
    });

    expect(filters).toEqual([['realm_id', 'realm-1'], ['source_type', 'engagement'], ['engagement_id', 'engagement-1']]);
    expect(inserted[0]).toMatchObject({
      source_type: 'engagement', engagement_id: 'engagement-1', status: 'generating',
      package_version: 4, previous_package_id: 'older-run', zip_path: null,
      start_date: null, end_date: null,
    });
    expect(run.id).toBe('new-run');
  });
});
