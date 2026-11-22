// mend — one patch tool for every AI edit format (unified diff, SEARCH/REPLACE,
// V4A, JSON tool calls), built to the SPEC.md that ships with the make.fun kit
// "Build mend, one patch tool for every AI edit format" (hidden-spec-cli-01).
//
// Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` with the
// working directory as the root of the tree. Node 22, standard library only.
// In a trial the grader sets MAKEFUN_ENV_URL and this file hands over to
// runner.ts (kept from the kit, at the bottom of this file).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** An exit-2 failure: exactly one line on stdout, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: an exit-1 line `error: <code> <path>`. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no final empty piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when no segment is empty, "." or "..", etc. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function needSafe(p: string): void {
  if (!isSafe(p)) throw new Fail('unsafe', p);
}

// ---------------------------------------------------------------------------
// File model (section 3): a file is lines joined by its own line break, plus
// a flag for whether it ends with that break. An empty file has no lines.
// ---------------------------------------------------------------------------

interface FileModel {
  br: string; // '\r\n' or '\n'
  lines: string[];
  finalBreak: boolean;
}

function toModel(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], finalBreak: false };
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function fromModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

/** A created file: LF breaks, ends with a break unless the format says not. */
function createdText(lines: string[], finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (finalBreak ? '\n' : '');
}

// ---------------------------------------------------------------------------
// The tree as the edits leave it. `now` holds only paths an edit has touched
// (null: deleted); everything else is read from disk on demand. Successful
// move edits are remembered so the report can print an `R old -> new` line.
// ---------------------------------------------------------------------------

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];

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

  mustExist(p: string): string {
    const t = this.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  }

  mustNotExist(p: string): void {
    if (this.get(p) !== null) throw new Fail('exists', p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers. Tier 0 exact, tier 1 ignoring
// trailing spaces/tabs, tier 2 ignoring leading and trailing spaces/tabs.
// ---------------------------------------------------------------------------

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

/** All start positions >= `from` where O matches `lines` at `tier`. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (of the tiers allowed) at which O occurs at or after `from`. */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(lines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/**
 * One body item of a unified hunk or a V4A chunk. `ctx` lines belong to both
 * O and N; `del` only to O; `add` only to N. `noNl` records a following
 * `\ No newline at end of file` line (unified only).
 */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNl: boolean;
}

function splitON(items: BodyItem[]): { o: string[]; nIdx: number[] } {
  const o: string[] = [];
  for (const it of items) if (it.kind !== 'add') o.push(it.text);
  return { o, nIdx: [] };
}

/**
 * The lines N becomes when it replaces the matched O at `pos`: context lines
 * are the file's own matched lines; at tier 2 the other lines are re-indented
 * by swapping O's first line's leading blanks for the file's (section 5).
 * `hasCtx` is false for SEARCH/REPLACE, whose N has no context lines.
 */
function writtenLines(
  items: BodyItem[],
  fileLines: string[],
  pos: number,
  tier: number,
  hasCtx: boolean,
): string[] {
  const out: string[] = [];
  let oi = 0;
  let f = '';
  let p = '';
  if (tier === 2) {
    const firstO = items.find((it) => it.kind !== 'add');
    f = leadST(fileLines[pos] ?? '');
    p = firstO === undefined ? '' : leadST(firstO.text);
  }
  for (const it of items) {
    if (it.kind === 'del') {
      oi += 1;
      continue;
    }
    if (it.kind === 'ctx' && hasCtx) {
      out.push(fileLines[pos + oi]!);
      oi += 1;
      continue;
    }
    if (it.kind === 'ctx') oi += 1;
    let s = it.text;
    if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
    out.push(s);
  }
  return out;
}

/** Plain O/N line lists (SEARCH/REPLACE) as body items with no context. */
function plainItems(o: string[], n: string[]): BodyItem[] {
  const items: BodyItem[] = [];
  for (const t of o) items.push({ kind: 'del', text: t, noNl: false });
  for (const t of n) items.push({ kind: 'add', text: t, noNl: false });
  return items;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs. A patch is parsed whole before any edit runs, so
// a parse error anywhere is reported before any file is looked at.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number; // the A of @@ -A[,B] +C[,D] @@
  items: BodyItem[];
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null | undefined; // undefined: no ---/+++ pair seen
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s.*)?$/;

/** The path of a ---/+++ line: after the 4 chars, to the first tab, trimmed. */
function headerPath(raw: string): string {
  const upToTab = raw.slice(4).split('\t')[0]!;
  const t = upToTab.trim();
  if (t === '/dev/null') return '/dev/null';
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let inHeader = false;
  let hunk: Hunk | null = null;

  const endBody = (): void => {
    if (hunk !== null) {
      // Empty lines at the end of a body are not part of it.
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.items.pop();
        else break;
      }
      hunk = null;
    }
  };
  const newSection = (): USection => {
    endBody();
    const s: USection = {
      diffOld: null,
      diffNew: null,
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    sec = s;
    inHeader = true;
    return s;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const nextIsPlus = (lines[i + 1] ?? '').startsWith('+++ ');

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      continue;
    }
    if (line.startsWith('--- ') && nextIsPlus) {
      // A pair belongs to the current section's header when it has none yet;
      // otherwise it starts the next section.
      if (sec === null || !inHeader || sec.pairOld !== undefined) newSection();
      sec!.pairOld = headerPath(line);
      sec!.pairNew = headerPath(lines[i + 1]!);
      i += 1;
      continue;
    }
    if (hunk !== null) {
      const c = line[0];
      if (line === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
        if (c === '\\') {
          const prev = hunk.items[hunk.items.length - 1];
          if (prev !== undefined) prev.noNl = true;
        } else if (line === '') {
          hunk.items.push({ kind: 'ctx', text: '', noNl: false });
        } else {
          hunk.items.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: line.slice(1), noNl: false });
        }
        continue;
      }
      endBody();
      // Fall through: the line is handled as outside a body.
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || sec === null) throw new Exit2(`error: parse ${lineNo}`);
      inHeader = false;
      hunk = { a: Number(m[1]), items: [] };
      sec.hunks.push(hunk);
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) {
        // A --- line inside a header with no +++ line after it.
        throw new Exit2(`error: parse ${lineNo + 1}`);
      }
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
      continue;
    }
    // Anything else outside a body is ignored (prose, code fences, ...).
  }
  endBody();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s));
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function lastNoNl(h: Hunk): boolean {
  for (let i = h.items.length - 1; i >= 0; i -= 1) {
    const it = h.items[i]!;
    if (it.kind !== 'del') return it.noNl;
  }
  return false;
}

