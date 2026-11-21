import { NextResponse, NextRequest } from 'next/server';
import { createPackageRun } from '@/lib/package-runs';
import { requireOwnedEngagement, ownershipErrorStatus } from '@/lib/resource-access';

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Create an immutable canonical package run and a legacy evidence-item snapshot. */
export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const engagementId = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).engagementId
    : null;
  if (typeof engagementId !== 'string' || !engagementId) {
    return NextResponse.json({ error: 'engagementId is required' }, { status: 400 });
  }
  if (!UUID_PATTERN.test(engagementId)) return NextResponse.json({ error: 'Invalid engagementId' }, { status: 400 });

  let context: Awaited<ReturnType<typeof requireOwnedEngagement>>;
  try {
    context = await requireOwnedEngagement(engagementId);
  } catch (error) {
    const status = ownershipErrorStatus(error);
    return NextResponse.json({ error: status === 401 ? 'Authentication required' : status === 403 ? 'Forbidden' : 'Ownership check failed' }, { status: status ?? 500 });
  }

  const { data: engagement, error: engagementError } = await context.supabase
    .from('audit_engagements')
    .select('id')
    .eq('id', engagementId)
    .eq('realm_id', context.realmId)
    .single();
  if (engagementError || !engagement) return NextResponse.json({ error: 'Engagement not found' }, { status: 404 });

  const { data: requests, error: requestError } = await context.supabase
    .from('evidence_requests')
    .select('id, plan_id, audit_evidence_plan ( catalog_id, audit_evidence_catalog ( evidence_name ) )')
    .eq('engagement_id', engagementId);
  if (requestError) return NextResponse.json({ error: 'Database error' }, { status: 500 });

  const requestMap: Record<string, string> = {};
  (requests ?? []).forEach((row: any) => {
    requestMap[row.id] = row.audit_evidence_plan?.audit_evidence_catalog?.evidence_name || `Request-${row.id}`;
  });

  const requestIds = Object.keys(requestMap);
  let documents: any[] = [];
  if (requestIds.length > 0) {
    const { data, error } = await context.supabase
      .from('evidence_documents')
      .select('id, evidence_request_id, filename, storage_path')
      .in('evidence_request_id', requestIds)
      .is('archived_at', null);
    if (error) return NextResponse.json({ error: 'Database error' }, { status: 500 });
    documents = data ?? [];
  }

  const filename = `EvidencePackage_${engagementId}.zip`;
  let packageRun: any;
  try {
    packageRun = await createPackageRun({
      database: context.supabase,
      realmId: context.realmId,
      createdBy: context.user.id,
      sourceType: 'engagement',
      engagementId,
      filename,
      stats: { expectedAttachmentCount: documents.length },
    });
  } catch {
    return NextResponse.json({ error: 'Unable to create package history record' }, { status: 500 });
  }

  const { data: legacyPackage, error: packageError } = await context.supabase
    .from('evidence_packages')
    .insert({ id: packageRun.id, generated_package_id: packageRun.id, engagement_id: engagementId, status: 'generated' })
    .select('id')
    .single();
  if (packageError || !legacyPackage) {
    await context.supabase.from('generated_evidence_packages').update({ status: 'failed', error_summary: 'Engagement package snapshot could not be created' }).eq('id', packageRun.id).eq('realm_id', context.realmId);
    return NextResponse.json({ error: 'Unable to create engagement package snapshot' }, { status: 500 });
  }

  const packageItems = documents.map((document) => ({
    package_id: packageRun.id,
    document_id: document.id,
    folder_name: requestMap[document.evidence_request_id] ?? 'Evidence',
    filename: document.filename,
    storage_path: document.storage_path,
  }));
  if (packageItems.length > 0) {
    const { error } = await context.supabase.from('evidence_package_items').insert(packageItems);
    if (error) {
      await context.supabase.from('generated_evidence_packages').update({ status: 'failed', error_summary: 'Package evidence snapshot could not be created' }).eq('id', packageRun.id).eq('realm_id', context.realmId);
      await context.supabase.from('evidence_packages').update({ status: 'failed' }).eq('id', packageRun.id);
      return NextResponse.json({ error: 'Unable to create package evidence snapshot' }, { status: 500 });
    }
  }

  return NextResponse.json({
    packageId: packageRun.id,
    engagementId,
    status: 'generating',
    documentCount: packageItems.length,
    packageVersion: packageRun.package_version,
    previousPackageId: packageRun.previous_package_id,
    zipEndpoint: `/api/evidence/package/${packageRun.id}/zip`,
  }, { status: 201 });
}