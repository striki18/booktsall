import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});