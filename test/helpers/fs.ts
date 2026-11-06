import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ProjectFile = string | { content: string | Uint8Array; executable?: boolean };

/**
 * Writes `files` (keys are `/`-separated paths relative to the project root,
 * parent directories created as needed) under a fresh directory in
 * `os.tmpdir()` and returns that directory. `executable: true` sets mode 0755;
 * every other file gets 0644.
 */
export async function makeProject(files: Record<string, ProjectFile>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ronin-test-'));
  for (const [rel, spec] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    const { content, executable } = typeof spec === 'string' ? { content: spec, executable: false } : spec;
    await writeFile(abs, content);
    await chmod(abs, executable ? 0o755 : 0o644);
  }
  return root;
}

/** UTF-8 encode. */
export function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
