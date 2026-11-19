import { supabaseAdmin } from './supabase-admin';
import { createPackageRun } from './package-runs';

export interface PersistedPipelinePackage {
  id: string;
  realm_id: string;
  status: 'complete' | 'partial';
  zip_path: string;
  filename: string;
  created_at: string;
  package_version?: number;
  previous_package_id?: string | null;
}

export async function persistPipelinePackage(input: {
  realmId: string;
  createdBy: string;
  startDate: string;
  endDate: string;
  filename: string;
  zipBuffer: Buffer;
  status: 'complete' | 'partial';
  stats: Record<string, unknown>;
}): Promise<PersistedPipelinePackage> {
  if (!input.realmId) throw new Error('Realm ID is required to persist a package');
  if (input.zipBuffer.length === 0) throw new Error('Cannot persist an empty package');

  const safeFilename = input.filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  const packageRun = await createPackageRun({
    database: supabaseAdmin,
    realmId: input.realmId,
    createdBy: input.createdBy,
    sourceType: 'qbo_period',
    startDate: input.startDate,
    endDate: input.endDate,
    filename: safeFilename,
    stats: input.stats,
  });
  const zipPath = `packages/${input.realmId}/${packageRun.id}/${safeFilename}`;
  const storage = supabaseAdmin.storage.from('evidence');
  const { error: uploadError } = await storage.upload(zipPath, input.zipBuffer, {
    upsert: false,
    contentType: 'application/zip',
  });
  if (uploadError) {
    await supabaseAdmin.from('generated_evidence_packages').update({
      status: 'failed',
      error_summary: 'Package ZIP upload failed',
    }).eq('id', packageRun.id).eq('realm_id', input.realmId);
    throw new Error('Failed to upload generated package');
  }

  const { data, error: updateError } = await supabaseAdmin
    .from('generated_evidence_packages')
    .update({
      status: input.status,
      zip_path: zipPath,
      stats: input.stats,
      manifest: { schemaVersion: 1, status: input.status, attachmentCount: input.stats.successfulDownloadCount, failedFileCount: input.stats.failedDownloadCount },
      error_summary: input.status === 'partial' ? 'One or more files could not be included' : null,
    })
    .eq('id', packageRun.id)
    .eq('realm_id', input.realmId)
    .select('id, realm_id, status, zip_path, filename, created_at, package_version, previous_package_id')
    .single();
  if (updateError || !data) {
    await supabaseAdmin.from('generated_evidence_packages').update({
      status: 'failed',
      error_summary: 'Package metadata could not be finalized',
    }).eq('id', packageRun.id).eq('realm_id', input.realmId);
    throw new Error('Failed to record generated package');
  }

  return data as PersistedPipelinePackage;
}
