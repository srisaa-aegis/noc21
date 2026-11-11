import { defineConfig } from 'drizzle-kit';
import { config } from './src/config/env.js';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: config().databaseUrl },
  casing: 'snake_case',
  verbose: true,
  strict: false,
});
