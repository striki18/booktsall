/**
 * Mocked tests for app/api/check-register/route.ts
 * 
 * Tests cover:
 * - Unauthenticated request
 * - Missing realm
 * - Realm authorization
 * - Successful response and database error
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Mock dependencies at module boundaries
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(),
  getCurrentUser: vi.fn(),
  getUserRealmId: vi.fn(),
  getServerAuth: vi.fn(),
}));

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(),
      })),
    })),
  },
}));

vi.mock('next/server', () => ({
  NextRequest: vi.fn(),
  NextResponse: {
    json: vi.fn((body: any, init?: any) => ({ body, init })),
  },
}));

import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { NextResponse as MockNextResponse } from 'next/server';

// Import the route handler dynamically
let routeModule: any;

beforeEach(async () => {
  vi.clearAllMocks();
  
  // Reset NextResponse.json mock
  (MockNextResponse.json as any).mockImplementation((body: any, init?: any) => ({
    body,
    init: init || {},
    status: init?.status || 200,
    json: async () => body,
  }));

  // Import the route module fresh
  vi.resetModules();
  routeModule = await import('@/app/api/check-register/route');
});

afterEach(() => {
  vi.resetAllMocks();
});

const createMockRequest = (searchParams: Record<string, string> = {}) => {
  const params = new URLSearchParams(searchParams);
  const mockRequest = {
    method: 'GET',
    nextUrl: {
      searchParams: params,
    },
  };
  return mockRequest;
};

describe('app/api/check-register/route.ts - GET', () => {
  const mockUser = { id: 'user_123' };
  const mockRealmId = 'realm_123';

  describe('Authentication and Authorization', () => {
    it('should return 401 when unauthenticated', async () => {
      (requireAuth as any).mockRejectedValue(new Error('UNAUTHORIZED'));

      const request = createMockRequest();
      const response = await routeModule.GET(request);
      const json = await response.json();

      expect(response.status).toBe(401);
      expect(json.error).toBe('Unauthorized');
    });

    it('should return 400 when no realm ID', async () => {
      (requireAuth as any).mockRejectedValue(new Error('NO_REALM_ID'));

      const request = createMockRequest();
      const response = await routeModule.GET(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('No realm ID associated with user');
    });

    it('should return 403 when forbidden (different realm)', async () => {
      (requireAuth as any).mockRejectedValue(new Error('FORBIDDEN'));

      const request = createMockRequest();
      const response = await routeModule.GET(request);
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.error).toBe('Forbidden: Cannot access other realm data');
    });

    it('should return 403 when requested realmId differs from user realmId', async () => {
      (requireAuth as any).mockResolvedValue({ user: mockUser, realmId: mockRealmId });

      const request = createMockRequest({ realmId: 'different_realm' });
      const response = await routeModule.GET(request);
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.error).toBe('Forbidden: Cannot access other realm data');
    });
  });

  describe('Missing Realm', () => {
    it('should return 400 when no realmId in session and no query param', async () => {
      (requireAuth as any).mockResolvedValue({ user: mockUser, realmId: null });

      const request = createMockRequest();
      const response = await routeModule.GET(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('No realm ID available. Provide realmId query param or ensure session has realmId.');
    });

    it('should return 403 when session has no realmId but query param provided (cannot access other realm)', async () => {
      (requireAuth as any).mockResolvedValue({ user: mockUser, realmId: null });
      
      const request = createMockRequest({ realmId: 'param_realm' });
      const response = await routeModule.GET(request);
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.error).toBe('Forbidden: Cannot access other realm data');
    });
  });

  describe('Realm Authorization', () => {
    beforeEach(() => {
      (requireAuth as any).mockResolvedValue({ user: mockUser, realmId: mockRealmId });
    });

    it('should allow access when realmId matches user realm', async () => {
      const mockData = [
        { qbo_txn_id: '145', qbo_txn_date: '2023-01-15', register_state: 'MATCHED' },
        { qbo_txn_id: '146', qbo_txn_date: '2023-01-16', register_state: 'MISSING' },
      ];

      const mockEq = vi.fn().mockResolvedValue({ data: mockData, error: null });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
      (supabaseAdmin.from as any).mockImplementation(mockFrom);

      const request = createMockRequest({ realmId: mockRealmId });
      const response = await routeModule.GET(request);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(mockEq).toHaveBeenCalledWith('realm_id', mockRealmId);
      expect(json.totalRows).toBe(2);
    });
  });

  describe('Successful Response', () => {
    beforeEach(() => {
      (requireAuth as any).mockResolvedValue({ user: mockUser, realmId: mockRealmId });
    });

    it('should return 200 with register statistics', async () => {
      const mockData = [
        { qbo_txn_id: '145', qbo_txn_date: '2023-01-15', register_state: 'MATCHED' },
        { qbo_txn_id: '146', qbo_txn_date: '2023-01-16', register_state: 'MISSING' },
        { qbo_txn_id: '147', qbo_txn_date: '2023-01-17', register_state: 'MATCHED' },
      ];

      const mockEq = vi.fn().mockResolvedValue({ data: mockData, error: null });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
      (supabaseAdmin.from as any).mockImplementation(mockFrom);

      const request = createMockRequest({ realmId: mockRealmId });
      const response = await routeModule.GET(request);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.totalRows).toBe(3);
      expect(json.states).toEqual({ MATCHED: 2, MISSING: 1 });
      expect(json.transaction145).toEqual({ qbo_txn_id: '145', qbo_txn_date: '2023-01-15', register_state: 'MATCHED' });
      expect(json.allRows).toHaveLength(3);
      expect(json.allRows[0]).toEqual({ qbo_txn_id: '145', qbo_txn_date: '2023-01-15', register_state: 'MATCHED' });
    });

    it('should handle empty result set', async () => {
      const mockEq = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
      (supabaseAdmin.from as any).mockImplementation(mockFrom);

      const request = createMockRequest({ realmId: mockRealmId });
      const response = await routeModule.GET(request);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.totalRows).toBe(0);
      expect(json.states).toEqual({});
      expect(json.transaction145).toBeNull();
      expect(json.allRows).toEqual([]);
    });

    it('should handle transaction 145 as numeric', async () => {
      const mockData = [
        { qbo_txn_id: 145, qbo_txn_date: '2023-01-15', register_state: 'MATCHED' },
      ];

      const mockEq = vi.fn().mockResolvedValue({ data: mockData, error: null });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
      (supabaseAdmin.from as any).mockImplementation(mockFrom);

      const request = createMockRequest({ realmId: mockRealmId });
      const response = await routeModule.GET(request);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.transaction145).toEqual({ qbo_txn_id: 145, qbo_txn_date: '2023-01-15', register_state: 'MATCHED' });
    });
  });

  describe('Database Error', () => {
    beforeEach(() => {
      (requireAuth as any).mockResolvedValue({ user: mockUser, realmId: mockRealmId });
    });

    it('should return 500 when database query fails', async () => {
      const mockEq = vi.fn().mockResolvedValue({ 
        data: null, 
        error: { message: 'Database connection failed', code: 'CONNECTION_ERROR' } 
      });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
      (supabaseAdmin.from as any).mockImplementation(mockFrom);

      const request = createMockRequest({ realmId: mockRealmId });
      const response = await routeModule.GET(request);
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json.error).toBe('Database query failed');
    });

    it('should return 500 on unexpected database error', async () => {
      const mockEq = vi.fn().mockRejectedValue(new Error('Unexpected DB error'));
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
      (supabaseAdmin.from as any).mockImplementation(mockFrom);

      const request = createMockRequest({ realmId: mockRealmId });
      const response = await routeModule.GET(request);
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json.error).toBe('Internal server error');
    });
  });
});