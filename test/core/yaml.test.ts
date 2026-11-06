import { describe, expect, it } from 'vitest';
import { ParseError, parseFrontmatter, parseYaml } from '../../src/core/yaml.js';

function parseError(fn: () => unknown): ParseError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ParseError);
    return e as ParseError;
  }
  throw new Error('expected a ParseError, but nothing was thrown');
}

describe('ParseError', () => {
  it('is an Error that carries a line number', () => {
    const e = new ParseError('boom', 7);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ParseError');
    expect(e.message).toBe('boom');
    expect(e.line).toBe(7);
  });
});

describe('parseYaml', () => {
  it('parses data and reports 1-based line numbers by path', () => {
    const y = parseYaml('a: 1\nb:\n  c: 2\n');
    expect(y.data).toEqual({ a: 1, b: { c: 2 } });
    expect(y.lineOf(['a'])).toBe(1);
    expect(y.lineOf(['b', 'c'])).toBe(3);
  });

  it('reports the line of a key whose value is a block collection', () => {
    const y = parseYaml('a: 1\nb:\n  c: 2\ntools:\n  - read\n  - fly\n');
    expect(y.lineOf(['b'])).toBe(2);
    expect(y.lineOf(['tools'])).toBe(4);
    expect(y.lineOf(['tools', 0])).toBe(5);
    expect(y.lineOf(['tools', 1])).toBe(6);
  });

  it('reports the line of a key whose value is a multi-line scalar', () => {
    const y = parseYaml('name: a\ndescription: |\n  one\n  two\nlicense: MIT\n');
    expect(y.lineOf(['description'])).toBe(2);
    expect(y.lineOf(['license'])).toBe(5);
  });

  it('returns undefined for a path that does not exist', () => {
    const y = parseYaml('a: 1\nb:\n  c: 2\n');
    expect(y.lineOf(['zzz'])).toBeUndefined();
    expect(y.lineOf(['b', 'zzz'])).toBeUndefined();
    expect(y.lineOf(['a', 'c'])).toBeUndefined();
    expect(y.lineOf(['b', 0])).toBeUndefined();
  });

  it('reports line 1 for the root of a document that starts on line 1', () => {
    expect(parseYaml('a: 1\n').lineOf([])).toBe(1);
  });

  it('parses an empty document as null', () => {
    const y = parseYaml('');
    expect(y.data).toBeNull();
    expect(y.lineOf([])).toBeUndefined();
    expect(y.lineOf(['a'])).toBeUndefined();
  });

  it('parses top-level sequences and scalars', () => {
    expect(parseYaml('- a\n- b\n').data).toEqual(['a', 'b']);
    expect(parseYaml('- a\n- b\n').lineOf([1])).toBe(2);
    expect(parseYaml('just text\n').data).toBe('just text');
  });

  it('parses a UTF-8 BOM and CRLF line endings like LF', () => {
    const lf = parseYaml('a: 1\nb:\n  c: 2\n');
    const crlf = parseYaml('﻿a: 1\r\nb:\r\n  c: 2\r\n');
    expect(crlf.data).toEqual(lf.data);
    expect(crlf.lineOf(['a'])).toBe(1);
    expect(crlf.lineOf(['b', 'c'])).toBe(3);
  });

  it('keeps CRLF out of multi-line string values', () => {
    const y = parseYaml('d: |\r\n  one\r\n  two\r\n');
    expect(y.data).toEqual({ d: 'one\ntwo\n' });
  });

  it('throws ParseError on malformed YAML', () => {
    expect(() => parseYaml('a: [1,\n')).toThrow(ParseError);
  });

  it('reports the 1-based line of the error', () => {
    expect(parseError(() => parseYaml('a: 1\na: 2\n')).line).toBe(2);
    expect(parseError(() => parseYaml('a: 1\nb: 2\nc: "x\n')).line).toBe(4);
  });

  it('keeps the error message to one line, without the YAML code frame', () => {
    const e = parseError(() => parseYaml('a: 1\na: 2\n'));
    expect(e.message).toBe('Map keys must be unique');
  });

  it('rejects a source with more than one document', () => {
    const e = parseError(() => parseYaml('a: 1\n---\nb: 2\n'));
    expect(e.line).toBe(2);
  });

  it('throws ParseError on an unresolved alias', () => {
    const e = parseError(() => parseYaml('a: *missing\n'));
    expect(e.message).toMatch(/alias/i);
    expect(e.line).toBe(1);
  });

  it('throws ParseError, not a raw exception, on an alias bomb', () => {
    const lines = ['a0: &a0 [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 12; i++) {
      const prev = `*a${i - 1}`;
      lines.push(`a${i}: &a${i} [${Array(10).fill(prev).join(', ')}]`);
    }
    parseError(() => parseYaml(`${lines.join('\n')}\n`));
  });
});

