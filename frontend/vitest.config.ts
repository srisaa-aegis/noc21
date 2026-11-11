import { defineConfig } from 'vitest/config';

/**
 * Extra options for the Angular unit-test builder (angular.json → runnerConfig).
 * Component tests render real pages against the fixture data; on a loaded
 * machine a few of them need more than Vitest's default 5 s.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
