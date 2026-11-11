/**
 * Stored objects. The only table whose key is a UUID: the id is also part of
 * the storage key, so it must be unguessable and must not reveal a sequence.
 *
 * All metadata lives here; the storage layer itself handles opaque bytes, which
 * is what keeps the filesystem driver swappable for an S3 driver later.
 *
 * `uploaded_by` is declared without a typed reference (and gets its foreign key
 * in the migration) so that this module does not import identity.ts, which
 * imports this one.
 */
import { bigint, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { storageBackend } from './enums.js';

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storageBackend: storageBackend('storage_backend').notNull().default('fs'),
    bucket: text('bucket').notNull().default('noc'),
    storageKey: text('storage_key').notNull().unique(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksumSha256: text('checksum_sha256').notNull().default(''),
    uploadedBy: integer('uploaded_by'),
    scanStatus: text('scan_status').notNull().default('skipped'),
    scanAt: timestamp('scan_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('files_created_idx').on(t.createdAt)],
);
