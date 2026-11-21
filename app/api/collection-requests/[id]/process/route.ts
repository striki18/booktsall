import { NextResponse, NextRequest } from 'next/server';
import { processCollectionRequestDocuments } from '@/lib/document-extraction';
import { updateRegisterForDocument } from '@/lib/qbo-evidence-register';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAuth } from '@/lib/auth';
import { recordProcessedEvidence } from '@/lib/qbo-evidence-ingestion';

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
      .maybeSingle();

    if (crError) {
      throw new Error('Could not verify collection request');
    }
    if (!collectionRequest) {
      return NextResponse.json({ error: 'Collection request not found' }, { status: 404 });
    }

    // 3. Authorization: Verify user owns this collection request's realm
    if (collectionRequest.realm_id !== realmId) {
      return NextResponse.json({ error: 'Forbidden: Cannot process collection request for another realm' }, { status: 403 });
    }

    const results = await processCollectionRequestDocuments(collectionRequestId);

    // Persist each result to the evidence register
    const evidenceResults: Awaited<ReturnType<typeof recordProcessedEvidence>>[] = [];
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
      evidenceResults.push(await recordProcessedEvidence({
        realmId,
        documentId: result.matchResult.documentId,
        result,
        actorUserId: user.id,
      }));
    }

    return NextResponse.json(results.map((result, index) => ({ ...result, evidence: evidenceResults[index] })), { status: 200 });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : '';
    // Handle auth errors specifically
    if (message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (message === 'NO_REALM_ID') {
      return NextResponse.json({ error: 'No realm ID associated with user' }, { status: 400 });
    }
    if (message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden: Cannot access other realm data' }, { status: 403 });
    }

    console.error('Collection request processing failed');

    if (message === 'Collection request not found' || message === 'Document not found') {
      return NextResponse.json({ error: message }, { status: 404 });
    }

    return NextResponse.json({ error: 'Could not process collection documents' }, { status: 500 });
  }
}
