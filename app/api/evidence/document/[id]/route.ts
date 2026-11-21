import { NextResponse, NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAuthContext } from '@/lib/auth';
import { requireOwnedEvidenceRequest, ownershipErrorStatus } from '@/lib/resource-access';

/**
 * GET /api/evidence/document/[id]
 *
 * Returns a signed download URL for a specific evidence document.
 *
 * Responses:
 *   200 – JSON with document metadata and signed URL
 *   400 – Invalid UUID supplied
 *   404 – Document not found
 *   500 – Signed URL generation failure
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let authenticatedSupabase: any;
  try { ({ supabase: authenticatedSupabase } = await requireAuthContext()); } catch (error) { const status = ownershipErrorStatus(error); return NextResponse.json({ error: status === 401 ? 'Authentication required' : 'Forbidden' }, { status: status ?? 500 }); }

  // Validate UUID format
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!id || !uuidRegex.test(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  // Fetch document metadata
  const { data: doc, error: docError } = await authenticatedSupabase
    .from('evidence_documents')
    .select('id, evidence_request_id, filename, content_type, file_size, storage_path')
    .eq('id', id)
    .single();

  if (docError || !doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }

  try {
    await requireOwnedEvidenceRequest(doc.evidence_request_id);
  } catch (error) {
    const status = ownershipErrorStatus(error);
    return NextResponse.json({ error: status === 401 ? 'Authentication required' : status === 403 ? 'Forbidden' : 'Ownership check failed' }, { status: status ?? 500 });
  }
  // Generate signed URL (10 minutes = 600 seconds)
  const { data: signedData, error: signedError } = await supabaseAdmin
    .storage
    .from('evidence')
    .createSignedUrl(doc.storage_path, 600);

  if (signedError || !signedData?.signedUrl) {
    return NextResponse.json({ error: signedError?.message ?? 'Failed to generate signed URL' }, { status: 500 });
  }

  return NextResponse.json({
    id: doc.id,
    filename: doc.filename,
    contentType: doc.content_type,
    size: doc.file_size,
    downloadUrl: signedData.signedUrl,
    expiresIn: 600,
  }, { status: 200 });
}

/** Archive a document after explicit human confirmation; retain bytes and history. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let context: Awaited<ReturnType<typeof requireAuthContext>>;
  try { context = await requireAuthContext(); } catch (error) {
    const status = ownershipErrorStatus(error);
    return NextResponse.json({ error: status === 401 ? 'Authentication required' : 'Forbidden' }, { status: status ?? 500 });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  const { data: doc, error } = await context.supabase.from('evidence_documents')
    .select('id, evidence_request_id').eq('id', id).single();
  if (error || !doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  try { await requireOwnedEvidenceRequest(doc.evidence_request_id); } catch (ownershipError) {
    const status = ownershipErrorStatus(ownershipError);
    return NextResponse.json({ error: status === 401 ? 'Authentication required' : status === 403 ? 'Forbidden' : 'Ownership check failed' }, { status: status ?? 500 });
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Explicit confirmation is required to archive evidence' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || (body as Record<string, unknown>).confirmed !== true) {
    return NextResponse.json({ error: 'Explicit confirmation is required to archive evidence' }, { status: 400 });
  }
  const reason = (body as Record<string, unknown>).reason;
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) {
    return NextResponse.json({ error: 'Invalid archive reason' }, { status: 400 });
  }
  const { data: result, error: archiveError } = await supabaseAdmin.rpc('archive_evidence_document', {
    p_realm_id: context.realmId, p_document_id: id, p_actor_user_id: context.user.id,
    p_reason: typeof reason === 'string' ? reason : null,
  });
  if (archiveError) return NextResponse.json({ error: 'Unable to archive evidence safely' }, { status: 503 });
  if (result === 'not_found') return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  if (result !== 'archived' && result !== 'already_archived') {
    return NextResponse.json({ error: 'Unable to archive evidence safely' }, { status: 503 });
  }
  return NextResponse.json({ archived: true, retained: true, auditRecorded: result === 'archived' });
}