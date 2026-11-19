import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAuth } from '@/lib/auth';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { realmId } = await requireAuth();
    const { id } = await params;
    const { data: document, error } = await supabaseAdmin
      .from('inbox_documents')
      .select('id, realm_id, storage_path')
      .eq('id', id)
      .eq('realm_id', realmId)
      .single();

    if (error || !document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const { data, error: urlError } = await supabaseAdmin.storage
      .from('evidence')
      .createSignedUrl(document.storage_path, 600);
    if (urlError || !data?.signedUrl) {
      return NextResponse.json({ error: 'Unable to create document download link' }, { status: 500 });
    }
    return NextResponse.redirect(data.signedUrl);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (code === 'NO_REALM_ID' || code === 'FORBIDDEN') {
      return NextResponse.json({ error: 'No authorized QuickBooks company is connected' }, { status: 403 });
    }
    console.error('Inbox document download failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Unable to download document' }, { status: 500 });
  }
}
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { realmId } = await requireAuth();
    const { id } = await params;
    const { data: document, error: documentError } = await supabaseAdmin
      .from('inbox_documents')
      .select('id, realm_id, storage_path, content_type')
      .eq('id', id)
      .eq('realm_id', realmId)
      .maybeSingle();
    if (documentError) return NextResponse.json({ error: 'Unable to verify document ownership' }, { status: 500 });
    if (!document) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

    const { data: registerReference, error: registerError } = await supabaseAdmin
      .from('qbo_evidence_register')
      .select('id')
      .eq('realm_id', realmId)
      .eq('matched_document_id', id)
      .limit(1)
      .maybeSingle();
    if (registerError) return NextResponse.json({ error: 'Unable to verify evidence references' }, { status: 500 });
    const { data: decisionReference, error: decisionError } = await supabaseAdmin
      .from('evidence_review_decisions')
      .select('id')
      .eq('realm_id', realmId)
      .eq('evidence_document_id', id)
      .limit(1)
      .maybeSingle();
    if (decisionError) return NextResponse.json({ error: 'Unable to verify evidence references' }, { status: 500 });
    const { data: packageReference, error: packageError } = await supabaseAdmin
      .from('evidence_package_items')
      .select('id')
      .eq('document_id', id)
      .limit(1)
      .maybeSingle();
    if (packageError) return NextResponse.json({ error: 'Unable to verify package history references' }, { status: 500 });
    if (registerReference || decisionReference || packageReference) {
      return NextResponse.json({ error: 'This document is linked to evidence or package history and cannot be deleted' }, { status: 409 });
    }

    const storage = supabaseAdmin.storage.from('evidence');
    const { data: storedFile, error: downloadError } = await storage.download(document.storage_path);
    if (downloadError || !storedFile) return NextResponse.json({ error: 'Unable to verify the stored evidence file' }, { status: 502 });
    const fileBytes = Buffer.from(await storedFile.arrayBuffer());
    const { error: removeError } = await storage.remove([document.storage_path]);
    if (removeError) return NextResponse.json({ error: 'Unable to remove the stored evidence file' }, { status: 502 });

    const { error: deleteError } = await supabaseAdmin.from('inbox_documents').delete().eq('id', id).eq('realm_id', realmId);
    if (deleteError) {
      const { error: restoreError } = await storage.upload(document.storage_path, fileBytes, {
        upsert: false,
        contentType: document.content_type,
      });
      console.error('Evidence metadata delete failed; storage restore attempted', restoreError ? 'failed' : 'completed');
      return NextResponse.json({ error: 'Unable to delete document metadata' }, { status: 500 });
    }
    return NextResponse.json({ deleted: true }, { status: 200 });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'UNAUTHORIZED') return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    if (code === 'NO_REALM_ID' || code === 'FORBIDDEN') return NextResponse.json({ error: 'No authorized QuickBooks company is connected' }, { status: 403 });
    console.error('Inbox document delete failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Unable to delete document' }, { status: 500 });
  }
}
