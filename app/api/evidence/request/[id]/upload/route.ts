import { NextResponse, NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireOwnedEvidenceRequest, ownershipErrorStatus } from '@/lib/resource-access';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateEvidenceFile } from '@/lib/upload-validation';

/**
 * POST /api/evidence/request/[id]/upload
 *
 * Accepts a multipart/form-data request with a single field `file`.
 * Validates the presence and non‑emptiness of the file, looks up the
 * evidence request by the route param `id`, and returns the uploaded
 * file's metadata.
 *
 * Responses:
 *   200 – `{ filename, contentType, size }`
 *   400 – missing file or empty file
 *   404 – evidence request not found
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Resolve route params (Next.js provides a Promise)
    const { id } = await params;

    // Validate id presence and format (UUID)
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!uuidRegex.test(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const { supabase, user } = await requireOwnedEvidenceRequest(id);

    // Parse multipart/form-data
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch (e) {
      // If parsing form data fails (e.g., no multipart body), treat as missing file
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }

    const file = formData.get('file');
    // The `file` should be a File object
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }
    const validation = await validateEvidenceFile(file);
    if (!validation.valid) return NextResponse.json({ error: validation.error }, { status: 400 });

    // Verify evidence request exists
    // Verify evidence request exists and retrieve engagement_id
    const { data, error } = await supabase
      .from('evidence_requests')
      .select('id, engagement_id')
      .eq('id', id)
      .single();
    if (error || !data) {
      // If supabase returns a not‑found error, treat as 404
      return NextResponse.json({ error: 'Evidence request not found' }, { status: 404 });
    }

    // At this point, we have the evidence request and its engagement_id


    // Upload file to Supabase Storage bucket "evidence"
    const safeFilename = file.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    const documentId = randomUUID();
    const storagePath = `${data.engagement_id}/${data.id}/${documentId}_${safeFilename}`;
    const { error: uploadError } = await supabaseAdmin
      .storage
      .from('evidence')
      .upload(storagePath, file, { upsert: false, contentType: validation.contentType });

    if (uploadError) {
      // Return the Supabase error message directly
      return NextResponse.json({ error: 'Unable to store evidence document' }, { status: 500 });
    }
    // Persist metadata in the database
    const { data: insertData, error: insertError } = await supabaseAdmin
      .from('evidence_documents')
      .insert({
        id: documentId, uploaded_by: user.id,
        evidence_request_id: data.id,
        storage_path: storagePath,
        filename: file.name,
        content_type: validation.contentType,
        file_size: file.size,
      })
      .select();

    let record = insertData?.[0];
    if (insertError || !record) {
      // A lost response does not prove the insert failed. Keep bytes and reconcile by stable ID.
      const { data: recovered, error: recoveryError } = await supabaseAdmin.from('evidence_documents')
        .select('id, evidence_request_id, storage_path, uploaded_at').eq('id', documentId).maybeSingle();
      if (recoveryError || !recovered || recovered.evidence_request_id !== data.id || recovered.storage_path !== storagePath) {
        return NextResponse.json({ error: 'Evidence was stored but its database record could not be confirmed', documentId, retained: true }, { status: 503 });
      }
      record = recovered;
    }
    return NextResponse.json({
      id: record?.id,
      bucket: 'evidence',
      path: storagePath,
      filename: file.name,
      contentType: validation.contentType,
      size: file.size,
      uploadedAt: record?.uploaded_at,
    });
    } catch (e: any) {
      const status = ownershipErrorStatus(e);
      return NextResponse.json({ error: status === 401 ? 'Authentication required' : status === 403 ? 'Forbidden' : status ? 'Ownership check failed' : 'Upload failed' }, { status: status ?? 500 });
    }
}