function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  const lines = [...model.lines];
  let finalBreak = model.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { o } = splitON(h.items);
    const nCount = h.items.filter((it) => it.kind !== 'del').length;
    if (o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), lines.length);
      const adds = h.items.filter((it) => it.kind === 'add').map((it) => it.text);
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...adds);
      if (atEnd && adds.length > 0) finalBreak = !lastNoNl(h);
      d += adds.length;
      continue;
    }
    const found = findTier(lines, o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.positions[0]!;
    for (const cand of found.positions) {
      if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
    }
    const written = writtenLines(h.items, lines, pos, found.tier, true);
    const runsToEnd = pos + o.length === lines.length;
    lines.splice(pos, o.length, ...written);
    if (runsToEnd) finalBreak = !lastNoNl(h);
    d += nCount - o.length;
  }
  return { br: model.br, lines, finalBreak };
}

function unifiedEdit(s: USection): Edit {
  // Resolve the section's paths: the ---/+++ pair first, then the rename
  // lines, then the diff --git paths (section 6).
  let oldP: string | null;
  let newP: string | null;
  if (s.pairOld !== undefined) {
    oldP = s.pairOld;
    newP = s.pairNew!;
  } else if (s.renameFrom !== undefined || s.renameTo !== undefined) {
    oldP = s.renameFrom ?? s.diffOld;
    newP = s.renameTo ?? s.diffNew;
  } else {
    oldP = s.diffOld;
    newP = s.diffNew;
  }
  const isCreate = s.newFile || oldP === '/dev/null';
  const isDelete = s.deletedFile || newP === '/dev/null';
  return (tree) => {
    if (isCreate) {
      const p = newP ?? oldP;
      if (p === null || p === '/dev/null') throw new Fail('unsafe', String(p));
      needSafe(p);
      tree.mustNotExist(p);
      const plus: string[] = [];
      let lastPlusNoNl = false;
      for (const h of s.hunks) {
        for (const it of h.items) {
          if (it.kind === 'add') {
            plus.push(it.text);
            lastPlusNoNl = it.noNl;
          }
        }
      }
      tree.now.set(p, createdText(plus, !lastPlusNoNl));
      return;
    }
    if (isDelete) {
      const p = oldP ?? newP;
      if (p === null || p === '/dev/null') throw new Fail('unsafe', String(p));
      needSafe(p);
      tree.mustExist(p);
      tree.now.set(p, null);
      return;
    }
    if (oldP === null || newP === null) throw new Fail('unsafe', String(oldP ?? newP));
    needSafe(oldP);
    needSafe(newP);
    if (oldP === newP) {
      const before = tree.mustExist(oldP);
      const after = applyHunks(toModel(before), s.hunks, strictGlobal, oldP);
      tree.now.set(oldP, fromModel(after));
      return;
    }
    // A move: hunks apply to the old file, the result lands at the new path.
    const before = tree.mustExist(oldP);
    tree.mustNotExist(newP);
    const after = applyHunks(toModel(before), s.hunks, strictGlobal, oldP);
    tree.now.set(newP, fromModel(after));
    tree.now.set(oldP, null);
    tree.moves.push([oldP, newP]);
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1; // index of the previous block's REPLACE line
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // The path: the nearest suitable line before SEARCH, after the previous
    // block (or the start): not blank, not a code fence when trimmed.
    let path: string | undefined;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      const t = cand.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => searchReplaceEdit(b));
}

