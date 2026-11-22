// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON
// edits), finds the lines each edit names at the first of three matching tiers (exact, then
// trailing whitespace ignored, then leading and trailing whitespace ignored, with re-indenting
// at the loosest tier), and writes every change or none, printing what it changed or why it
// failed. SPEC.md is the whole contract.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: its text split at `\n`, each with one trailing `\r` removed, and without the
 *  empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves an edit performed, as [old path, new path] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const isBlankish = (s: string): boolean => /^[ \t]*$/.test(s);

function tierKey(line: string, tier: number): string {
  return tier === 0 ? line : tier === 1 ? trimEndWS(line) : trimBothWS(line);
}

/** Positions where O occurs in `lines` at one tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const keys = o.map((l) => tierKey(l, tier));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** The first tier at which O occurs at least once (tier 0 only with --strict). */
function findTier(lines: string[], o: string[], strict: boolean): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, o, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** The first line at or after `from` equal to one line at the first tier with one. */
function findSingle(lines: string[], one: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const key = tierKey(one, tier);
    for (let i = from; i < lines.length; i += 1) {
      if (tierKey(lines[i]!, tier) === key) return i;
    }
  }
  return null;
}

/** One line of the replacement: a context line, written as the file's own matched line, or a
 *  new line, written as the patch wrote it (re-indented at tier 2). */
type NItem = { ctx: true; oIdx: number } | { ctx: false; text: string };

