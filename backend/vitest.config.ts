import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // backend/.env (all keys, not only VITE_*): the suites need TEST_DATABASE_URL
    // and the same settings as the API. Values already in the environment win.
    // Uploaded files of the suites go to a scratch directory, never to the development storage.
    env: { ...loadEnv('test', process.cwd(), ''), FS_STORAGE_ROOT: join(tmpdir(), 'noc-test-storage'), ...process.env } as Record<string, string>,
  },
});
