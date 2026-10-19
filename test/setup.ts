// Test setup file for Vitest
// This file runs before all tests

import { vi } from 'vitest';

// Mock environment variables if needed
vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

// Suppress console.log during tests unless DEBUG is set
if (!process.env.DEBUG) {
  global.console.log = vi.fn();
  global.console.info = vi.fn();
  global.console.debug = vi.fn();
}