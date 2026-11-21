import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';

export async function GET(request?: Request) {
  let realmId: string;
  try {
    ({ realmId } = await requireAuth());
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === 'UNAUTHORIZED';
    return NextResponse.json({ error: unauthorized ? 'Authentication required' : 'No authorized QuickBooks company is connected' }, { status: unauthorized ? 401 : 403 });
  }

  if (request && new URL(request.url).searchParams.get('managedDocuments') === 'true') {
    const ids = new Set<string>();
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await supabaseAdmin.from('qbo_evidence_items')
        .select('inbox_document_id').eq('realm_id', realmId).order('id').range(offset, offset + 499);
      if (error || !data) return NextResponse.json({ error: 'Unable to verify managed evidence documents' }, { status: 503 });
      for (const item of data) if (item.inbox_document_id) ids.add(item.inbox_document_id);
      if (data.length < 500) break;
    }
    return NextResponse.json({ documentIds: [...ids] });
  }

  const { data: items, error } = await supabaseAdmin.from('qbo_evidence_items')
    .select('id, realm_id, register_entry_id, proposed_register_entry_id, candidate_qbo_txn_ids, source_type, inbox_document_id, qbo_attachable_id, content_sha256, match_status, review_status, evidence_role, qbo_attachment_status, duplicate_of_item_id, created_at')
    .eq('realm_id', realmId)
    .eq('review_status', 'required')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: 'Unable to load evidence items for review' }, { status: 503 });
  if (!items?.length) return NextResponse.json([]);

  const actionableItems = items.filter((item) =>
    item.match_status === 'duplicate' || item.match_status === 'potential' ||
    (item.match_status === 'verified' && item.evidence_role === 'additional')
  );
  if (!actionableItems.length) return NextResponse.json([]);

  const documentIds = [...new Set(actionableItems.map((item) => item.inbox_document_id).filter((id): id is string => Boolean(id)))];
  const registerIds = [...new Set(actionableItems.flatMap((item) => [item.register_entry_id, item.proposed_register_entry_id]).filter((id): id is string => Boolean(id)))];
  const candidateTxnIds = [...new Set(actionableItems.flatMap((item) => item.candidate_qbo_txn_ids ?? []).filter((id): id is string => typeof id === 'string'))];
  const duplicateItemIds = [...new Set(actionableItems.map((item) => item.duplicate_of_item_id).filter((id): id is string => Boolean(id)))];

  const [documentsResult, duplicateItemsResult] = await Promise.all([
    documentIds.length
      ? supabaseAdmin.from('inbox_documents').select('id, filename, content_type, file_size').eq('realm_id', realmId).in('id', documentIds)
      : Promise.resolve({ data: [], error: null }),
    duplicateItemIds.length
      ? supabaseAdmin.from('qbo_evidence_items').select('id, register_entry_id, proposed_register_entry_id, candidate_qbo_txn_ids').eq('realm_id', realmId).in('id', duplicateItemIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (documentsResult.error || duplicateItemsResult.error) return NextResponse.json({ error: 'Unable to load evidence review details' }, { status: 503 });

  for (const duplicate of duplicateItemsResult.data ?? []) {
    if (duplicate.register_entry_id) registerIds.push(duplicate.register_entry_id);
    if (duplicate.proposed_register_entry_id) registerIds.push(duplicate.proposed_register_entry_id);
    candidateTxnIds.push(...(duplicate.candidate_qbo_txn_ids ?? []));
  }

  const uniqueRegisterIds = [...new Set(registerIds)];
  const uniqueCandidateTxnIds = [...new Set(candidateTxnIds)];
  const registerResults = await Promise.all([
    uniqueRegisterIds.length
      ? supabaseAdmin.from('qbo_evidence_register')
        .select('id, qbo_txn_id, qbo_txn_type, qbo_txn_date, qbo_txn_vendor, qbo_txn_amount, qbo_txn_doc_number')
        .eq('realm_id', realmId).in('id', uniqueRegisterIds).limit(500)
      : Promise.resolve({ data: [], error: null }),
    uniqueCandidateTxnIds.length
      ? supabaseAdmin.from('qbo_evidence_register')
        .select('id, qbo_txn_id, qbo_txn_type, qbo_txn_date, qbo_txn_vendor, qbo_txn_amount, qbo_txn_doc_number')
        .eq('realm_id', realmId).in('qbo_txn_id', uniqueCandidateTxnIds).limit(500)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (registerResults.some((result) => result.error)) return NextResponse.json({ error: 'Unable to load transaction choices for evidence review' }, { status: 503 });
  const registers = [...new Map(registerResults.flatMap((result) => result.data ?? []).map((register) => [register.id, register])).values()];

  const documentsById = new Map((documentsResult.data ?? []).map((document) => [document.id, document]));
  const duplicateItemsById = new Map((duplicateItemsResult.data ?? []).map((item) => [item.id, item]));
  return NextResponse.json(actionableItems.map((item) => {
    const duplicateOf = item.duplicate_of_item_id ? duplicateItemsById.get(item.duplicate_of_item_id) ?? null : null;
    return {
      ...item,
      document: item.inbox_document_id ? documentsById.get(item.inbox_document_id) ?? null : null,
      duplicateOf,
      transactionChoices: registers.filter((register) =>
      register.id === item.register_entry_id || register.id === item.proposed_register_entry_id ||
      register.id === duplicateOf?.register_entry_id || register.id === duplicateOf?.proposed_register_entry_id ||
      (item.candidate_qbo_txn_ids ?? []).includes(register.qbo_txn_id) ||
      (duplicateOf?.candidate_qbo_txn_ids ?? []).includes(register.qbo_txn_id)
      ),
    };
  }));
}
