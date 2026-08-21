/**
 * The bundled example-circuit library.
 *
 * `setuplist.txt` is a file of groups and entries copied from upstream: a line
 * starting with `+` opens a group, `-` closes it, and everything else is
 * `<filename> <title>`. Groups nest, up to three deep in upstream's file, and
 * a group may hold both circuits and subgroups. A leading `>` marks the
 * circuit upstream opens on startup; it is displayed like any other entry.
 */

export interface LibraryEntry {
  file: string;
  title: string;
  /** Set on the `>` entry: the circuit to open when nothing else was asked
   *  for. Exactly one entry carries it, see `parseSetupList`. */
  isDefault?: boolean;
}

export interface LibraryGroup {
  title: string;
  entries: LibraryEntry[];
  /** Subgroups opened by a nested `+` before this group's `-`. Upstream nests
   *  three deep (Other Passive Circuits > Transformers > Saturable Core), so
   *  the tree is kept rather than flattened. Empty for a leaf group. */
  groups: LibraryGroup[];
}

/** Where the circuit files live, relative to the deployed site. */
const CIRCUITS_BASE = `${import.meta.env.BASE_URL}circuits/`;

export function parseSetupList(text: string): LibraryGroup[] {
  const roots: LibraryGroup[] = [];
  const stack: LibraryGroup[] = [];
  // Upstream keeps the first `>` it sees and ignores any later one
  // (Menus.processSetupList, the `startCircuit == null` guard).
  let seenDefault = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('+')) {
      const group: LibraryGroup = { title: line.slice(1).trim(), entries: [], groups: [] };
      // A `+` inside an open group opens a subgroup of it, so the file's three
      // levels survive as a tree instead of collapsing into one flat run.
      const parent = stack[stack.length - 1];
      if (parent) parent.groups.push(group);
      else roots.push(group);
      stack.push(group);
      continue;
    }
    if (line === '-') {
      stack.pop();
      continue;
    }

    const body = line.replace(/^[>%]/, '');
    const space = body.indexOf(' ');
    if (space < 0) continue;
    const entry: LibraryEntry = {
      file: body.slice(0, space),
      title: body.slice(space + 1).trim(),
    };
    if (line.startsWith('>') && !seenDefault) {
      entry.isDefault = true;
      seenDefault = true;
    }
    const current = stack[stack.length - 1];
    if (current) current.entries.push(entry);
  }

  return prune(roots);
}

/** Drops groups that carry neither an entry of their own nor a surviving
 *  subgroup, so an empty `+`/`-` pair never renders as a dead row. */
function prune(groups: LibraryGroup[]): LibraryGroup[] {
  return groups
    .map((g) => ({ ...g, groups: prune(g.groups) }))
    .filter((g) => g.entries.length > 0 || g.groups.length > 0);
}

export async function loadLibraryIndex(): Promise<LibraryGroup[]> {
  const res = await fetch(`${CIRCUITS_BASE}setuplist.txt`);
  if (!res.ok) throw new Error(`circuit library unavailable (${res.status})`);
  return parseSetupList(await res.text());
}

export async function loadLibraryCircuit(file: string): Promise<string> {
  const res = await fetch(`${CIRCUITS_BASE}${file}`);
  if (!res.ok) throw new Error(`could not load ${file} (${res.status})`);
  return res.text();
}

/** The entry the setup list marks with `>`, which is what upstream opens when
 *  no circuit was requested. Null when the list carries no marker. Searches
 *  subgroups too: nothing pins the marker to a top-level group. */
export function defaultLibraryEntry(groups: LibraryGroup[]): LibraryEntry | null {
  for (const group of groups) {
    for (const entry of group.entries) {
      if (entry.isDefault) return entry;
    }
    const nested = defaultLibraryEntry(group.groups);
    if (nested) return nested;
  }
  return null;
}

/** Fetches the library's default circuit, index and all, so the app opens on
 *  the same circuit upstream does. Rejects when the index, the marker or the
 *  file is missing; the caller decides what to show instead. */
export async function loadDefaultCircuit(): Promise<{ entry: LibraryEntry; netlist: string }> {
  const entry = defaultLibraryEntry(await loadLibraryIndex());
  if (entry === null) throw new Error('the circuit library names no default circuit');
  return { entry, netlist: await loadLibraryCircuit(entry.file) };
}

/** Filter the library for the Circuits menu search box: a case-insensitive
 *  substring match on entry title or group title. A group whose own title
 *  matches keeps every entry (the group is what the user meant); otherwise the
 *  group keeps only its matching entries. Groups with nothing left are
 *  dropped. An empty or whitespace-only query returns the groups unchanged. */
export function filterLibrary(groups: LibraryGroup[], query: string): LibraryGroup[] {
  const q = query.trim().toLowerCase();
  if (q === '') return groups;
  return keep(groups, q, false);
}

/** The recursive half of `filterLibrary`. `inherited` is true once an ancestor
 *  group's own title matched, which keeps that whole subtree: the user named
 *  the group, so every circuit under it is what they meant. */
function keep(groups: LibraryGroup[], q: string, inherited: boolean): LibraryGroup[] {
  return groups
    .map((g) => {
      const hit = inherited || g.title.toLowerCase().includes(q);
      return {
        title: g.title,
        entries: hit ? g.entries : g.entries.filter((e) => e.title.toLowerCase().includes(q)),
        groups: keep(g.groups, q, hit),
      };
    })
    .filter((g) => g.entries.length > 0 || g.groups.length > 0);
}
