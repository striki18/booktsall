import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { MAX_EVIDENCE_UPLOAD_FILES, safeEvidenceStorageFilename, validateEvidenceFile } from '@/lib/upload-validation';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

    const { data: inbox, error } = await supabaseAdmin
      .from('company_inboxes')
      .select('*')
      .eq('token', token)
      .single();

    if (error || !inbox) {
      return NextResponse.json({ error: 'Inbox not found' }, { status: 404 });
    }

    return NextResponse.json({
      inbox: {
        id: inbox.id,
        realm_id: inbox.realm_id,
        token: inbox.token,
        created_at: inbox.created_at,
      },
    });
  } catch (error) {
    console.error('Public inbox GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

    // Verify inbox exists
    const { data: inbox, error: inboxError } = await supabaseAdmin
      .from('company_inboxes')
      .select('*')
      .eq('token', token)
      .single();

    if (inboxError || !inbox) {
      return NextResponse.json({ error: 'Inbox not found' }, { status: 404 });
    }

    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    if (files.length > MAX_EVIDENCE_UPLOAD_FILES) return NextResponse.json({ error: 'Too many files; maximum is 10' }, { status: 400 });
    if (files.some((file) => !(file instanceof File))) return NextResponse.json({ error: 'Only file uploads are allowed' }, { status: 400 });
    const validations = await Promise.all(files.map((file) => validateEvidenceFile(file)));
    const invalidIndex = validations.findIndex((validation) => !validation.valid);
    if (invalidIndex >= 0) {
      const invalid = validations[invalidIndex];
      if (!invalid.valid) return NextResponse.json({ error: 'File ' + (invalidIndex + 1) + ': ' + invalid.error }, { status: 400 });
    }
    const contentTypes = validations.map((validation) => {
      if (!validation.valid) throw new Error('Upload validation failed');
      return validation.contentType;
    });

    const uploadedDocuments = [];

    for (const file of files) {
      const contentType = contentTypes[files.indexOf(file)];

      // Generate storage path: inbox/{realm_id}/{document_id}/{filename}
      const documentId = crypto.randomUUID();
      const storagePath = `inbox/${inbox.realm_id}/${documentId}/${safeEvidenceStorageFilename(file.name)}`;

      // Upload to Supabase Storage
      const { error: uploadError } = await supabaseAdmin.storage
        .from('evidence')
        .upload(storagePath, file, {
          contentType,
          upsert: false,
        });

      if (uploadError) {
        console.error('Storage upload error:', uploadError);
        return NextResponse.json({ error: `Failed to upload ${file.name}` }, { status: 500 });
      }

      // Save document metadata
      const { data: document, error: docError } = await supabaseAdmin
        .from('inbox_documents')
        .insert({
          realm_id: inbox.realm_id,
          storage_path: storagePath,
          filename: file.name,
          content_type: contentType,
          file_size: file.size,
        })
        .select()
        .single();

      if (docError) {
        const { error: cleanupError } = await supabaseAdmin.storage.from('evidence').remove([storagePath]);
        console.error('Document metadata save failed; uploaded object cleanup attempted', cleanupError ? 'failed' : 'completed');
        return NextResponse.json({ error: cleanupError ? 'Document metadata failed and uploaded file cleanup failed' : 'Document metadata could not be saved' }, { status: 500 });
        return NextResponse.json({ error: `Failed to save metadata for ${file.name}` }, { status: 500 });
      }

    uploadedDocuments.push({
        id: document.id,
        filename: document.filename,
        content_type: document.content_type,
        file_size: document.file_size,
        uploaded_at: document.uploaded_at,
      });
    }

    return NextResponse.json({
      uploaded: uploadedDocuments.length,
      documents: uploadedDocuments,
    });
  } catch (error) {
    console.error('Public inbox upload error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
