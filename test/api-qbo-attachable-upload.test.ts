import { describe, expect, it, vi } from 'vitest';

const mockUploadAttachable = vi.fn();
vi.mock('@/lib/quickbooks', () => ({
  uploadAttachable: mockUploadAttachable,
}));

import { POST } from '@/app/api/quickbooks/attachables/upload/route';

describe('QuickBooks attachment upload endpoint', () => {
  it('keeps QBO writes disabled for the pilot', async () => {
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/disabled/i);
    expect(mockUploadAttachable).not.toHaveBeenCalled();
  });
});