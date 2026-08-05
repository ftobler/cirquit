/**
 * The bundled example-circuit library.
 *
 * `setuplist.txt` is a flat file of groups and entries copied from upstream:
 * a line starting with `+` opens a group, `-` closes it, and everything else
 * is `<filename> <title>`. A leading `>` marks an entry as a variant of the
 * previous one; it is displayed the same way here.
 */

export interface LibraryEntry {
  file: string;
  title: string;
}

export interface LibraryGroup {
  title: string;
  entries: LibraryEntry[];
}

/** Where the circuit files live, relative to the deployed site. */
const CIRCUITS_BASE = `${import.meta.env.BASE_URL}circuits/`;

export function parseSetupList(text: string): LibraryGroup[] {
  const groups: LibraryGroup[] = [];
  const stack: LibraryGroup[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('+')) {
      const group: LibraryGroup = { title: line.slice(1).trim(), entries: [] };
      // Nested groups are flattened; the extra depth adds little here.
      groups.push(group);
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
    const current = stack[stack.length - 1];
    if (current) current.entries.push(entry);
  }

  return groups.filter((g) => g.entries.length > 0);
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
