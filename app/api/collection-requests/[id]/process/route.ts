import { NextResponse, NextRequest } from 'next/server';
import { processCollectionRequestDocuments } from '@/lib/document-extraction';
import { updateRegisterForDocument } from '@/lib/qbo-evidence-register';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAuth } from '@/lib/auth';

/**
 * POST /api/collection-requests/[id]/process
 *
 * Processes all documents for a collection request by extracting fields
 * and matching them against QuickBooks transactions.
 * Persists each result to the qbo_evidence_register via updateRegisterForDocument.
 *
 * Requires authentication and ownership verification of the collection request's realm.
 *
 * Responses:
 *   200 – JSON array of processed document results
 *   400 – Invalid UUID supplied
 *   401 – Unauthorized
 *   403 – Forbidden: User does not own this collection request's realm
 *   404 – Collection request not found
 *   500 – Processing error
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: collectionRequestId } = await params;

  // Validate UUID format
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!collectionRequestId || !uuidRegex.test(collectionRequestId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  try {
    // 1. Authentication check
    const { user, realmId } = await requireAuth();

    // 2. Get realm_id for the collection request and verify ownership
    const { data: collectionRequest, error: crError } = await supabaseAdmin
      .from('collection_requests')
      .select('realm_id')
      .eq('id', collectionRequestId)
      .single();

    if (crError || !collectionRequest) {
      return NextResponse.json({ error: 'Collection request not found' }, { status: 404 });
    }

    // 3. Authorization: Verify user owns this collection request's realm
    if (collectionRequest.realm_id !== realmId) {
      return NextResponse.json({ error: 'Forbidden: Cannot process collection request for another realm' }, { status: 403 });
    }

    const results = await processCollectionRequestDocuments(collectionRequestId);

    // Persist each result to the evidence register
    for (const result of results) {
      await updateRegisterForDocument(
        result.matchResult.documentId,
        realmId,
        collectionRequestId,
        result.matchResult,
        result.extractedFields,
        result.isDuplicate,
        result.duplicateOfDocumentId
      );
    }

    return NextResponse.json(results, { status: 200 });
  } catch (e: any) {
    // Handle auth errors specifically
    if (e.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (e.message === 'NO_REALM_ID') {
      return NextResponse.json({ error: 'No realm ID associated with user' }, { status: 400 });
    }
    if (e.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden: Cannot access other realm data' }, { status: 403 });
    }

    console.error('Collection request processing error:', e);

    if (e.message?.includes('not found')) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }

    return NextResponse.json({ error: e.message ?? 'Internal server error' }, { status: 500 });
  }
}
