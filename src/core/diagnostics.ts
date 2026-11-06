export type RuleId =
  | 'SCHEMA'
  | 'NAME'
  | 'DUPLICATE'
  | 'DESCRIPTION'
  | 'TOOL'
  | 'SKILL-UNRESOLVED'
  | 'SKILL-COLLISION'
  | 'LOCK-STALE'
  | 'LICENSE-UNKNOWN'
  | 'LICENSE-DISALLOWED'
  | 'HASH-MISMATCH'
  | 'HARNESS-SYNTAX'
  | 'TARGET-FIELD'
  | 'DIST-STALE'
  | 'VERSION-NOT-BUMPED'
  | 'DROPPED-FEATURE'
  | 'SCRIPTS-NO-SHELL'
  | 'NO-LICENSE-TEXT';

export interface Diagnostic {
  path: string;
  line?: number;
  severity: 'error' | 'warning';
  rule: RuleId;
  message: string;
}

function make(
  severity: Diagnostic['severity'],
  rule: RuleId,
  path: string,
  message: string,
  line?: number,
): Diagnostic {
  const d: Diagnostic = { path, severity, rule, message };
  if (line !== undefined) d.line = line;
  return d;
}

export function error(rule: RuleId, path: string, message: string, line?: number): Diagnostic {
  return make('error', rule, path, message, line);
}

export function warning(rule: RuleId, path: string, message: string, line?: number): Diagnostic {
  return make('warning', rule, path, message, line);
}

/** `<path>[:<line>]: <error|warning> <RULE-ID>: <message>` */
export function formatDiagnostic(d: Diagnostic): string {
  const where = d.line === undefined ? d.path : `${d.path}:${d.line}`;
  return `${where}: ${d.severity} ${d.rule}: ${d.message}`;
}

/**
 * Sorts by path (plain string comparison, never locale-aware), then by line,
 * with diagnostics that have no line first. Returns a new array; the sort is
 * stable, so ties keep their input order.
 */
export function sortDiagnostics(ds: Diagnostic[]): Diagnostic[] {
  return [...ds].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

export function hasErrors(ds: Diagnostic[]): boolean {
  return ds.some((d) => d.severity === 'error');
}

/** Bad invocation, git failure, or other condition that maps to exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