function searchReplaceEdit(b: SRBlock): Edit {
  return (tree) => {
    needSafe(b.path);
    if (b.oldLines.length === 0) {
      tree.mustNotExist(b.path);
      tree.now.set(b.path, createdText(b.newLines, true));
      return;
    }
    const before = tree.mustExist(b.path);
    const model = toModel(before);
    const found = findTier(model.lines, b.oldLines, strictGlobal, 0);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const written = writtenLines(plainItems(b.oldLines, b.newLines), model.lines, pos, found.tier, false);
    model.lines.splice(pos, b.oldLines.length, ...written);
    tree.now.set(b.path, fromModel(model));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  addLines: string[];
  moveTo: string | undefined;
  chunks: VChunk[];
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (last === first || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    let kind: VSection['kind'] | null = null;
    let path = '';
    if (line.startsWith(V_ADD)) {
      kind = 'add';
      path = line.slice(V_ADD.length).trim();
    } else if (line.startsWith(V_DEL)) {
      kind = 'delete';
      path = line.slice(V_DEL.length).trim();
    } else if (line.startsWith(V_UPD)) {
      kind = 'update';
      path = line.slice(V_UPD.length).trim();
    }
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    i += 1;
    // Collect this section's raw lines, up to the next section or End Patch.
    const raw: Array<{ text: string; no: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD)) break;
      raw.push({ text: l, no: i + 1 });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it. A line of only
    // spaces counts as blank here: a trailing " " context line in the last
    // chunk of the practice set (v-cursor) is dropped this way, which is
    // what lets that chunk match at the end of the file.
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
    const sec: VSection = { kind, path, headerLine, addLines: [], moveTo: undefined, chunks: [] };
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (r.text !== '') throw new Exit2(`error: parse ${r.no}`);
      }
    } else {
      parseVChunks(sec, raw);
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s));
}

