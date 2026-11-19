import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getTransactions: vi.fn(),
  getAttachables: vi.fn(),
  getRegisterEntries: vi.fn(),
  buildQboEvidenceRegister: vi.fn(async (): Promise<any[]> => []),
  applyStoredEvidenceReviewDecisions: vi.fn(async (entries: any[]): Promise<any[]> => entries),
  persistRegisterEntries: vi.fn(),
  buildEvidenceRegister: vi.fn(() => []),
  generateAndSaveCsvs: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/quickbooks', () => ({
  getTransactions: mocks.getTransactions,
  normalizeTransactionList: vi.fn(() => []),
  getAttachables: mocks.getAttachables,
  normalizeAttachables: vi.fn(() => []),
}));
vi.mock('@/lib/evidence', () => ({ buildEvidenceRegister: mocks.buildEvidenceRegister }));
vi.mock('@/lib/qbo-evidence-register', () => ({
  getRegisterEntries: mocks.getRegisterEntries,
  buildQboEvidenceRegister: mocks.buildQboEvidenceRegister,
  applyStoredEvidenceReviewDecisions: mocks.applyStoredEvidenceReviewDecisions,
  persistRegisterEntries: mocks.persistRegisterEntries,
}));
vi.mock('@/lib/output', () => ({ generateAndSaveCsvs: mocks.generateAndSaveCsvs }));

import { GET as evidenceRegister } from '@/app/api/evidence/register/route';
import { GET as evidenceCsv } from '@/app/api/evidence/csv/route';
import { GET as qboRegisterGet, POST as qboRegisterPost } from '@/app/api/evidence/qbo-register/route';

beforeEach(() => vi.clearAllMocks());

describe('evidence API company scope', () => {
  it('denies anonymous requests before QBO or evidence services run', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('UNAUTHORIZED'));
    const responses = await Promise.all([
      evidenceRegister(new Request('http://localhost/api/evidence/register?startDate=2025-01-01&endDate=2025-01-31')),
      evidenceCsv(new Request('http://localhost/api/evidence/csv?startDate=2025-01-01&endDate=2025-01-31')),
      qboRegisterGet(new Request('http://localhost/api/evidence/qbo-register?realmId=realm-1')),
      qboRegisterPost(new Request('http://localhost/api/evidence/qbo-register', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ realmId: 'realm-1' }),
      })),
    ]);

    expect(responses.map(response => response.status)).toEqual([401, 401, 401, 401]);
    expect(mocks.getTransactions).not.toHaveBeenCalled();
    expect(mocks.getAttachables).not.toHaveBeenCalled();
    expect(mocks.getRegisterEntries).not.toHaveBeenCalled();
    expect(mocks.persistRegisterEntries).not.toHaveBeenCalled();
    expect(mocks.generateAndSaveCsvs).not.toHaveBeenCalled();
  });

  it('passes the authenticated realm through evidence register QBO reads', async () => {
    mocks.requireAuth.mockResolvedValue({ realmId: 'realm-owned' });
    mocks.getTransactions.mockResolvedValue({});
    mocks.getAttachables.mockResolvedValue({ attachables: [] });

    const response = await evidenceRegister(new Request('http://localhost/api/evidence/register?startDate=2025-01-01&endDate=2025-01-31'));

    expect(response.status).toBe(200);
    expect(mocks.getTransactions).toHaveBeenCalledWith('2025-01-01', '2025-01-31', 'realm-owned');
    expect(mocks.getAttachables).toHaveBeenCalledWith('realm-owned');
  });

  it('returns the durable reviewer decision overlay from the evidence register endpoint', async () => {
    mocks.requireAuth.mockResolvedValue({ realmId: 'realm-owned' });
    const row = { id: 'entry-1', qboTxnId: 'txn-1', registerState: 'MATCHED' };
    const reviewedRow = { ...row, humanApproved: true, reviewDecision: { action: 'confirm_match', selected_qbo_txn_id: 'txn-1' } };
    mocks.getTransactions.mockResolvedValue({});
    mocks.getAttachables.mockResolvedValue({ attachables: [] });
    mocks.buildQboEvidenceRegister.mockResolvedValue([row]);
    mocks.applyStoredEvidenceReviewDecisions.mockResolvedValue([reviewedRow]);

    const response = await evidenceRegister(new Request('http://localhost/api/evidence/register?startDate=2025-01-01&endDate=2025-01-31'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([reviewedRow]);
    expect(mocks.applyStoredEvidenceReviewDecisions).toHaveBeenCalledWith([row], 'realm-owned');
  });

  it('exports reviewer decisions in the generated evidence CSV input', async () => {
    mocks.requireAuth.mockResolvedValue({ realmId: 'realm-owned' });
    const row = { id: 'entry-1', qboTxnId: 'txn-1', registerState: 'REVIEW_REQUIRED' };
    const reviewedRow = { ...row, humanApproved: true, reviewDecision: { action: 'confirm_match' } };
    mocks.getTransactions.mockResolvedValue({});
    mocks.getAttachables.mockResolvedValue({ attachables: [] });
    mocks.buildQboEvidenceRegister.mockResolvedValue([row]);
    mocks.applyStoredEvidenceReviewDecisions.mockResolvedValue([reviewedRow]);
    mocks.generateAndSaveCsvs.mockResolvedValue({ evidenceRegisterPath: 'evidence_register.csv', missingDocumentsPath: 'missing_documents.csv', matchedCount: 1, missingCount: 0 });

    const response = await evidenceCsv(new Request('http://localhost/api/evidence/csv?startDate=2025-01-01&endDate=2025-01-31'));

    expect(response.status).toBe(200);
    expect(mocks.generateAndSaveCsvs).toHaveBeenCalledWith([reviewedRow], 'realm-owned', '2025-01-01', '2025-01-31');
  });

  it('returns the durable reviewer decision overlay from the persisted QBO register endpoint', async () => {
    mocks.requireAuth.mockResolvedValue({ realmId: 'realm-owned' });
    const row = { id: 'entry-1', qboTxnId: 'txn-1', registerState: 'MATCHED' };
    const reviewedRow = { ...row, humanApproved: true, reviewDecision: { action: 'confirm_match', selected_qbo_txn_id: 'txn-1' } };
    mocks.getRegisterEntries.mockResolvedValue([row]);
    mocks.applyStoredEvidenceReviewDecisions.mockResolvedValue([reviewedRow]);

    const response = await qboRegisterGet(new Request('http://localhost/api/evidence/qbo-register?realmId=realm-owned&startDate=2025-01-01&endDate=2025-01-31'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([reviewedRow]);
    expect(mocks.getRegisterEntries).toHaveBeenCalledWith('realm-owned', undefined, '2025-01-01', '2025-01-31');
    expect(mocks.applyStoredEvidenceReviewDecisions).toHaveBeenCalledWith([row], 'realm-owned', [row]);
  });

  it('rejects a different realm before reading or persisting QBO register data', async () => {
    mocks.requireAuth.mockResolvedValue({ realmId: 'realm-owned' });
    const getResponse = await qboRegisterGet(new Request('http://localhost/api/evidence/qbo-register?realmId=other-realm'));
    const postResponse = await qboRegisterPost(new Request('http://localhost/api/evidence/qbo-register', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ realmId: 'other-realm' }),
    }));

    expect(getResponse.status).toBe(403);
    expect(postResponse.status).toBe(403);
    expect(mocks.getRegisterEntries).not.toHaveBeenCalled();
    expect(mocks.persistRegisterEntries).not.toHaveBeenCalled();
  });
});
