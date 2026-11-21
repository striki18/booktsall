export interface EvidenceRequirementRule {
  id: string;
  name: string;
  transaction_type: string;
  amount_min: number | string | null;
  amount_max: number | string | null;
  document_type: string;
  is_active: boolean;
}

export interface RequirementTransaction {
  txnId: string | null;
  txnType: string | null;
  amount: number | null;
}

export interface ClassifiedEvidence {
  transactionId: string;
  documentType: string | null;
  matchStatus: string;
  reviewStatus: string;
  evidenceRole: string;
}

export type RequirementStatus = 'satisfied' | 'missing' | 'review_required' | 'unknown' | 'not_applicable' | 'not_configured';

export interface RequirementCheck {
  ruleId: string;
  ruleName: string;
  documentType: string;
  status: RequirementStatus;
  evidenceCount: number;
}

export interface TransactionRequirementEvaluation {
  status: RequirementStatus;
  checks: RequirementCheck[];
}

function normalizeTransactionType(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeDocumentType(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function toAmount(value: number | string | null): number | null {
  if (value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function amountApplies(rule: EvidenceRequirementRule, amount: number | null): 'applies' | 'outside' | 'unknown' {
  const minimum = toAmount(rule.amount_min);
  const maximum = toAmount(rule.amount_max);
  if (minimum === null && maximum === null) return 'applies';
  if (amount === null) return 'unknown';
  if ((minimum !== null && amount < minimum) || (maximum !== null && amount > maximum)) return 'outside';
  return 'applies';
}

function evaluateRule(
  rule: EvidenceRequirementRule,
  evidence: ClassifiedEvidence[],
): RequirementCheck {
  const requestedType = normalizeDocumentType(rule.document_type);
  const matchingType = evidence.filter((item) => normalizeDocumentType(item.documentType) === requestedType);
  const verified = matchingType.filter((item) =>
    item.matchStatus === 'verified' &&
    (item.reviewStatus === 'not_required' || item.reviewStatus === 'approved') &&
    (item.evidenceRole === 'primary' || item.evidenceRole === 'additional')
  );
  if (verified.length > 0) {
    return { ruleId: rule.id, ruleName: rule.name, documentType: rule.document_type, status: 'satisfied', evidenceCount: verified.length };
  }

  const reviewNeeded = evidence.some((item) =>
    item.reviewStatus === 'required' ||
    item.matchStatus !== 'verified' ||
    !item.documentType ||
    normalizeDocumentType(item.documentType) === requestedType
  );
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    documentType: rule.document_type,
    status: reviewNeeded ? 'review_required' : 'missing',
    evidenceCount: matchingType.length,
  };
}

/**
 * Evaluate only company-authored rules. No rule is inferred from transaction
 * type, amount, vendor, audit type, or document contents.
 */
export function evaluateTransactionRequirements(
  transaction: RequirementTransaction,
  rules: EvidenceRequirementRule[],
  allEvidence: ClassifiedEvidence[],
): TransactionRequirementEvaluation {
  const active = rules.filter((rule) => rule.is_active);
  if (active.length === 0) return { status: 'not_configured', checks: [] };

  const sameType = active.filter((rule) =>
    normalizeTransactionType(rule.transaction_type) === normalizeTransactionType(transaction.txnType)
  );
  if (sameType.length === 0) return { status: 'not_applicable', checks: [] };

  const applicable: EvidenceRequirementRule[] = [];
  let hasUnknownAmount = false;
  for (const rule of sameType) {
    const applies = amountApplies(rule, transaction.amount);
    if (applies === 'applies') applicable.push(rule);
    if (applies === 'unknown') hasUnknownAmount = true;
  }

  if (applicable.length === 0) {
    return { status: hasUnknownAmount ? 'unknown' : 'not_applicable', checks: [] };
  }

  const txnEvidence = allEvidence.filter((item) => item.transactionId === transaction.txnId);
  const checks = applicable.map((rule) => evaluateRule(rule, txnEvidence));
  const status: RequirementStatus = checks.some((check) => check.status === 'review_required')
    ? 'review_required'
    : checks.some((check) => check.status === 'missing')
      ? 'missing'
      : 'satisfied';
  return { status, checks };
}
