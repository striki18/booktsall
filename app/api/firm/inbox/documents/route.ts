import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { MAX_EVIDENCE_UPLOAD_FILES, safeEvidenceStorageFilename, validateEvidenceFile } from '@/lib/upload-validation';
import { processInboxDocument } from '@/lib/document-extraction';
import { updateRegisterForDocument } from '@/lib/qbo-evidence-register';

export async function POST(request: Request) {
  let realmId: string;
  try {
    ({ realmId } = await requireAuth());
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return NextResponse.json({ error: code === 'UNAUTHORIZED' ? 'Authentication required' : 'No authorized QuickBooks company is connected' }, { status: code === 'UNAUTHORIZED' ? 401 : 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid upload form' }, { status: 400 });
  }
  const files = formData.getAll('files');
  if (files.length === 0) return NextResponse.json({ error: 'No files provided' }, { status: 400 });
  if (files.length > MAX_EVIDENCE_UPLOAD_FILES) return NextResponse.json({ error: 'Too many files; maximum is 10' }, { status: 400 });
  if (files.some((file) => !(file instanceof File))) return NextResponse.json({ error: 'Only file uploads are allowed' }, { status: 400 });

  const fileList = files as File[];
  const validations = await Promise.all(fileList.map(validateEvidenceFile));
  const invalidIndex = validations.findIndex((result) => !result.valid);
  if (invalidIndex >= 0) {
    const validation = validations[invalidIndex];
    if (!validation.valid) return NextResponse.json({ error: `File ${invalidIndex + 1}: ${validation.error}` }, { status: 400 });
  }

  const { data: requestRow, error: requestError } = await supabaseAdmin
    .from('collection_requests')
    .select('id')
    .eq('realm_id', realmId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (requestError) return NextResponse.json({ error: 'Unable to load the company evidence request' }, { status: 500 });

  const documents: Array<Record<string, unknown>> = [];
  for (let index = 0; index < fileList.length; index++) {
    const file = fileList[index];
    const validation = validations[index];
    if (!validation.valid) continue;
    const id = randomUUID();
    const storagePath = `inbox/${realmId}/${id}/${safeEvidenceStorageFilename(file.name)}`;
    const { error: uploadError } = await supabaseAdmin.storage.from('evidence').upload(storagePath, file, {
      contentType: validation.contentType,
      upsert: false,
    });
    if (uploadError) {
      return NextResponse.json({ error: 'Unable to upload one or more evidence files' }, { status: 500 });
    }

    const { data: document, error: insertError } = await supabaseAdmin.from('inbox_documents').insert({
      id,
      realm_id: realmId,
      storage_path: storagePath,
      filename: file.name,
      content_type: validation.contentType,
      file_size: file.size,
    }).select('id, realm_id, filename, content_type, file_size, uploaded_at, processing_status, processing_error').single();
    if (insertError || !document) {
      await supabaseAdmin.storage.from('evidence').remove([storagePath]);
      return NextResponse.json({ error: 'Unable to save uploaded evidence metadata' }, { status: 500 });
    }

    let processingStatus: 'pending' | 'processed' | 'failed' = 'pending';
    let processingError: string | null = null;
    if (requestRow?.id) {
      try {
        const { error: startError } = await supabaseAdmin.from('inbox_documents')
          .update({ processing_status: 'processing', processing_error: null }).eq('id', id).eq('realm_id', realmId);
        if (startError) throw startError;
        const processed = await processInboxDocument(id, requestRow.id);
        await updateRegisterForDocument(id, realmId, requestRow.id, processed.matchResult, processed.extractedFields, processed.isDuplicate, processed.duplicateOfDocumentId);
        const { error: finishError } = await supabaseAdmin.from('inbox_documents')
          .update({ processing_status: 'processed', processing_error: null }).eq('id', id).eq('realm_id', realmId);
        if (finishError) throw finishError;
        processingStatus = 'processed';
      } catch {
        processingStatus = 'failed';
        processingError = 'Evidence processing failed; retry required';
        await supabaseAdmin.from('inbox_documents').update({ processing_status: 'failed', processing_error: processingError }).eq('id', id).eq('realm_id', realmId);
      }
    }
    documents.push({ ...document, processing_status: processingStatus, processing_error: processingError });
  }

  return NextResponse.json({ uploaded: documents.length, documents }, { status: 201 });
}