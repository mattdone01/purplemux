import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    globals: false,
    // HOME is a temporary root for every test process; the run fails if a test
    // process writes into the real ~/.purplemux/logs (see the setup files).
    globalSetup: ['tests/setup/isolated-home.ts'],
    setupFiles: ['tests/setup/record-pid.ts'],
  },
});
