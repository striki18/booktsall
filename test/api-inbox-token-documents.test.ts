import { describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({})),
}));

import { GET } from '@/app/api/inbox/[token]/documents/route';

describe('public inbox document listing', () => {
  it('does not expose earlier submissions or document downloads', async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(405);
    expect(body.error).toMatch(/not available through public upload links/i);
  });
});