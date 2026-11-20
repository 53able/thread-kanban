import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/ui-dom/**', '**/node_modules/**'],
          globalSetup: ['tests/global-setup.ts'],
        },
      },
      {
        extends: true,
        oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
        test: {
          name: 'dom',
          include: ['tests/ui-dom/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
        },
      },
    ],
  },
});
