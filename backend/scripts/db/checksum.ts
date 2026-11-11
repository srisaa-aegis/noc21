import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** SHA-256 of a file (hex), streamed. */
export function sha256(file: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolveHash(h.digest('hex')))
      .on('error', reject);
  });
}