function buildNew(fileLines: string[], at: number, o: string[], n: NItem[], tier: number): string[] {
  const out: string[] = [];
  if (tier === 2 && o.length > 0) {
    const f = leadingWS(fileLines[at]!);
    const p = leadingWS(o[0]!);
    for (const item of n) {
      if (item.ctx) out.push(fileLines[at + item.oIdx]!);
      else if (item.text !== '' && !isBlankish(item.text) && item.text.startsWith(p)) out.push(f + item.text.slice(p.length));
      else out.push(item.text);
    }
    return out;
  }
  for (const item of n) out.push(item.ctx ? fileLines[at + item.oIdx]! : item.text);
  return out;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function noEol(body: BodyLine[]): boolean {
  for (let j = body.length - 1; j >= 0; j -= 1) {
    const k = body[j]!.kind;
    if (k === ' ' || k === 'e' || k === '+') return body[j + 1]?.kind === '\\';
  }
  return false;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

/** One body line of a hunk: ` ` and `e` are context lines (an `e` line is an empty line), `-` an
 *  old line, `+` a new line, `\` a no-newline marker for the line before it. */
interface BodyLine {
  kind: ' ' | 'e' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  /** The hunk header's old start, 1-based (0 for an insertion before the first line). */
  a: number;
  body: BodyLine[];
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` or `+++ ` line: the text after the four characters, up to the first tab,
 *  with surrounding spaces removed; `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** O is the hunk's context and `-` lines, N its context and `+` lines, each in body order. */
function hunkON(hunk: Hunk): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const b of hunk.body) {
    if (b.kind === ' ' || b.kind === 'e') {
      o.push(b.text);
      n.push({ ctx: true, oIdx: o.length - 1 });
    } else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') n.push({ ctx: false, text: b.text });
  }
  return { o, n };
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = hunkON(hunk);
    if (o.length === 0) {
      const at = Math.min(hunk.a + d, f.lines.length);
      const added = n.map((item) => (item.ctx ? '' : item.text));
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...added);
      if (atEnd) f.final = !noEol(hunk.body);
      d += n.length;
      continue;
    }
    const found = findTier(f.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let at = found.occ[0]!;
    for (const pos of found.occ) {
      if (Math.abs(pos - target) < Math.abs(at - target)) at = pos;
    }
    const atEnd = at + o.length === f.lines.length;
    const replacement = buildNew(f.lines, at, o, n, found.tier);
    f.lines.splice(at, o.length, ...replacement);
    if (atEnd) f.final = !noEol(hunk.body);
    d += n.length - o.length;
  }
  return joinFile(f);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  let pairSeen = false;
  let hunk: Hunk | null = null;
  let body: BodyLine[] = [];

  const flushHunk = (): void => {
    if (hunk === null) return;
    while (body.length > 0 && body[body.length - 1]!.kind === 'e') body.pop();
    hunk.body = body;
    hunk = null;
    body = [];
  };
  const startsPair = (i: number): boolean =>
    lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ') || startsPair(i)) {
        flushHunk();
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        body.push(line === '' ? { kind: 'e', text: '' } : { kind: line[0] as BodyLine['kind'], text: line.slice(1) });
        i += 1;
        continue;
      } else {
        flushHunk();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = {
        pairOld: undefined, pairNew: undefined, renameFrom: undefined, renameTo: undefined,
        diffOld: m[1], diffNew: m[2], newFile: false, deletedFile: false, hunks: [],
      };
      sections.push(sec);
      inHeader = true;
      pairSeen = false;
      i += 1;
      continue;
    }
    if (startsPair(i)) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (sec !== null && inHeader && !pairSeen) {
        sec.pairOld = oldP;
        sec.pairNew = newP;
        pairSeen = true;
      } else {
        sec = {
          pairOld: oldP, pairNew: newP, renameFrom: undefined, renameTo: undefined,
          diffOld: undefined, diffNew: undefined, newFile: false, deletedFile: false, hunks: [],
        };
        sections.push(sec);
        inHeader = true;
        pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (sec !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null || sec === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      sec.hunks.push(hunk);
      body = [];
      i += 1;
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
      else if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
    }
    i += 1;
  }
  flushHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    if (oldP !== undefined && oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== undefined && newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.deletedFile);
    if (isCreate) {
      if (newP === null || newP === undefined) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        let lastPlus = -1;
        for (let j = 0; j < h.body.length; j += 1) {
          if (h.body[j]!.kind === '+') {
            plus.push(h.body[j]!.text);
            lastPlus = j;
          }
        }
        if (lastPlus >= 0) noEol = h.body[lastPlus + 1]?.kind === '\\';
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null || oldP === undefined) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === undefined || newP === undefined || oldP === null || newP === null) return;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const text = applyHunks(before, sec.hunks, strict, oldP);
    if (oldP !== newP) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const replacement = buildNew(
      f.lines,
      at,
      oldLines,
      newLines.map((text) => ({ ctx: false as const, text })),
      found.tier,
    );
    f.lines.splice(at, oldLines.length, ...replacement);
    tree.now.set(path, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  /** Null: no anchor. */
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

const V_ADD = '*** Add File: ';
const V_DELETE = '*** Delete File: ';
const V_UPDATE = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function isVSectionStart(l: string): boolean {
  return l.startsWith(V_ADD) || l.startsWith(V_DELETE) || l.startsWith(V_UPDATE);
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    if (!isVSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = line.startsWith(V_ADD) ? 'add' : line.startsWith(V_DELETE) ? 'delete' : 'update';
    const prefix = kind === 'add' ? V_ADD : kind === 'delete' ? V_DELETE : V_UPDATE;
    const path = line.slice(prefix.length).trim();
    const start = i;
    i += 1;
    const raw: Array<{ text: string; idx: number }> = [];
    while (i < last && !isVSectionStart(lines[i]!)) {
      raw.push({ text: lines[i]!, idx: i });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') edits.push(vAddEdit(path, raw));
    else if (kind === 'delete') edits.push(vDeleteEdit(path, raw));
    else edits.push(vUpdateEdit(path, raw, start, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function vAddEdit(path: string, raw: Array<{ text: string; idx: number }>): Edit {
  const fileLines: string[] = [];
  for (const { text, idx } of raw) {
    if (text.startsWith('+')) fileLines.push(text.slice(1));
    else if (text === '') fileLines.push('');
    else throw new Exit2(`error: parse ${idx + 1}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
}

function vDeleteEdit(path: string, raw: Array<{ text: string; idx: number }>): Edit {
  if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, raw: Array<{ text: string; idx: number }>, start: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let j = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith(V_MOVE)) {
    moveTo = raw[0]!.text.slice(V_MOVE.length).trim();
    j = 1;
  }
  const chunks: VChunk[] = [];
  let chunk: VChunk | null = null;
  let afterEof = false;
  for (; j < raw.length; j += 1) {
    const { text, idx } = raw[j]!;
    if (text.startsWith('@@')) {
      const anchor = text.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(chunk);
      afterEof = false;
      continue;
    }
    if (text.trim() === '*** End of File') {
      if (chunk === null || afterEof) throw new Exit2(`error: parse ${idx + 1}`);
      chunk.eof = true;
      afterEof = true;
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (chunk === null) {
        chunk = { anchor: null, eof: false, body: [] };
        chunks.push(chunk);
      } else if (afterEof) {
        throw new Exit2(`error: parse ${idx + 1}`);
      }
      chunk.body.push(text === '' ? { kind: 'e', text: '' } : { kind: text[0] as BodyLine['kind'], text: text.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${start + 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const text = applyVChunks(before, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

/** Apply a V4A Update section's chunks in order, with the cursor, to a file's text. */
function applyVChunks(before: string, chunks: VChunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      const at = findSingle(f.lines, chunk.anchor, cursor, strict);
      if (at === null) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const { o, n } = hunkON({ a: 0, body: chunk.body });
    if (o.length === 0) {
      const at = chunk.eof ? f.lines.length : cursor;
      const added = n.map((item) => (item.ctx ? '' : item.text));
      f.lines.splice(at, 0, ...added);
      cursor = at + added.length;
      continue;
    }
    let at: number | null = null;
    let tier = 0;
    if (chunk.eof) {
      // Only an occurrence ending at the file's last line counts.
      const pos = f.lines.length - o.length;
      if (pos >= cursor) {
        const found = findTier(f.lines.slice(pos, pos + o.length), o, strict);
        if (found !== null && found.occ.includes(0)) {
          at = pos;
          tier = found.tier;
        }
      }
    } else {
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const occ = occurrences(f.lines, o, t).filter((p) => p >= cursor);
        if (occ.length > 0) {
          at = occ[0]!;
          tier = t;
          break;
        }
      }
    }
    if (at === null) throw new Fail('no-match', path);
    const replacement = buildNew(f.lines, at, o, n, tier);
    f.lines.splice(at, o.length, ...replacement);
    cursor = at + replacement.length;
  }
  return joinFile(f);
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// The command line, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; line: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o !== undefined && o.was !== null && o.now === null && n !== undefined && n.was === null && n.now !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  for (const [p, { was, now }] of changed) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
