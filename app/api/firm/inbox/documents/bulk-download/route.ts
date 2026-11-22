import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { buildEvidencePackageZip } from '@/lib/evidence-package-zip';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const { realmId } = await requireAuth();
    const body = await request.json().catch(() => null) as { documentIds?: unknown } | null;
    if (!body || !Array.isArray(body.documentIds) || body.documentIds.length === 0 || body.documentIds.length > 250 || body.documentIds.some((id) => typeof id !== 'string' || !UUID.test(id))) {
      return NextResponse.json({ error: 'Choose between 1 and 250 valid documents' }, { status: 400 });
    }
    const documentIds = [...new Set(body.documentIds as string[])];
    const { data: documents, error } = await supabaseAdmin
      .from('inbox_documents')
      .select('id,filename,storage_path')
      .eq('realm_id', realmId)
      .in('id', documentIds)
      .is('archived_at', null);
    if (error) return NextResponse.json({ error: 'Unable to load selected documents' }, { status: 503 });
    if (!documents || documents.length !== documentIds.length) return NextResponse.json({ error: 'One or more selected documents are unavailable' }, { status: 404 });

    const files = [];
    const failedFiles = [];
    for (const document of documents) {
      const { data, error: downloadError } = await supabaseAdmin.storage.from('evidence').download(document.storage_path);
      if (downloadError || !data) {
        failedFiles.push({ documentId: document.id, fileName: document.filename, reason: 'Storage download failed' });
        continue;
      }
      files.push({ documentId: document.id, folderName: 'Selected documents', fileName: document.filename, buffer: Buffer.from(await data.arrayBuffer()) });
    }
    const zip = await buildEvidencePackageZip(`selection-${Date.now()}`, files, failedFiles);
    return new NextResponse(new Uint8Array(zip), {
      status: failedFiles.length > 0 ? 206 : 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="Zevidt-selected-documents-${new Date().toISOString().slice(0, 10)}.zip"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'UNAUTHORIZED') return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    if (code === 'NO_REALM_ID' || code === 'FORBIDDEN') return NextResponse.json({ error: 'No authorized QuickBooks company is connected' }, { status: 403 });
    console.error('Bulk inbox download failed');
    return NextResponse.json({ error: 'Unable to prepare selected documents' }, { status: 500 });
  }
}
