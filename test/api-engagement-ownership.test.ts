import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireOwnedEngagement: vi.fn(),
  supabaseFrom: vi.fn(),
}));

vi.mock('@/lib/resource-access', () => ({
  requireOwnedEngagement: mocks.requireOwnedEngagement,
  ownershipErrorStatus: (error: Error) => error.message === 'UNAUTHORIZED' ? 401 : error.message === 'FORBIDDEN' ? 403 : null,
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: mocks.supabaseFrom } }));

import { GET as evidencePlan } from '@/app/api/evidence/plan/route';
import { GET as evidenceRequests, POST as createEvidenceRequest } from '@/app/api/evidence/request/route';
import { POST as createEvidencePackage } from '@/app/api/evidence/package/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireOwnedEngagement.mockRejectedValue(new Error('FORBIDDEN'));
});

describe('engagement ownership gates', () => {
  it('denies foreign engagement reads before database queries', async () => {
    const validId = '123e4567-e89b-42d3-a456-426614174000';
    const responses = await Promise.all([
      evidencePlan(new Request(`http://localhost/api/evidence/plan?engagement_id=${validId}`)),
      evidenceRequests(new Request(`http://localhost/api/evidence/request?engagement_id=${validId}`)),
      createEvidencePackage(new Request('http://localhost/api/evidence/package', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engagementId: validId }),
      }) as never),
      createEvidenceRequest(new Request('http://localhost/api/evidence/request', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engagement_id: validId, plan_id: validId }),
      })),
    ]);

    expect(responses.map(response => response.status)).toEqual([403, 403, 403, 403]);
    expect(mocks.supabaseFrom).not.toHaveBeenCalled();
  });
});