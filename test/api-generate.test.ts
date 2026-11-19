/**
 * Mocked tests for app/api/generate/route.ts
 * 
 * Tests cover:
 * - Invalid and missing inputs
 * - Date validation
 * - Successful pipeline response
 * - Pipeline failure and structured error response
 * - Authentication and authorization errors
 * - Company ID validation against backend QuickBooks realm
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

vi.mock('@/lib/pipeline', () => ({
  generatePackage: vi.fn(),
}));

vi.mock('@/lib/quickbooks', () => ({
  getStoredToken: vi.fn(),
}));

vi.mock('@/lib/package-persistence', () => ({
  persistPipelinePackage: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('mock-zip-bytes')) ,
}));

vi.mock('next/server', () => ({
  NextRequest: vi.fn(),
  NextResponse: {
    json: vi.fn((body: any, init?: any) => ({ body, init })),
  },
}));

import { requireAuth } from '@/lib/auth';
import { generatePackage } from '@/lib/pipeline';
import { getStoredToken } from '@/lib/quickbooks';
import { persistPipelinePackage } from '@/lib/package-persistence';
import { NextResponse as MockNextResponse } from 'next/server';

// Import the route handler dynamically
let routeModule: any;

beforeEach(async () => {
  vi.clearAllMocks();
  (persistPipelinePackage as any).mockResolvedValue({ id: 'package-1', realm_id: 'test_realm_123', status: 'complete', zip_path: 'packages/test_realm_123/package-1/AuditPackage.zip', filename: 'AuditPackage.zip', created_at: '2026-11-13T00:00:00Z' });
  
  // Reset NextResponse.json mock
  (MockNextResponse.json as any).mockImplementation((body: any, init?: any) => ({
    body,
    init: init || {},
    status: init?.status || 200,
    json: async () => body,
  }));

  // Import the route module fresh
  vi.resetModules();
  routeModule = await import('@/app/api/generate/route');
});

afterEach(() => {
  vi.resetAllMocks();
});

const createMockRequest = (body: any, method = 'POST') => {
  const mockRequest = {
    method,
    json: vi.fn().mockResolvedValue(body),
    nextUrl: {
      searchParams: new URLSearchParams(),
    },
  };
  return mockRequest;
};

describe('app/api/generate/route.ts - POST', () => {
  const validBody = {
    companyId: 'test_realm_123',
    startDate: '2023-01-01',
    endDate: '2023-12-31',
  };

  describe('Invalid and Missing Inputs', () => {
    beforeEach(() => {
      (requireAuth as any).mockResolvedValue({ user: { id: 'user-1' }, realmId: 'test_realm_123' });
      // Mock getStoredToken to return matching realm for these tests
      (getStoredToken as any).mockResolvedValue({ realm_id: 'test_realm_123', access_token: 'token' });
    });

    it('should return 400 when companyId is missing', async () => {
      const request = createMockRequest({ startDate: '2023-01-01', endDate: '2023-12-31' });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('companyId is required and must be a non-empty string');
    });

    it('should return 400 when companyId is empty string', async () => {
      const request = createMockRequest({ companyId: '', startDate: '2023-01-01', endDate: '2023-12-31' });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('companyId is required and must be a non-empty string');
    });

    it('should return 400 when companyId is whitespace only', async () => {
      const request = createMockRequest({ companyId: '   ', startDate: '2023-01-01', endDate: '2023-12-31' });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('companyId is required and must be a non-empty string');
    });

    it('should return 400 when startDate is missing', async () => {
      const request = createMockRequest({ companyId: 'test_realm_123', endDate: '2023-12-31' });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('startDate is required and must be a string in YYYY-MM-DD format');
    });

    it('should return 400 when endDate is missing', async () => {
      const request = createMockRequest({ companyId: 'test_realm_123', startDate: '2023-01-01' });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('endDate is required and must be a string in YYYY-MM-DD format');
    });

    it('should return 400 when request body is invalid JSON', async () => {
      const mockRequest = {
        method: 'POST',
        json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
        nextUrl: { searchParams: new URLSearchParams() },
      };
      const response = await routeModule.POST(mockRequest);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('Invalid JSON in request body');
    });

    it('should return 405 for non-POST methods', async () => {
      const mockRequest = { method: 'GET', nextUrl: { searchParams: new URLSearchParams() } };
      const response = await routeModule.GET(mockRequest);
      const json = await response.json();

      expect(response.status).toBe(405);
      expect(json.error).toBe('Method not allowed. Use POST.');
    });
  });

  describe('Date Validation', () => {
    beforeEach(() => {
      (requireAuth as any).mockResolvedValue({ user: { id: 'user-1' }, realmId: 'test_realm_123' });
      // Mock getStoredToken to return matching realm for these tests
      (getStoredToken as any).mockResolvedValue({ realm_id: 'test_realm_123', access_token: 'token' });
    });

    it('should return 400 when startDate format is invalid', async () => {
      const request = createMockRequest({ 
        companyId: 'test_realm_123', 
        startDate: '01-01-2023', 
        endDate: '2023-12-31' 
      });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('startDate must be in YYYY-MM-DD format');
    });

    it('should return 400 when endDate format is invalid', async () => {
      const request = createMockRequest({ 
        companyId: 'test_realm_123', 
        startDate: '2023-01-01', 
        endDate: '12-31-2023' 
      });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('endDate must be in YYYY-MM-DD format');
    });

    it('should return 400 when startDate is not a valid date', async () => {
      const request = createMockRequest({ 
        companyId: 'test_realm_123', 
        startDate: '2023-13-45', 
        endDate: '2023-12-31' 
      });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('startDate is not a valid date');
    });

    it('should return 400 when endDate is not a valid date', async () => {
      const request = createMockRequest({ 
        companyId: 'test_realm_123', 
        startDate: '2023-01-01', 
        endDate: '2023-13-45' 
      });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('endDate is not a valid date');
    });

    it('should return 400 when startDate > endDate', async () => {
      const request = createMockRequest({ 
        companyId: 'test_realm_123', 
        startDate: '2023-12-31', 
        endDate: '2023-01-01' 
      });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe('startDate must be less than or equal to endDate');
    });

    it('should accept valid dates with startDate === endDate', async () => {
      (generatePackage as any).mockResolvedValue({
        success: true,
        zipPath: '/tmp/test.zip',
        stats: {
          transactionCount: 0,
          attachableCount: 0,
          matchedCount: 0,
          missingCount: 0,
          successfulDownloadCount: 0,
          failedDownloadCount: 0,
          zipSizeBytes: 1024,
          elapsedTimeMs: 100,
        },
      });

      const request = createMockRequest({ 
        companyId: 'test_realm_123', 
        startDate: '2023-06-15', 
        endDate: '2023-06-15' 
      });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.success).toBe(true);
    });
  });

  describe('Successful Pipeline Response', () => {
    beforeEach(() => {
      (requireAuth as any).mockResolvedValue({ user: { id: 'user-1' }, realmId: 'test_realm_123' });
      // Mock getStoredToken to return matching realm for these tests
      (getStoredToken as any).mockResolvedValue({ realm_id: 'test_realm_123', access_token: 'token' });
    });

    it('should return 200 with package info on success', async () => {
      (generatePackage as any).mockResolvedValue({
        success: true,
        zipPath: '/tmp/audit_package_20230101_20231231.zip',
        stats: {
          transactionCount: 10,
          attachableCount: 5,
          matchedCount: 4,
          missingCount: 6,
          successfulDownloadCount: 4,
          failedDownloadCount: 0,
          zipSizeBytes: 2048576,
          elapsedTimeMs: 5000,
        },
      });

      const request = createMockRequest(validBody);
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.completionStatus).toBe('complete');
      expect(json.packagePath).toBe('packages/test_realm_123/package-1/AuditPackage.zip');
      expect(json.packageId).toBe('package-1');
      expect(json.packageName).toBe('AuditPackage.zip');
      expect(json.stats.transactionCount).toBe(10);
      expect(json.stats.matchedCount).toBe(4);
      expect(json.stats.missingCount).toBe(6);
      expect(generatePackage).toHaveBeenCalledWith('test_realm_123', '2023-01-01', '2023-12-31');
    });

    it('reports partial completion when downloads failed but a ZIP was generated', async () => {
      (generatePackage as any).mockResolvedValue({
        success: true,
        zipPath: '/tmp/partial.zip',
        stats: { transactionCount: 1, attachableCount: 1, matchedCount: 1, missingCount: 0, successfulDownloadCount: 0, failedDownloadCount: 1, zipSizeBytes: 120, elapsedTimeMs: 20 },
      });
      const response = await routeModule.POST(createMockRequest(validBody));
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.completionStatus).toBe('partial');
    });
    it('should trim companyId before passing to pipeline', async () => {
      (generatePackage as any).mockResolvedValue({
        success: true,
        zipPath: '/tmp/test.zip',
        stats: {
          transactionCount: 0,
          attachableCount: 0,
          matchedCount: 0,
          missingCount: 0,
          successfulDownloadCount: 0,
          failedDownloadCount: 0,
          zipSizeBytes: 1024,
          elapsedTimeMs: 100,
        },
      });

      const request = createMockRequest({ 
        companyId: '  test_realm_123  ', 
        startDate: '2023-01-01', 
        endDate: '2023-12-31' 
      });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(generatePackage).toHaveBeenCalledWith('test_realm_123', '2023-01-01', '2023-12-31');
    });
  });

  describe('Pipeline Failure and Structured Error Response', () => {
    beforeEach(() => {
      (requireAuth as any).mockResolvedValue({ user: { id: 'user-1' }, realmId: 'test_realm_123' });
      // Mock getStoredToken to return matching realm for these tests
      (getStoredToken as any).mockResolvedValue({ realm_id: 'test_realm_123', access_token: 'token' });
    });

    it('should return 500 with structured error when pipeline fails', async () => {
      (generatePackage as any).mockResolvedValue({
        success: false,
        error: {
          stage: 'Transaction Retrieval',
          reason: 'Failed to retrieve transactions',
          details: 'Invalid token',
        },
        stats: {
          transactionCount: 0,
          attachableCount: 0,
          matchedCount: 0,
          missingCount: 0,
          successfulDownloadCount: 0,
          failedDownloadCount: 0,
          zipSizeBytes: 0,
          elapsedTimeMs: 100,
        },
      });

      const request = createMockRequest(validBody);
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json.success).toBe(false);
      expect(json.error.stage).toBe('Transaction Retrieval');
      expect(json.error.reason).toBe('Failed to retrieve transactions');
      expect(json.error.details).toBe('[redacted]');
      expect(json.stats).toBeDefined();
    });

    it('should return 500 with default error when pipeline returns minimal error', async () => {
      (generatePackage as any).mockResolvedValue({
        success: false,
        error: {},
        stats: {
          transactionCount: 0,
          attachableCount: 0,
          matchedCount: 0,
          missingCount: 0,
          successfulDownloadCount: 0,
          failedDownloadCount: 0,
          zipSizeBytes: 0,
          elapsedTimeMs: 100,
        },
      });

      const request = createMockRequest(validBody);
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json.success).toBe(false);
      expect(json.error.stage).toBe('Pipeline');
      expect(json.error.reason).toBe('Pipeline execution failed');
      expect(json.error.details).toBeUndefined();
    });

    it('should return 500 when generatePackage throws unexpectedly', async () => {
      (generatePackage as any).mockRejectedValue(new Error('Unexpected error'));

      const request = createMockRequest(validBody);
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json.success).toBe(false);
      expect(json.error.stage).toBe('API');
      expect(json.error.reason).toBe('Internal server error during package generation');
      expect(json.error.details).toBe('[redacted]');
    });
  });

  describe('All HTTP Methods Disabled Except POST', () => {
    it('should return 405 for GET', async () => {
      const mockRequest = { method: 'GET', nextUrl: { searchParams: new URLSearchParams() } };
      const response = await routeModule.GET(mockRequest);
      const json = await response.json();

      expect(response.status).toBe(405);
    });

    it('should return 405 for PUT', async () => {
      const mockRequest = { method: 'PUT', nextUrl: { searchParams: new URLSearchParams() } };
      const response = await routeModule.PUT(mockRequest);
      const json = await response.json();

      expect(response.status).toBe(405);
    });

    it('should return 405 for DELETE', async () => {
      const mockRequest = { method: 'DELETE', nextUrl: { searchParams: new URLSearchParams() } };
      const response = await routeModule.DELETE(mockRequest);
      const json = await response.json();

      expect(response.status).toBe(405);
    });

    it('should return 405 for PATCH', async () => {
      const mockRequest = { method: 'PATCH', nextUrl: { searchParams: new URLSearchParams() } };
      const response = await routeModule.PATCH(mockRequest);
      const json = await response.json();

      expect(response.status).toBe(405);
    });
  });

  describe('Authenticated Company ID Validation Against QuickBooks Realm', () => {
    beforeEach(() => {
      // Mock requireAuth to pass auth (not testing auth here)
      (requireAuth as any).mockResolvedValue({ user: { id: 'user-1' }, realmId: 'test_realm_123' });
      // Mock successful pipeline to isolate companyId validation
      (generatePackage as any).mockResolvedValue({
        success: true,
        zipPath: '/tmp/test.zip',
        stats: {
          transactionCount: 0,
          attachableCount: 0,
          matchedCount: 0,
          missingCount: 0,
          successfulDownloadCount: 0,
          failedDownloadCount: 0,
          zipSizeBytes: 1024,
          elapsedTimeMs: 100,
        },
      });
    });

    it('should return 200 when companyId matches backend realmId', async () => {
      // Backend has realm 'test_realm_123' stored
      (getStoredToken as any).mockResolvedValue({ realm_id: 'test_realm_123', access_token: 'token' });

      const request = createMockRequest(validBody);
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.success).toBe(true);
      expect(getStoredToken).toHaveBeenCalledWith('test_realm_123');
    });

    it('should return 403 when companyId does not match the authenticated realm', async () => {
      (requireAuth as any).mockResolvedValue({ user: {}, realmId: 'backend_realm_456' });

      const request = createMockRequest(validBody);
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.error).toBe('companyId does not match connected QuickBooks realm');
      expect(getStoredToken).not.toHaveBeenCalled();
      expect(generatePackage).not.toHaveBeenCalled();
    });

    it('should reject anonymous requests before looking up tokens or generating packages', async () => {
      (requireAuth as any).mockRejectedValue(new Error('UNAUTHORIZED'));

      const request = createMockRequest(validBody);
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(401);
      expect(json.error).toBe('Authentication required');
      expect(getStoredToken).not.toHaveBeenCalled();
      expect(generatePackage).not.toHaveBeenCalled();
    });
    it('should return 403 when no QuickBooks connection is stored in backend', async () => {
      // No stored token (null = no QuickBooks connection)
      (getStoredToken as any).mockResolvedValue(null);

      const request = createMockRequest(validBody);
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.error).toBe('No QuickBooks connection found for this backend');
    });

    it('should return 403 when the realm-scoped token has no realm_id', async () => {
      // Token exists but realm_id is missing
      (getStoredToken as any).mockResolvedValue({ access_token: 'token' });

      const request = createMockRequest(validBody);
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.error).toBe('No QuickBooks connection found for this backend');
    });

    it('should trim companyId before comparing with backend realmId', async () => {
      // Backend has realm 'test_realm_123', frontend sends with whitespace
      (getStoredToken as any).mockResolvedValue({ realm_id: 'test_realm_123', access_token: 'token' });

      const request = createMockRequest({ 
        companyId: '  test_realm_123  ', 
        startDate: '2023-01-01', 
        endDate: '2023-12-31' 
      });
      const response = await routeModule.POST(request);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.success).toBe(true);
    });

    it('should NOT use INTUIT_REALM_ID as fallback when different realm is connected', async () => {
      // Environment has INTUIT_REALM_ID='env_realm_789' but backend has 'backend_realm_456'
      // Frontend sends 'env_realm_789' (matching env var, NOT backend)
      (getStoredToken as any).mockResolvedValue({ realm_id: 'backend_realm_456', access_token: 'token' });

      const request = createMockRequest({ 
        companyId: 'env_realm_789',  // Matches env var but NOT backend stored realm
        startDate: '2023-01-01', 
        endDate: '2023-12-31' 
      });
      const response = await routeModule.POST(request);
      const json = await response.json();

      // Should be 403 because backend realm (backend_realm_456) doesn't match frontend (env_realm_789)
      expect(response.status).toBe(403);
      expect(json.error).toBe('companyId does not match connected QuickBooks realm');
    });
  });
});
