/**
 * The cluster scripts must work when invoked by root: PostgreSQL refuses to
 * run as root, so initdb / pg_ctl are wrapped in `runuser` as the cluster owner.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clusterOwner, osUserByName, osUserByUid, pgInvocation } from '../../scripts/pg/cluster.js';

describe('PostgreSQL cluster control when run as root', () => {
  const me = osUserByUid(process.getuid!())!;
  const postgres = osUserByName('postgres');

  it('does not change anything for an ordinary user', () => {
    expect(clusterOwner({ root: false })).toBeUndefined();
    expect(pgInvocation('/usr/bin/pg_ctl', ['-D', '/x', 'start'], undefined)).toEqual({
      command: '/usr/bin/pg_ctl',
      args: ['-D', '/x', 'start'],
    });
  });

  it('keeps the owner of an existing data directory (a cluster created by a normal user keeps working)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgdata-'));
    try {
      expect(statSync(dir).uid).toBe(me.uid);
      expect(clusterOwner({ root: true, dataDir: dir })?.name).toBe(me.name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!postgres)('falls back to the postgres OS user for a new cluster', () => {
    expect(clusterOwner({ root: true, dataDir: '/nonexistent/pgdata' })?.name).toBe('postgres');
  });

  it('honours PG_OS_USER for a new cluster', () => {
    expect(clusterOwner({ root: true, dataDir: '/nonexistent/pgdata', envUser: me.name })?.name).toBe(me.name);
  });

  it('wraps only the server binaries in runuser', () => {
    const owner = { name: 'postgres', uid: 101, gid: 103 };
    expect(pgInvocation('/usr/lib/postgresql/16/bin/pg_ctl', ['-D', '/d', 'start'], owner)).toEqual({
      command: 'runuser',
      args: ['-u', 'postgres', '--', '/usr/lib/postgresql/16/bin/pg_ctl', '-D', '/d', 'start'],
    });
    expect(pgInvocation('/usr/bin/initdb', ['-D', '/d'], owner).command).toBe('runuser');
    // Clients run as whoever calls them.
    expect(pgInvocation('/usr/bin/psql', ['-c', 'select 1'], owner).command).toBe('/usr/bin/psql');
    expect(pgInvocation('/usr/bin/pg_isready', [], owner).command).toBe('/usr/bin/pg_isready');
    expect(pgInvocation('/usr/bin/pg_dump', [], owner).command).toBe('/usr/bin/pg_dump');
  });
});
