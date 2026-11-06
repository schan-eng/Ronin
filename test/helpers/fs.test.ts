import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { enc, makeProject } from './fs.js';

describe('makeProject', () => {
  it('writes files, creating parent directories, under a tmpdir', async () => {
    const dir = await makeProject({ 'a/b.txt': 'x', 'run.sh': { content: '#!/bin/sh', executable: true } });
    expect(path.resolve(dir).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(await readFile(path.join(dir, 'a/b.txt'), 'utf8')).toBe('x');
    expect(await readFile(path.join(dir, 'run.sh'), 'utf8')).toBe('#!/bin/sh');
    expect((await stat(path.join(dir, 'run.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(path.join(dir, 'a/b.txt'))).mode & 0o111).toBe(0);
  });

  it('writes binary content verbatim', async () => {
    const bytes = new Uint8Array([0, 255, 10, 13, 128]);
    const dir = await makeProject({ 'bin/data.bin': { content: bytes } });
    expect(new Uint8Array(await readFile(path.join(dir, 'bin/data.bin')))).toEqual(bytes);
  });

  it('returns a fresh directory each call', async () => {
    const a = await makeProject({ 'f': '1' });
    const b = await makeProject({ 'f': '2' });
    expect(a).not.toBe(b);
  });

  it('accepts an empty file set', async () => {
    const dir = await makeProject({});
    expect((await stat(dir)).isDirectory()).toBe(true);
  });
});

describe('enc', () => {
  it('UTF-8 encodes a string', () => {
    expect(enc('aé')).toEqual(new Uint8Array([0x61, 0xc3, 0xa9]));
  });
});