function parseVChunks(sec: VSection, raw: Array<{ text: string; no: number }>): void {
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith(V_MOVE)) {
    sec.moveTo = raw[0]!.text.slice(V_MOVE.length).trim();
    idx = 1;
  }
  let chunk: VChunk | null = null;
  let needStart = false; // after *** End of File, a chunk must start with @@
  for (; idx < raw.length; idx += 1) {
    const { text, no } = raw[idx]!;
    if (text === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${no}`);
      chunk.eof = true;
      chunk = null;
      needStart = true;
      continue;
    }
    if (text.startsWith('@@')) {
      const anchorText = text.slice(2).trim();
      chunk = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
      sec.chunks.push(chunk);
      needStart = false;
      continue;
    }
    const c = text[0];
    if (text === '' || c === ' ' || c === '-' || c === '+') {
      if (chunk === null) {
        if (needStart || sec.chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        chunk = { anchor: null, eof: false, items: [] };
        sec.chunks.push(chunk);
      }
      if (text === '') chunk.items.push({ kind: 'ctx', text: '', noNl: false });
      else chunk.items.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: text.slice(1), noNl: false });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (sec.chunks.length === 0 && sec.moveTo === undefined) {
    throw new Exit2(`error: parse ${sec.headerLine}`);
  }
}

function v4aEdit(s: VSection): Edit {
  return (tree) => {
    needSafe(s.path);
    if (s.kind === 'add') {
      tree.mustNotExist(s.path);
      tree.now.set(s.path, createdText(s.addLines, true));
      return;
    }
    if (s.kind === 'delete') {
      tree.mustExist(s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== undefined) needSafe(s.moveTo);
    const before = tree.mustExist(s.path);
    if (s.moveTo !== undefined) tree.mustNotExist(s.moveTo);
    const model = toModel(before);
    const lines = [...model.lines];
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const tiers = strictGlobal ? [0] : [0, 1, 2];
        let at = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (lineEq(lines[k]!, ch.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const { o } = splitON(ch.items);
      if (o.length === 0) {
        const adds = writtenLines(
          ch.items.filter((it) => it.kind === 'add').map((it) => ({ ...it, kind: 'add' as const })),
          lines,
          cursor,
          0,
          false,
        );
        const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines.splice(pos, 0, ...adds);
        cursor = pos + adds.length;
        continue;
      }
      if (ch.eof) {
        const pos = lines.length - o.length;
        let ok = false;
        if (pos >= cursor) {
          const tiers = strictGlobal ? [0] : [0, 1, 2];
          for (const tier of tiers) {
            let good = true;
            for (let j = 0; j < o.length; j += 1) {
              if (!lineEq(lines[pos + j]!, o[j]!, tier)) {
                good = false;
                break;
              }
            }
            if (good) {
              const written = writtenLines(ch.items, lines, pos, tier, true);
              lines.splice(pos, o.length, ...written);
              cursor = pos + written.length;
              ok = true;
              break;
            }
          }
        }
        if (!ok) throw new Fail('no-match', s.path);
        continue;
      }
      const found = findTier(lines, o, strictGlobal, cursor);
      if (found === null) throw new Fail('no-match', s.path);
      const pos = found.positions[0]!;
      const written = writtenLines(ch.items, lines, pos, found.tier, true);
      lines.splice(pos, o.length, ...written);
      cursor = pos + written.length;
    }
    const out = fromModel({ br: model.br, lines, finalBreak: model.finalBreak });
    if (s.moveTo !== undefined) {
      tree.now.set(s.moveTo, out);
      tree.now.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      tree.mustNotExist(p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      needSafe(p);
      const before = tree.mustExist(p);
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
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      needSafe(p);
      const before = tree.mustExist(p);
      const model = toModel(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.now.set(p, fromModel(model));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
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
  } else {
    lines.forEach((l, i) => {
      if (isBlank(l)) return;
      let e: Edit | null = null;
      try {
        e = jsonEdit(JSON.parse(l));
      } catch {
        e = null;
      }
      if (e === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(e);
    });
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Section 4: detecting the format, and sections 1, 2 and 10: the command
// line, the report, and the all-or-nothing write.
// ---------------------------------------------------------------------------

let strictGlobal = false;

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  strictGlobal = strict;

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const savedNow = new Map(tree.now);
    const savedMoves = tree.moves;
    tree.moves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of savedNow) tree.now.set(k, v);
      tree.moves = savedMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // The report: one line per changed path in byte order; a successful move
  // whose old path is gone and whose new path is new prints as one R line,
  // sorted by the new path, instead of the D and A lines.
  interface Row {
    sortKey: string;
    text: string;
    path: string;
    kind: string;
  }
  const rows: Row[] = [];
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o === undefined || n === undefined) continue;
    if (o.was === null || o.now !== null || n.was !== null || n.now === null) continue;
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    consumed.add(oldP);
    consumed.add(newP);
    rows.push({ sortKey: newP, text: `R ${oldP} -> ${newP}`, path: newP, kind: 'R' });
  }
  for (const [p, c] of changed) {
    if (consumed.has(p)) continue;
    const kind = c.was === null ? 'A' : c.now === null ? 'D' : 'M';
    rows.push({ sortKey: p, text: `${kind} ${p}`, path: p, kind });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.sortKey, 'utf8'), Buffer.from(y.sortKey, 'utf8')));

  if (!checkOnly) {
    for (const row of rows) {
      if (row.kind === 'R') {
        const [oldP, newP] = row.text.slice(2).split(' -> ') as [string, string];
        rmSync(oldP, { force: true });
        mkdirSync(dirname(newP), { recursive: true });
        writeFileSync(newP, tree.now.get(newP)!);
      } else if (row.kind === 'D') {
        rmSync(row.path, { force: true });
      } else {
        mkdirSync(dirname(row.path), { recursive: true });
        writeFileSync(row.path, tree.now.get(row.path)!);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
