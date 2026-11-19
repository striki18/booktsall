import { randomUUID } from 'node:crypto';

export type PackageSourceType = 'qbo_period' | 'engagement';

export interface CreatePackageRunInput {
  database: any;
  realmId: string;
  createdBy: string | null;
  sourceType: PackageSourceType;
  filename: string;
  stats?: Record<string, unknown>;
  startDate?: string | null;
  endDate?: string | null;
  engagementId?: string | null;
}

export async function createPackageRun(input: CreatePackageRunInput) {
  const { database, realmId, sourceType, startDate = null, endDate = null, engagementId = null } = input;
  if (!realmId) throw new Error('Realm ID is required to create a package run');
  if (sourceType === 'qbo_period' && (!startDate || !endDate)) throw new Error('Date range is required for a QBO package run');
  if (sourceType === 'engagement' && !engagementId) throw new Error('Engagement ID is required for an engagement package run');

  let latestQuery = database.from('generated_evidence_packages')
    .select('id, package_version')
    .eq('realm_id', realmId)
    .eq('source_type', sourceType);
  if (sourceType === 'engagement') {
    latestQuery = latestQuery.eq('engagement_id', engagementId);
  } else {
    latestQuery = latestQuery.eq('start_date', startDate).eq('end_date', endDate);
  }
  const { data: previous, error: previousError } = await latestQuery
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previousError) throw new Error('Unable to determine package version');

  const id = randomUUID();
  const packageVersion = Number(previous?.package_version ?? 0) + 1;
  const { data, error } = await database.from('generated_evidence_packages').insert({
    id,
    realm_id: realmId,
    created_by: input.createdBy,
    source_type: sourceType,
    engagement_id: engagementId,
    start_date: startDate,
    end_date: endDate,
    status: 'generating',
    zip_path: null,
    filename: input.filename,
    stats: input.stats ?? {},
    manifest: { schemaVersion: 1, status: 'generating', files: [], failedFiles: [] },
    package_version: packageVersion,
    previous_package_id: previous?.id ?? null,
  }).select('id, realm_id, source_type, engagement_id, start_date, end_date, status, zip_path, filename, stats, manifest, package_version, previous_package_id, created_at').single();
  if (error || !data) throw new Error('Unable to create package run');
  return data;
}
