import { NextResponse, NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAuthContext } from '@/lib/auth';
import { ownershipErrorStatus } from '@/lib/resource-access';
import { buildEvidencePackageZip, readEvidencePackageZipManifest, verifyEvidencePackageZip, type EvidencePackageFailure, type EvidencePackageFile } from '@/lib/evidence-package-zip';

function statusFailure(error: unknown) {
  const status = ownershipErrorStatus(error);
  return status ? NextResponse.json({ error: status === 401 ? 'Authentication required' : status === 403 ? 'Forbidden' : 'Ownership check failed' }, { status }) : null;
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!uuidPattern.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let context: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    context = await requireAuthContext();
  } catch (error) {
    return statusFailure(error) ?? NextResponse.json({ error: 'Unable to authenticate' }, { status: 500 });
  }

  const { data: legacyPackage, error: legacyError } = await context.supabase
    .from('evidence_packages')
    .select('id, engagement_id, generated_package_id')
    .eq('id', id)
    .single();
  if (legacyError || !legacyPackage) return NextResponse.json({ error: 'Package not found' }, { status: 404 });

  const { data: engagement, error: engagementError } = await context.supabase
    .from('audit_engagements')
    .select('id')
    .eq('id', legacyPackage.engagement_id)
    .eq('realm_id', context.realmId)
    .maybeSingle();
  if (engagementError) return NextResponse.json({ error: 'Unable to verify package ownership' }, { status: 500 });
  if (!engagement) return NextResponse.json({ error: 'Package not found' }, { status: 404 });

  if (!legacyPackage.generated_package_id) {
    return NextResponse.json({ error: 'This historical package has no shared package run; create a new version to regenerate it' }, { status: 409 });
  }

  const { data: packageRun, error: runError } = await context.supabase
    .from('generated_evidence_packages')
    .select('id, status, filename, package_version, previous_package_id')
    .eq('id', legacyPackage.generated_package_id)
    .eq('realm_id', context.realmId)
    .eq('source_type', 'engagement')
    .eq('engagement_id', legacyPackage.engagement_id)
    .maybeSingle();
  if (runError) return NextResponse.json({ error: 'Unable to load package run' }, { status: 500 });
  if (!packageRun) return NextResponse.json({ error: 'Package run not found' }, { status: 404 });
  if (packageRun.status !== 'generating') return NextResponse.json({ error: 'Package run is already finalized' }, { status: 409 });

  const { data: items, error: itemsError } = await context.supabase
    .from('evidence_package_items')
    .select('document_id, folder_name, filename, storage_path')
    .eq('package_id', id);
  if (itemsError) {
    await context.supabase.from('generated_evidence_packages').update({ status: 'failed', error_summary: 'Package evidence could not be loaded' }).eq('id', packageRun.id).eq('realm_id', context.realmId);
    return NextResponse.json({ error: 'Unable to read package contents' }, { status: 500 });
  }

  const files: EvidencePackageFile[] = [];
  const failedFiles: EvidencePackageFailure[] = [];
  for (const item of items ?? []) {
    const { data, error } = await supabaseAdmin.storage.from('evidence').download(item.storage_path);
    if (error || !data) {
      failedFiles.push({ documentId: item.document_id, fileName: item.filename, reason: 'Supporting document could not be retrieved' });
      continue;
    }
    files.push({
      documentId: item.document_id,
      folderName: item.folder_name,
      fileName: item.filename,
      buffer: Buffer.from(await data.arrayBuffer()),
    });
  }

  let zipBuffer: Buffer;
  let verifiedManifest: Record<string, unknown>;
  try {
    zipBuffer = await buildEvidencePackageZip(packageRun.id, files, failedFiles);
    const verification = await verifyEvidencePackageZip(zipBuffer);
    if (!verification.valid) throw new Error(verification.errors.join('; '));
    verifiedManifest = await readEvidencePackageZipManifest(zipBuffer);
  } catch {
    await context.supabase.from('generated_evidence_packages').update({ status: 'failed', error_summary: 'ZIP assembly or verification failed' }).eq('id', packageRun.id).eq('realm_id', context.realmId);
    return NextResponse.json({ error: 'Unable to assemble or verify evidence package' }, { status: 500 });
  }

  const zipPath = `packages/${context.realmId}/${packageRun.id}/${packageRun.filename}`;
  const { error: uploadError } = await supabaseAdmin.storage.from('evidence').upload(zipPath, zipBuffer, {
    upsert: false,
    contentType: 'application/zip',
  });
  if (uploadError) {
    await context.supabase.from('generated_evidence_packages').update({ status: 'failed', error_summary: 'Verified ZIP could not be stored' }).eq('id', packageRun.id).eq('realm_id', context.realmId);
    return NextResponse.json({ error: 'Unable to save evidence package' }, { status: 500 });
  }

  const status = failedFiles.length > 0 ? 'partial' : 'complete';
  const stats = { expectedAttachmentCount: files.length + failedFiles.length, includedFileCount: files.length, failedFileCount: failedFiles.length };
  const { error: finalizeError } = await context.supabase
    .from('generated_evidence_packages')
    .update({ status, zip_path: zipPath, stats, manifest: verifiedManifest, error_summary: failedFiles.length > 0 ? 'One or more supporting documents could not be retrieved' : null })
    .eq('id', packageRun.id)
    .eq('realm_id', context.realmId);
  if (finalizeError) return NextResponse.json({ error: 'ZIP stored but package history could not be finalized' }, { status: 500 });

  const { error: legacyFinalizeError } = await context.supabase
    .from('evidence_packages')
    .update({ status: failedFiles.length > 0 ? 'partial' : 'ready', zip_path: zipPath })
    .eq('id', id);
  if (legacyFinalizeError) return NextResponse.json({ error: 'Package stored but compatibility history could not be finalized' }, { status: 500 });

  return NextResponse.json({
    packageId: packageRun.id,
    status,
    zip_path: zipPath,
    documentCount: files.length,
    failedDocumentCount: failedFiles.length,
    packageVersion: packageRun.package_version,
    previousPackageId: packageRun.previous_package_id,
  }, { status: 200 });
}