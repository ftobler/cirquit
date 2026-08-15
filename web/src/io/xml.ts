/**
 * A minimal XML parser for upstream's `<cir>` documents.
 *
 * The port does not implement the XML format; it converts it. Upstream's
 * `XMLSerializer.prettyPrint` output is the only XML this module needs to read:
 * 2-space-indented tags, double-quoted attributes with the five named
 * entities, self-closing elements, and the handful of elements that carry text
 * or children (`<o>` with `<p>` plots, `<cr>`/`<ROM>`/`<rw>`/`<ins>` with text,
 * `<ccm>` with its child element list). A general XML parser would be a
 * dependency and browser/node behaviour split for nothing; a hand-rolled one
 * for this fixed shape is both pure and testable headlessly.
 */

export interface XmlNode {
  tag: string;
  /** Attribute names and values, entities decoded. */
  attrs: Record<string, string>;
  /** Child element nodes, in document order. */
  children: XmlNode[];
  /** The raw text content between the open and close tags, entities decoded
   *  and trimmed of surrounding whitespace, or '' for an empty element. */
  text: string;
}

/** The five named entities XML defines, applied in one pass so `&amp;lt;`
 *  decodes to `&lt;` rather than recursively to `<`. */
function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, name: string) => {
    switch (name) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      default:
        return "'";
    }
  });
}

interface Token {
  /** `<tag`, `</tag`, `/>`, `>`, or a text run. */
  kind: 'open' | 'close' | 'selfclose' | 'gt' | 'text';
  value: string;
}

/** Splits the document into lexical tokens. Attributes are kept raw inside the
 *  open tag; the parse step below reads them, so the tokenizer does not need
 *  to understand quotes. */
/** The `>` that ends the tag starting at `<`, skipping any `>` inside a
 *  quoted attribute value (upstream's `dumpAttr` escapes `>` only in text,
 *  never in an attribute, so `te="a>b"` is legal). */
function tagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < source.length; i++) {
    const c = source[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === '<') {
      const gt = tagEnd(source, i);
      if (gt < 0) throw new Error('xml: unterminated tag');
      const inner = source.slice(i + 1, gt).trim();
      if (inner.startsWith('/')) {
        tokens.push({ kind: 'close', value: inner.slice(1).trim() });
      } else if (inner.endsWith('/')) {
        tokens.push({ kind: 'selfclose', value: inner.slice(0, -1).trim() });
      } else if (inner.startsWith('?')) {
        // `<?xml ...?>` declaration, skipped like any processing instruction.
        tokens.push({ kind: 'gt', value: '' });
      } else {
        tokens.push({ kind: 'open', value: inner });
      }
      i = gt + 1;
    } else {
      const lt = source.indexOf('<', i);
      const end = lt < 0 ? n : lt;
      const text = source.slice(i, end);
      if (text.trim() !== '') tokens.push({ kind: 'text', value: text });
      i = end;
    }
  }
  return tokens;
}

/** Reads `tag attr="value" ...` into a tag name and attribute map. */
function parseTag(inner: string): { tag: string; attrs: Record<string, string> } {
  const space = inner.search(/[\s]/);
  const tag = space < 0 ? inner : inner.slice(0, space);
  const attrs: Record<string, string> = {};
  const rest = space < 0 ? '' : inner.slice(space);
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return { tag, attrs };
}

/** Trims and entity-decodes the text content of every node, recursively. */
function finish(node: XmlNode): void {
  node.text = decodeEntities(node.text.trim());
  for (const child of node.children) finish(child);
}

/** Builds the tree from the token stream, the only place that enforces the
 *  nesting rules. An unclosed or misnested tag throws, so a malformed document
 *  fails loudly at conversion time instead of silently losing elements. Text
 *  between tags accumulates on the element it belongs to (the open element or
 *  its last self-closed child's parent). */
function build(tokens: Token[]): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const top = (): XmlNode => stack[stack.length - 1];
  for (const t of tokens) {
    if (t.kind === 'open') {
      const { tag, attrs } = parseTag(t.value);
      const node: XmlNode = { tag, attrs, children: [], text: '' };
      top().children.push(node);
      stack.push(node);
    } else if (t.kind === 'selfclose') {
      const { tag, attrs } = parseTag(t.value);
      top().children.push({ tag, attrs, children: [], text: '' });
    } else if (t.kind === 'close') {
      if (stack.length <= 1) throw new Error(`xml: unexpected </${t.value}>`);
      if (top().tag !== t.value) {
        throw new Error(`xml: </${t.value}> does not close <${top().tag}>`);
      }
      stack.pop();
    } else if (t.kind === 'text') {
      // Whitespace between child elements is irrelevant; the trimming pass
      // drops it. Keep it raw here so `finish` trims exactly once.
      top().text += t.value;
    }
  }
  if (stack.length !== 1) {
    throw new Error(`xml: unclosed element <${top().tag}>`);
  }
  finish(root);
  return root;
}

/** Parses a document into its root element. Throws on malformed XML. */
export function parseXml(source: string): XmlNode {
  return build(tokenize(source));
}

/** True when the text is an upstream XML circuit document: the first non-blank
 *  line opens a `<cir>` element (possibly preceded by a BOM). */
export function isXml(text: string): boolean {
  const head = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  return (head ?? '').trimStart().startsWith('<cir ');
}
