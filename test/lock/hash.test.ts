import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../../src/core/model.js';
import { hashSkillFiles } from '../../src/lock/hash.js';
import { enc } from '../helpers/fs.js';

const PINNED = '86b40829bf2ebc1f5849bd275577440eeecab5898326093a5322d7153d326a94';

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function sample(): FileEntry[] {
  return [
    { path: 'scripts/run.sh', bytes: enc('echo hi\n'), executable: true },
    { path: 'SKILL.md', bytes: enc('---\nname: a\ndescription: b\n---\nBody\n'), executable: false },
  ];
}

describe('hashSkillFiles', () => {
  it('matches the pinned digest (spec 5.8)', () => {
    expect(hashSkillFiles(sample())).toBe(PINNED);
  });

  it('does not depend on the order of the input', () => {
    expect(hashSkillFiles([...sample()].reverse())).toBe(PINNED);
  });

  it("does not reorder the caller's array", () => {
    const files = sample();
    hashSkillFiles(files);
    expect(files.map((f) => f.path)).toEqual(['scripts/run.sh', 'SKILL.md']);
  });

  it('changes when the executable bit of a file flips', () => {
    const files = sample();
    files[0] = { ...files[0]!, executable: false };
    expect(hashSkillFiles(files)).not.toBe(PINNED);
  });

  it('changes when one byte of a file changes', () => {
    const files = sample();
    files[0] = { ...files[0]!, bytes: enc('echo ho\n') };
    expect(hashSkillFiles(files)).not.toBe(PINNED);
  });

  it('changes when a file is renamed', () => {
    const files = sample();
    files[0] = { ...files[0]!, path: 'scripts/run2.sh' };
    expect(hashSkillFiles(files)).not.toBe(PINNED);
  });

  it('changes when a file is added', () => {
    const files = [...sample(), { path: 'LICENSE.txt', bytes: enc('MIT\n'), executable: false }];
    expect(hashSkillFiles(files)).not.toBe(PINNED);
  });

  it('sorts by plain string comparison, not locale order', () => {
    // Plain order puts 'B' (code unit 66) before 'a' (97); a locale sort would put 'a' first.
    const a: FileEntry = { path: 'a', bytes: enc('1'), executable: false };
    const b: FileEntry = { path: 'B', bytes: enc('2'), executable: false };
    const expected = sha256(`B\0` + `0\0${sha256('2')}\n` + `a\0` + `0\0${sha256('1')}\n`);
    expect(hashSkillFiles([a, b])).toBe(expected);
    expect(hashSkillFiles([b, a])).toBe(expected);
  });

  it('hashes no files to the SHA-256 of the empty string', () => {
    expect(hashSkillFiles([])).toBe(sha256(''));
  });
});
