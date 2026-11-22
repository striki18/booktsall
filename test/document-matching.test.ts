import { describe, expect, it, vi } from 'vitest';
const supabaseMocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../lib/supabase-admin', () => ({ supabaseAdmin: { from: supabaseMocks.from } }));

import { extractFieldsFromText, getCollectionRequestWithTransactions, matchDocumentToTransactions, type ExtractedDocumentFields, type QBOTransaction } from '../lib/document-extraction';

const fields: ExtractedDocumentFields = {
  vendorName: 'Acme Supplies',
  documentDate: '2026-10-01',
  totalAmount: 125.5,
  documentNumber: 'INV-123',
  documentType: 'invoice',
  rawText: '',
};
const transaction: QBOTransaction = {
  txnId: 'txn-1', txnType: 'Bill', date: '2026-10-01', vendor: 'Acme Supplies', amount: 125.5, docNumber: 'INV-123',
};

describe('claimed transaction matching', () => {
  it.each(['Expense', 'Cash Expense', 'Credit Card Expense', 'Check', 'Purchase'])('matches the documented outgoing Purchase sign for %s without changing source values', async (txnType) => {
    const outgoing = { ...transaction, txnType, amount: -125.5 };
    const result = await matchDocumentToTransactions('receipt', fields, undefined, [outgoing], 'realm-1');
    expect(result.status).toBe('matched');
    expect(result.confidence).toBe(100);
    expect(outgoing.amount).toBe(-125.5);
    expect(result.candidateDetails?.[0]?.fieldComparisons.find(f => f.fieldName === 'totalAmount')).toMatchObject({ transactionValue: -125.5, normalizedTransactionValue: 125.5, normalization: 'qbo_purchase_report_sign', match: true });
  });

  it.each(['Invoice', 'CreditMemo', 'Unknown'])('does not erase the financial sign for %s', async (txnType) => {
    const result = await matchDocumentToTransactions('doc', fields, undefined, [{ ...transaction, txnType, amount: -125.5 }], 'realm-1');
    expect(result.matchSignals.amountMatch).toBe(false);
    expect(result.status).not.toBe('matched');
  });
  it('keeps a unique high-confidence match when the transaction is unclaimed', async () => {
    const result = await matchDocumentToTransactions('doc-1', fields, undefined, [transaction], 'realm-1');
    expect(result.status).toBe('matched');
    expect(result.transactionId).toBe('txn-1');
  });

  it('requires review when a second document scores 100% against a claimed transaction', async () => {
    const result = await matchDocumentToTransactions('doc-2', fields, undefined, [transaction], 'realm-1', new Set(['txn-1']));
    expect(result.status).toBe('multiple_candidates');
    expect(result.transactionId).toBeNull();
    expect(result.allCandidates?.map((candidate) => candidate.txnId)).toContain('txn-1');
  });

  it('returns a certain match for a claimed transaction when the caller is classifying additional evidence', async () => {
    const result = await matchDocumentToTransactions('doc-2', fields, undefined, [transaction], 'realm-1', new Set(['txn-1']), true);

    expect(result.status).toBe('matched');
    expect(result.transactionId).toBe('txn-1');
    expect(result.confidence).toBe(100);
  });

  it('can include matched register transactions for public inbox follow-up documents', async () => {
    let registerRows: typeof transaction[] = [];
    const queryFor = (table: string) => {
      let result: { data: unknown; error: null } = table === 'collection_requests'
        ? { data: { id: 'request-1', realm_id: 'realm-1', transaction_ids: ['txn-1'] }, error: null }
        : { data: [
          { qbo_txn_id: 'txn-1', qbo_txn_type: 'Bill', qbo_txn_date: '2026-10-01', qbo_txn_vendor: 'Acme Supplies', qbo_txn_amount: 125.5, qbo_txn_doc_number: 'INV-123', register_state: 'MATCHED' },
        ], error: null };
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        in: vi.fn(() => query),
        neq: vi.fn(() => { result = { data: [], error: null }; return query; }),
        single: vi.fn(async () => result),
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return query;
    };
    supabaseMocks.from.mockImplementation((table: string) => queryFor(table));

    const request = await getCollectionRequestWithTransactions('request-1', true);
    registerRows = request?.transactions ?? [];

    expect(registerRows).toHaveLength(1);
    expect(registerRows[0].txnId).toBe('txn-1');
  });

  it('returns at most four highest-ranked plausible candidates', async () => {
    const transactions = Array.from({ length: 8 }, (_, index) => ({
      ...transaction,
      txnId: `txn-${index + 1}`,
    }));

    const result = await matchDocumentToTransactions('doc-many', fields, undefined, transactions, 'realm-1');

    expect(result.status).toBe('multiple_candidates');
    expect(result.candidateDetails).toHaveLength(4);
    expect(result.allCandidates).toHaveLength(4);
    expect(result.candidateDetails?.[0].transactionId).toBe('txn-1');
    expect(result.candidateDetails?.every(candidate => candidate.confidence >= 60)).toBe(true);
  });

  it('normalizes typographic apostrophes before deciding a high-confidence vendor match', async () => {
    const invoiceFields = extractFieldsFromText([
      'INVOICE',
      'Bill to: Bill’s Windsurf Shop',
      'Invoice number: 1002',
      'Date: 2026-07-04',
      'Total: $175.00',
    ].join('\n'));
    const invoiceTransaction: QBOTransaction = {
      txnId: '10',
      txnType: 'Invoice',
      date: '2026-07-04',
      vendor: "Bill's Windsurf Shop",
      amount: 175,
      docNumber: '1002',
    };

    expect(invoiceFields.vendorName).toBe('Bill’s Windsurf Shop');
    expect(invoiceFields.documentDate).toBe('2026-07-04');
    expect(invoiceFields.totalAmount).toBe(175);
    expect(invoiceFields.documentNumber).toBe('1002');

    const result = await matchDocumentToTransactions('invoice-1002', invoiceFields, undefined, [invoiceTransaction], 'realm-1');

    expect(result.status).toBe('matched');
    expect(result.transactionId).toBe('10');
    expect(result.confidence).toBe(100);
    expect(result.matchSignals.vendorMatch).toBe(true);
  });

  it('matches a unique vendor, date and document number even when the amount differs', async () => {
    const result = await matchDocumentToTransactions('amount-warning', {
      ...fields, vendorName: "Amy's Bird Sanctuary", documentDate: '2026-10-16', documentNumber: '1001', totalAmount: 125.23,
    }, undefined, [{
      txnId: '9', txnType: 'Invoice', vendor: "Amy's Bird Sanctuary", date: '2026-10-16', docNumber: '1001', amount: 108,
    }], 'realm-1');

    expect(result.status).toBe('matched');
    expect(result.transactionId).toBe('9');
    expect(result.confidence).toBe(70);
    expect(result.matchSignals).toMatchObject({ vendorMatch: true, dateMatch: true, documentNumberMatch: true, amountMatch: false });
  });

  it('requires review when another transaction is a better candidate for an amount-mismatched document', async () => {
    const document = { ...fields, vendorName: "Amy's Bird Sanctuary", documentDate: '2026-10-16', documentNumber: '1001', totalAmount: 125.23 };
    const result = await matchDocumentToTransactions('amount-ambiguous', document, undefined, [
      { txnId: '9', txnType: 'Invoice', vendor: "Amy's Bird Sanctuary", date: '2026-10-16', docNumber: '1001', amount: 108 },
      { txnId: '10', txnType: 'Invoice', vendor: "Amy's Bird Sanctuary", date: '2026-10-16', docNumber: '1002', amount: 125.23 },
    ], 'realm-1');

    expect(result.status).toBe('multiple_candidates');
    expect(result.transactionId).toBeNull();
    expect(result.allCandidates?.map(candidate => candidate.txnId)).toEqual(expect.arrayContaining(['9', '10']));
  });

  it('requires review when more than one transaction shares the same identity fields', async () => {
    const document = { ...fields, vendorName: 'Acme Supplies', documentDate: '2026-10-01', documentNumber: 'INV-123', totalAmount: 150 };
    const result = await matchDocumentToTransactions('duplicate-identity', document, undefined, [
      { ...transaction, txnId: 'txn-1', amount: 125.5 },
      { ...transaction, txnId: 'txn-2', amount: 175 },
    ], 'realm-1');

    expect(result.status).toBe('multiple_candidates');
    expect(result.transactionId).toBeNull();
  });
});

describe('document reference extraction', () => {
  it('preserves the explicit reference read from the real scanned-invoice fixture', () => {
    const result = extractFieldsFromText('ZEVIDT TEST INVOICE\nInvoice: ZV-2026-001\nVendor: Example Supplies Ltd\nTotal: USD 125.00');
    expect(result.documentNumber).toBe('ZV-2026-001');
  });

  it('does not invent references from document headings or the next line', () => {
    expect(extractFieldsFromText('INVOICE\nVendor: Example Supplies Ltd').documentNumber).toBeNull();
    expect(extractFieldsFromText('BILL\nVendor: Example Supplies Ltd').documentNumber).toBeNull();
  });

  it('preserves a complete prefixed reference rather than returning its prefix', () => {
    expect(extractFieldsFromText('Reference INV-12345').documentNumber).toBe('INV-12345');
    expect(extractFieldsFromText('Reference INV12345').documentNumber).toBe('INV12345');
  });
});
