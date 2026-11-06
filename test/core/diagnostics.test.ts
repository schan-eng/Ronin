import { describe, expect, it } from 'vitest';
import {
  UsageError,
  error,
  formatDiagnostic,
  hasErrors,
  sortDiagnostics,
  warning,
} from '../../src/core/diagnostics.js';

describe('diagnostics', () => {
  it('builds error and warning diagnostics', () => {
    expect(error('NAME', 'a', 'msg', 4)).toEqual({
      path: 'a',
      line: 4,
      severity: 'error',
      rule: 'NAME',
      message: 'msg',
    });
    const w = warning('DROPPED-FEATURE', 'b', 'msg');
    expect(w.severity).toBe('warning');
    expect(w.line).toBeUndefined();
  });

  it('formats a diagnostic with a line number', () => {
    expect(
      formatDiagnostic(error('TOOL', 'packs/web/agents/a.md', 'unknown tool "fly"', 3)),
    ).toBe('packs/web/agents/a.md:3: error TOOL: unknown tool "fly"');
  });

  it('formats a diagnostic without a line number', () => {
    expect(formatDiagnostic(warning('DROPPED-FEATURE', 'ronin.lock', 'x'))).toBe(
      'ronin.lock: warning DROPPED-FEATURE: x',
    );
  });

  it('sorts by path, then line (no line first), without mutating the input', () => {
    const input = [error('NAME', 'b', ''), error('NAME', 'a', '', 5), error('NAME', 'a', '')];
    const sorted = sortDiagnostics(input);
    expect(sorted.map((d) => [d.path, d.line])).toEqual([
      ['a', undefined],
      ['a', 5],
      ['b', undefined],
    ]);
    expect(input.map((d) => [d.path, d.line])).toEqual([
      ['b', undefined],
      ['a', 5],
      ['a', undefined],
    ]);
  });

  it('sorts paths by plain string comparison, not locale', () => {
    const sorted = sortDiagnostics([error('NAME', 'a', ''), error('NAME', 'B', '')]);
    expect(sorted.map((d) => d.path)).toEqual(['B', 'a']);
  });

  it('orders by line numerically', () => {
    const sorted = sortDiagnostics([error('NAME', 'a', '', 10), error('NAME', 'a', '', 9)]);
    expect(sorted.map((d) => d.line)).toEqual([9, 10]);
  });

  it('reports whether any diagnostic is an error', () => {
    expect(hasErrors([warning('NAME', 'a', '')])).toBe(false);
    expect(hasErrors([error('NAME', 'a', '')])).toBe(true);
    expect(hasErrors([])).toBe(false);
  });

  it('exposes UsageError as an Error subclass', () => {
    const e = new UsageError('bad flag');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(UsageError);
    expect(e.message).toBe('bad flag');
    expect(e.name).toBe('UsageError');
  });
});
