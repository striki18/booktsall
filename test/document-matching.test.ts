import { describe, expect, it, vi } from 'vitest';
vi.mock('../lib/supabase-admin', () => ({ supabaseAdmin: {} }));

import { matchDocumentToTransactions, type ExtractedDocumentFields, type QBOTransaction } from '../lib/document-extraction';

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
});
