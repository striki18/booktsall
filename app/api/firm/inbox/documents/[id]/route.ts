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
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { realmId, user } = await requireAuth();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Explicit confirmation is required to remove this document from the inbox' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body as Record<string, unknown>).confirmed !== true) {
      return NextResponse.json({ error: 'Explicit confirmation is required to remove this document from the inbox' }, { status: 400 });
    }
    const reason = (body as Record<string, unknown>).reason;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) {
      return NextResponse.json({ error: 'Invalid archive reason' }, { status: 400 });
    }
    const { id } = await params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json({ error: 'Invalid document ID' }, { status: 400 });
    }
    const { data, error } = await supabaseAdmin.rpc('archive_inbox_document', {
      p_realm_id: realmId,
      p_document_id: id,
      p_actor_user_id: user.id,
      p_reason: typeof reason === 'string' ? reason : null,
    });
    if (error) {
      console.error('Inbox document archive failed');
      return NextResponse.json({ error: 'Unable to remove document from inbox' }, { status: 503 });
    }
    if (data === 'not_found') return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    if (data !== 'archived' && data !== 'already_archived') {
      return NextResponse.json({ error: 'Unable to remove document from inbox' }, { status: 503 });
    }
    return NextResponse.json({ archived: true, retained: true, auditRecorded: data === 'archived' }, { status: 200 });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'UNAUTHORIZED') return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    if (code === 'NO_REALM_ID' || code === 'FORBIDDEN') return NextResponse.json({ error: 'No authorized QuickBooks company is connected' }, { status: 403 });
    console.error('Inbox document delete failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Unable to delete document' }, { status: 500 });
  }
}