describe('parseFrontmatter', () => {
  it('splits data from body and offsets line numbers for the opening delimiter', () => {
    const fm = parseFrontmatter('---\nname: a\ndescription: b\n---\nBody\n');
    expect(fm.data).toEqual({ name: 'a', description: 'b' });
    expect(fm.body).toBe('Body\n');
    expect(fm.lineOf(['name'])).toBe(2);
    expect(fm.lineOf(['description'])).toBe(3);
    expect(fm.lineOf(['zzz'])).toBeUndefined();
  });

  it('offsets line numbers of nested keys and sequence items', () => {
    const fm = parseFrontmatter('---\nname: a\ntools:\n  - read\n  - fly\n---\nBody\n');
    expect(fm.lineOf(['tools'])).toBe(3);
    expect(fm.lineOf(['tools', 1])).toBe(5);
  });

  it('parses a UTF-8 BOM and CRLF line endings like LF', () => {
    const crlf = parseFrontmatter('﻿---\r\nname: a\r\ndescription: b\r\n---\r\nBody\r\nMore\r\n');
    expect(crlf.data).toEqual({ name: 'a', description: 'b' });
    expect(crlf.body).toBe('Body\nMore\n');
    expect(crlf.lineOf(['description'])).toBe(3);

    const small = parseFrontmatter('﻿---\r\nname: a\r\n---\r\nBody\r\n');
    expect(small.data).toEqual({ name: 'a' });
    expect(small.body).toBe('Body\n');
  });

  it('allows trailing whitespace after the delimiters', () => {
    const fm = parseFrontmatter('--- \t\nname: a\n---  \nBody\n');
    expect(fm.data).toEqual({ name: 'a' });
    expect(fm.body).toBe('Body\n');
  });

  it('ends the frontmatter at the first closing delimiter and leaves later ones in the body', () => {
    const fm = parseFrontmatter('---\nname: a\n---\nIntro\n\n---\n\nOutro\n---\n');
    expect(fm.data).toEqual({ name: 'a' });
    expect(fm.body).toBe('Intro\n\n---\n\nOutro\n---\n');
  });

  it('does not treat indented or longer dashes as a delimiter', () => {
    const fm = parseFrontmatter('---\ntext: |\n  one\n  ---\n  two\nother: ----\n---\nBody\n');
    expect(fm.data).toEqual({ text: 'one\n---\ntwo\n', other: '----' });
    expect(fm.body).toBe('Body\n');
  });

  it('gives an empty body when the closing delimiter ends the file', () => {
    expect(parseFrontmatter('---\nname: a\n---\n').body).toBe('');
    expect(parseFrontmatter('---\nname: a\n---').body).toBe('');
  });

  it('preserves body text exactly, including leading blank lines', () => {
    expect(parseFrontmatter('---\nname: a\n---\n\n\nBody  \n').body).toBe('\n\nBody  \n');
  });

  it('parses empty frontmatter as null data', () => {
    const fm = parseFrontmatter('---\n---\nBody\n');
    expect(fm.data).toBeNull();
    expect(fm.body).toBe('Body\n');
    expect(fm.lineOf(['name'])).toBeUndefined();
  });

  it('throws ParseError at line 1 when there is no frontmatter', () => {
    expect(() => parseFrontmatter('no frontmatter')).toThrow(ParseError);
    expect(parseError(() => parseFrontmatter('no frontmatter')).line).toBe(1);
    expect(parseError(() => parseFrontmatter('')).line).toBe(1);
    expect(parseError(() => parseFrontmatter('\nname: a\n---\n')).line).toBe(1);
    expect(parseError(() => parseFrontmatter('----\nname: a\n---\n')).line).toBe(1);
  });

  it('throws ParseError at line 1 when the closing delimiter is missing', () => {
    const e = parseError(() => parseFrontmatter('---\nname: a\nBody\n'));
    expect(e.line).toBe(1);
    expect(e.message).toMatch(/closing/i);
    expect(parseError(() => parseFrontmatter('---')).line).toBe(1);
  });

  it('reports YAML errors with file line numbers', () => {
    const e = parseError(() => parseFrontmatter('---\nname: a\nname: b\n---\nBody\n'));
    expect(e.line).toBe(3);
    expect(e.message).toBe('Map keys must be unique');
  });

  it('reports YAML errors with file line numbers under CRLF', () => {
    const e = parseError(() => parseFrontmatter('﻿---\r\nname: a\r\nname: b\r\n---\r\nBody\r\n'));
    expect(e.line).toBe(3);
  });

  it('throws ParseError on malformed YAML in the frontmatter', () => {
    expect(() => parseFrontmatter('---\na: [1,\n---\nBody\n')).toThrow(ParseError);
  });

  it('round-trips YAML-significant text in values', () => {
    const fm = parseFrontmatter('---\ndescription: "Finds bugs: fast # really"\n---\n');
    expect(fm.data).toEqual({ description: 'Finds bugs: fast # really' });
  });
});
