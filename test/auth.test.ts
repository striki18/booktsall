import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();
const mockCookies = {
  getAll: vi.fn(() => []),
  set: vi.fn(),
};

vi.mock('next/headers', () => ({
  cookies: vi.fn(),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

import { cookies } from 'next/headers';
import { requireAuth } from '@/lib/auth';

const userWithRealm = {
  id: 'user-1',
  user_metadata: {},
  app_metadata: { realm_id: 'realm-1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  (cookies as any).mockResolvedValue(mockCookies);
});

describe('requireAuth', () => {
  it('validates the user through Supabase Auth', async () => {
    mockGetUser.mockResolvedValue({ data: { user: userWithRealm }, error: null });

    await expect(requireAuth()).resolves.toEqual({ user: userWithRealm, realmId: 'realm-1' });
    expect(mockGetUser).toHaveBeenCalledOnce();
  });

  it('rejects a missing user', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(requireAuth()).rejects.toThrow('UNAUTHORIZED');
  });

  it('does not trust a user-editable user_metadata realm binding', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', user_metadata: { realm_id: 'realm-1' }, app_metadata: {} } }, error: null });

    await expect(requireAuth()).rejects.toThrow('NO_REALM_ID');
  });
  it('rejects a caller-supplied realm when the user has no realm binding', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', user_metadata: {}, app_metadata: {} } }, error: null });

    await expect(requireAuth({ realmId: 'realm-1' })).rejects.toThrow('NO_REALM_ID');
  });

  it('rejects a realm that differs from the authenticated realm', async () => {
    mockGetUser.mockResolvedValue({ data: { user: userWithRealm }, error: null });

    await expect(requireAuth({ realmId: 'realm-2' })).rejects.toThrow('FORBIDDEN');
  });

  it('allows only the authenticated realm', async () => {
    mockGetUser.mockResolvedValue({ data: { user: userWithRealm }, error: null });

    await expect(requireAuth({ realmId: 'realm-1' })).resolves.toEqual({ user: userWithRealm, realmId: 'realm-1' });
  });
});