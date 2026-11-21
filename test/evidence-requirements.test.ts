import { describe, expect, it } from 'vitest';
import { evaluateTransactionRequirements, type ClassifiedEvidence, type EvidenceRequirementRule } from '@/lib/evidence-requirements';

const transaction = { txnId: 'txn-1', txnType: 'Invoice', amount: 250 };
const rule: EvidenceRequirementRule = {
  id: 'rule-1', name: 'Invoice support', transaction_type: 'Invoice', amount_min: 100,
  amount_max: 500, document_type: 'invoice', is_active: true,
};

function evidence(overrides: Partial<ClassifiedEvidence> = {}): ClassifiedEvidence {
  return {
    transactionId: 'txn-1', documentType: 'invoice', matchStatus: 'verified',
    reviewStatus: 'not_required', evidenceRole: 'primary', ...overrides,
  };
}

describe('explicit evidence requirement evaluation', () => {
  it('reports unconfigured when the company has no active rules', () => {
    expect(evaluateTransactionRequirements(transaction, [], [])).toEqual({ status: 'not_configured', checks: [] });
  });

  it('applies only the configured transaction type and inclusive amount range', () => {
    expect(evaluateTransactionRequirements(transaction, [rule], []).status).toBe('missing');
    expect(evaluateTransactionRequirements({ ...transaction, amount: 99 }, [rule], []).status).toBe('not_applicable');
    expect(evaluateTransactionRequirements({ ...transaction, amount: 501 }, [rule], []).status).toBe('not_applicable');
    expect(evaluateTransactionRequirements({ ...transaction, txnType: 'Bill' }, [rule], []).status).toBe('not_applicable');
  });

  it('returns unknown instead of assuming a transaction amount when a rule has bounds', () => {
    expect(evaluateTransactionRequirements({ ...transaction, amount: null }, [rule], []).status).toBe('unknown');
  });

  it('counts only verified, approved or not-required evidence of the configured type', () => {
    expect(evaluateTransactionRequirements(transaction, [rule], [evidence()]).status).toBe('satisfied');
    expect(evaluateTransactionRequirements(transaction, [rule], [evidence({ reviewStatus: 'required', evidenceRole: 'additional' })]).status).toBe('review_required');
    expect(evaluateTransactionRequirements(transaction, [rule], [evidence({ documentType: 'receipt' })]).status).toBe('missing');
  });

  it('marks unclassified evidence for review and preserves independent checks for multiple rules', () => {
    const receiptRule = { ...rule, id: 'rule-2', document_type: 'receipt' };
    const result = evaluateTransactionRequirements(transaction, [rule, receiptRule], [evidence({ documentType: null })]);
    expect(result.status).toBe('review_required');
    expect(result.checks.map((check) => check.status)).toEqual(['review_required', 'review_required']);
  });

  it('does not activate disabled rules', () => {
    expect(evaluateTransactionRequirements(transaction, [{ ...rule, is_active: false }], []).status).toBe('not_configured');
  });
});
