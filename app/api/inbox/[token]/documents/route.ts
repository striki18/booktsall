import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { processInboxDocument, type ProcessedDocumentResult } from '../../../../../lib/document-extraction';
import { updateRegisterForDocument } from '../../../../../lib/qbo-evidence-register';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

/**
 * Find the most recent collection request for a realm so uploaded documents
 * can be routed through the existing document-processing pipeline.
 * Returns null when no collection request exists for the realm.
 */
async function findLatestCollectionRequest(realmId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('collection_requests')
    .select('id')
    .eq('realm_id', realmId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    return null;
  }

  return data.id;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

    // Find the inbox by token
    const { data: inbox, error: inboxError } = await supabaseAdmin
      .from('company_inboxes')
      .select('realm_id')
      .eq('token', token)
      .single();

    if (inboxError || !inbox) {
      return NextResponse.json({ error: 'Invalid inbox link' }, { status: 404 });
    }

    const realmId = inbox.realm_id;
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const uploadedDocuments = [];

    for (const file of files) {
      const fileExt = file.name.split('.').pop() || '';
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      const storagePath = `inbox/${realmId}/${token}/${fileName}`;

      // Upload to Supabase storage
      const { error: uploadError } = await supabaseAdmin.storage
        .from('evidence')
        .upload(storagePath, file, {
          contentType: file.type,
          upsert: false,
        });

      if (uploadError) {
        console.error('Storage upload error:', uploadError);
        return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
      }

      // Store document metadata
      const { data: document, error: docError } = await supabaseAdmin
        .from('inbox_documents')
        .insert({
          realm_id: realmId,
          storage_path: storagePath,
          filename: file.name,
          content_type: file.type,
          file_size: file.size,
        })
        .select()
        .single();

      if (docError) {
        console.error('Document insert error:', docError);
        return NextResponse.json({ error: 'Failed to save document metadata' }, { status: 500 });
      }

      // Keep upload success distinct from extraction and matching state. A failed
      // processing attempt is persisted and returned so it can be retried visibly.
      let processingStatus: 'pending' | 'processed' | 'failed' = 'pending';
      let processingError: string | null = null;
      try {
        const collectionRequestId = await findLatestCollectionRequest(realmId);
        if (collectionRequestId) {
          const { error: startedError } = await supabaseAdmin
            .from('inbox_documents')
            .update({ processing_status: 'processing', processing_error: null })
            .eq('id', document.id)
            .eq('realm_id', realmId);
          if (startedError) throw startedError;

          const result: ProcessedDocumentResult = await processInboxDocument(document.id, collectionRequestId);
          await updateRegisterForDocument(
            document.id,
            realmId,
            collectionRequestId,
            result.matchResult,
            result.extractedFields,
            result.isDuplicate,
            result.duplicateOfDocumentId
          );

          const { error: completedError } = await supabaseAdmin
            .from('inbox_documents')
            .update({ processing_status: 'processed', processing_error: null })
            .eq('id', document.id)
            .eq('realm_id', realmId);
          if (completedError) throw completedError;
          processingStatus = 'processed';
        }
      } catch {
        processingStatus = 'failed';
        processingError = 'Evidence processing failed; retry required';
        const { error: statusError } = await supabaseAdmin
          .from('inbox_documents')
          .update({ processing_status: 'failed', processing_error: processingError })
          .eq('id', document.id)
          .eq('realm_id', realmId);
        console.error('Document processing failed; retry state stored', statusError ? 'failed' : 'updated');
      }

      uploadedDocuments.push({
        ...document,
        processing_status: processingStatus,
        processing_error: processingError,
      });
    }

    return NextResponse.json({ documents: uploadedDocuments }, { status: 201 });
  } catch (error) {
    console.error('Document upload error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json(
    { error: 'Document listing and downloads are not available through public upload links' },
    { status: 405 }
  );
}