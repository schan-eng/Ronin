import { LineCounter, isMap, isNode, isScalar, parseDocument } from 'yaml';
import type { Document } from 'yaml';

/** Malformed YAML or frontmatter. `line` is 1-based within the whole file. */
export class ParseError extends Error {
  line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
  }
}

type Path = (string | number)[];
type Range = [number, number, number];

export interface ParsedYaml {
  data: unknown;
  /** 1-based line of the key (or sequence item) at `path`; undefined if there is none. */
  lineOf(path: Path): number | undefined;
}

export interface ParsedFrontmatter extends ParsedYaml {
  body: string;
}

/** Strips a leading UTF-8 BOM and turns CRLF into LF. */
function normalize(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n/g, '\n');
}

/** The yaml package appends ` at line N, column M:` and a code frame to its messages. */
function shortMessage(message: string): string {
  return message.replace(/ at line \d+, column \d+:[\s\S]*$/, '');
}

/**
 * Where a path starts. A map entry is located by its key, so a key whose value
 * is a block collection reports the key's line rather than its first child's.
 */
function rangeOf(doc: Document.Parsed, path: Path): Range | undefined {
  if (path.length > 0) {
    const parent = doc.getIn(path.slice(0, -1), true);
    if (isMap(parent)) {
      const last = path[path.length - 1];
      const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === last);
      if (isNode(pair?.key) && pair.key.range) return pair.key.range;
    }
  }
  const node = doc.getIn(path, true);
  return isNode(node) && node.range ? node.range : undefined;
}

/** `lineOffset` is the number of file lines that precede `text`. */
function parseAt(text: string, lineOffset: number): ParsedYaml {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const first = doc.errors[0];
  if (first) {
    throw new ParseError(shortMessage(first.message), (first.linePos?.[0].line ?? 1) + lineOffset);
  }
  let data: unknown;
  try {
    data = doc.toJS();
  } catch (e) {
    // Unresolved aliases and alias bombs only surface here, and carry no position.
    throw new ParseError(e instanceof Error ? e.message : String(e), 1 + lineOffset);
  }
  return {
    data,
    lineOf(path) {
      const range = rangeOf(doc, path);
      return range ? lineCounter.linePos(range[0]).line + lineOffset : undefined;
    },
  };
}

export function parseYaml(text: string): ParsedYaml {
  return parseAt(normalize(text), 0);
}

const OPENING_DELIMITER = /^---[ \t]*(?:\n|$)/;
const CLOSING_DELIMITER = /^---[ \t]*(?:\n|$)/m;

/**
 * Parses a Markdown file that starts with a `---` delimited YAML block. `body`
 * is everything after the closing delimiter line. `lineOf` counts lines in the
 * whole file, so it is one more than the line within the YAML block.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const source = normalize(text);
  const opening = OPENING_DELIMITER.exec(source);
  if (!opening) throw new ParseError('missing frontmatter: the file must start with a "---" line', 1);
  const rest = source.slice(opening[0].length);
  const closing = CLOSING_DELIMITER.exec(rest);
  if (!closing) throw new ParseError('unterminated frontmatter: no closing "---" line', 1);
  return {
    ...parseAt(rest.slice(0, closing.index), 1),
    body: rest.slice(closing.index + closing[0].length),
  };
}
