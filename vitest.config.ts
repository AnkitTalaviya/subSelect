import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@content': fileURLToPath(new URL('./src/content', import.meta.url)),
    },
  },
  test: {
    // Phase 1 tests cover pure logic only, so no jsdom dependency is needed.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
