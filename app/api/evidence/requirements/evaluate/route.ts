import { NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/auth';
import { ownershipErrorStatus } from '@/lib/resource-access';
import { evaluateTransactionRequirements, type ClassifiedEvidence, type EvidenceRequirementRule } from '@/lib/evidence-requirements';

const PAGE_SIZE = 500;
type PageResult<T> = { data: T[] | null; error: unknown };
type EvidenceItemRecord = {
  id: string;
  register_entry_id: string | null;
  proposed_register_entry_id: string | null;
  candidate_qbo_txn_ids: string[] | null;
  inbox_document_id: string | null;
  match_status: string;
  review_status: string;
  evidence_role: string;
};

async function readAllPages<T>(makePage: (from: number, to: number) => PromiseLike<PageResult<T>>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await makePage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error('Evidence requirements could not be loaded');
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}
function isDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export async function GET(request: Request) {
  let context: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    context = await requireAuthContext();
  } catch (error) {
    const status = ownershipErrorStatus(error);
    return NextResponse.json({ error: status === 401 ? 'Authentication required' : 'Forbidden' }, { status: status ?? 500 });
  }

  const url = new URL(request.url);
  const startDate = url.searchParams.get('startDate');
  const endDate = url.searchParams.get('endDate');
  if (!isDate(startDate) || !isDate(endDate) || startDate > endDate) {
    return NextResponse.json({ error: 'A valid startDate and endDate are required' }, { status: 400 });
  }

  try {
    const [rules, registers] = await Promise.all([
      readAllPages<EvidenceRequirementRule>((from, to) => context.supabase
        .from('evidence_requirement_rules')
        .select('id, name, transaction_type, amount_min, amount_max, document_type, is_active')
        .eq('realm_id', context.realmId)
        .eq('is_active', true)
        .range(from, to)),
      readAllPages<{
        id: string;
        qbo_txn_id: string;
        qbo_txn_type: string | null;
        qbo_txn_date: string | null;
        qbo_txn_amount: number | string | null;
        qbo_txn_vendor: string | null;
        qbo_txn_doc_number: string | null;
        register_state: string;
        matched_document_id: string | null;
        attachable_id: string | null;
      }>((from, to) => context.supabase
        .from('qbo_evidence_register')
        .select('id, qbo_txn_id, qbo_txn_type, qbo_txn_date, qbo_txn_amount, qbo_txn_vendor, qbo_txn_doc_number, register_state, matched_document_id, attachable_id')
        .eq('realm_id', context.realmId)
        .gte('qbo_txn_date', startDate)
        .lte('qbo_txn_date', endDate)
        .range(from, to)),
    ]);

    const registerIds = [...new Set(registers.map((row) => row.id))];
    const txnIds = [...new Set(registers.map((row) => row.qbo_txn_id))];
    const itemPages: Array<Promise<EvidenceItemRecord[]>> = [];
    for (let index = 0; index < registerIds.length; index += 200) {
      const registerChunk = registerIds.slice(index, index + 200);
      const txnChunk = txnIds.slice(index, index + 200);
      itemPages.push(readAllPages<{
        id: string;
        register_entry_id: string | null;
        proposed_register_entry_id: string | null;
        candidate_qbo_txn_ids: string[] | null;
        inbox_document_id: string | null;
        match_status: string;
        review_status: string;
        evidence_role: string;
      }>((from, to) => context.supabase
        .from('qbo_evidence_items')
        .select('id, register_entry_id, proposed_register_entry_id, candidate_qbo_txn_ids, inbox_document_id, match_status, review_status, evidence_role')
        .eq('realm_id', context.realmId)
        .in('register_entry_id', registerChunk)
        .range(from, to)).then((items) => items));
      itemPages.push(readAllPages<{
        id: string;
        register_entry_id: string | null;
        proposed_register_entry_id: string | null;
        candidate_qbo_txn_ids: string[] | null;
        inbox_document_id: string | null;
        match_status: string;
        review_status: string;
        evidence_role: string;
      }>((from, to) => context.supabase
        .from('qbo_evidence_items')
        .select('id, register_entry_id, proposed_register_entry_id, candidate_qbo_txn_ids, inbox_document_id, match_status, review_status, evidence_role')
        .eq('realm_id', context.realmId)
        .in('proposed_register_entry_id', registerChunk)
        .range(from, to)).then((items) => items));
      if (txnChunk.length) {
        itemPages.push(readAllPages<{
          id: string;
          register_entry_id: string | null;
          proposed_register_entry_id: string | null;
          candidate_qbo_txn_ids: string[] | null;
          inbox_document_id: string | null;
          match_status: string;
          review_status: string;
          evidence_role: string;
        }>((from, to) => context.supabase
          .from('qbo_evidence_items')
          .select('id, register_entry_id, proposed_register_entry_id, candidate_qbo_txn_ids, inbox_document_id, match_status, review_status, evidence_role')
          .eq('realm_id', context.realmId)
          .overlaps('candidate_qbo_txn_ids', txnChunk)
          .range(from, to)).then((items) => items));
      }
    }
    const rawEvidencePages = await Promise.all(itemPages);
    const evidenceItems = [...new Map(rawEvidencePages.flat().map((item) => [item.id, item])).values()];
    const documentIds = [...new Set([
      ...evidenceItems.map((item) => item.inbox_document_id),
      ...registers.map((row) => row.matched_document_id),
    ].filter((id): id is string => !!id))];
    const documents: Array<{ id: string; extracted_type: string | null }> = [];
    for (let index = 0; index < documentIds.length; index += 200) {
      const chunk = documentIds.slice(index, index + 200);
      documents.push(...await readAllPages<{ id: string; extracted_type: string | null }>((from, to) => context.supabase
        .from('inbox_documents')
        .select('id, extracted_type')
        .eq('realm_id', context.realmId)
        .in('id', chunk)
        .range(from, to)));
    }
    const typeByDocument = new Map(documents.map((document) => [document.id, document.extracted_type]));
    const evidenceByTransaction = new Map<string, ClassifiedEvidence[]>();
    const registerTxn = new Map(registers.map((register) => [register.id, register.qbo_txn_id]));
    const currentTxnIds = new Set(txnIds);
    for (const item of evidenceItems) {
      const relatedIds = [item.register_entry_id, item.proposed_register_entry_id].filter((id): id is string => !!id);
      const associatedTransactions = new Set(relatedIds.map((id) => registerTxn.get(id)).filter((id): id is string => !!id));
      for (const candidate of item.candidate_qbo_txn_ids ?? []) {
        if (currentTxnIds.has(candidate)) associatedTransactions.add(candidate);
      }
      for (const transactionId of associatedTransactions) {
        const classified: ClassifiedEvidence = {
          transactionId,
          documentType: item.inbox_document_id ? typeByDocument.get(item.inbox_document_id) ?? null : null,
          matchStatus: item.match_status,
          reviewStatus: item.review_status,
          evidenceRole: item.evidence_role,
        };
        evidenceByTransaction.set(transactionId, [...(evidenceByTransaction.get(transactionId) ?? []), classified]);
      }
    }

    const rows = registers.map((register) => {
      const evidence = [...(evidenceByTransaction.get(register.qbo_txn_id) ?? [])];
      if (register.matched_document_id) {
        evidence.push({
          transactionId: register.qbo_txn_id,
          documentType: typeByDocument.get(register.matched_document_id) ?? null,
          matchStatus: register.register_state === 'MATCHED' ? 'verified' : register.register_state.toLowerCase(),
          reviewStatus: register.register_state === 'MATCHED' ? 'not_required' : 'required',
          evidenceRole: register.register_state === 'MATCHED' ? 'primary' : 'unassigned',
        });
      }
      if (register.attachable_id && !evidence.some((item) => item.documentType)) {
        evidence.push({ transactionId: register.qbo_txn_id, documentType: null, matchStatus: 'unreviewed', reviewStatus: 'required', evidenceRole: 'unassigned' });
      }
      const amount = register.qbo_txn_amount === null ? null : Number(register.qbo_txn_amount);
      const transaction = {
        txnId: register.qbo_txn_id,
        txnType: register.qbo_txn_type,
        date: register.qbo_txn_date,
        amount: Number.isFinite(amount) ? amount : null,
        vendor: register.qbo_txn_vendor,
        docNumber: register.qbo_txn_doc_number,
      };
      const evaluation = evaluateTransactionRequirements(transaction, rules, evidence);
      return { transaction, ...evaluation };
    });
    return NextResponse.json({ rulesConfigured: rules.length > 0, rows });
  } catch {
    return NextResponse.json({ error: 'Unable to evaluate evidence requirements' }, { status: 503 });
  }
}
