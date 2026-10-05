// Heuristic: which files does a shell command write? Agents often edit with sed -i, redirects or formatters instead
// of their edit tools, and both loop detection and the done check need to know an edit happened.
// Returns the files it can name, ['?'] when it clearly writes but the target is unclear, or [] for no write.
// ponytail: regex over the command line, no shell parser. Misses writes hidden in scripts (node -e, python -c);
// upgrade to a real shell tokenizer if false negatives matter.

const WRITERS: { re: RegExp; target?: RegExp }[] = [
  { re: /\bsed\b[^|;&]*\s-i\b|\bsed\s+-[a-zA-Z]*i/, target: /(\S+)\s*$/ }, // sed -i ... file
  { re: /\bperl\b[^|;&]*\s-[a-zA-Z]*p[a-zA-Z]*i|\bperl\b[^|;&]*\s-[a-zA-Z]*i[a-zA-Z]*p/, target: /(\S+)\s*$/ },
  { re: /\btee\b(?:\s+-a)?\s+(\S+)/ },
  { re: /\b(?:cp|mv)\b(?:\s+-\S+)*\s+\S+\s+(\S+)/ }, // last argument is the destination
  { re: /\brm\b(?:\s+-\S+)*\s+(\S+)/ },
  { re: /\bgit\s+(?:apply|am|checkout\s+--|restore)\b/ },
  { re: /\bpatch\b\s+(?:-\S+\s+)*(\S+)?/ },
  { re: /\b(?:prettier|biome)\b[^|;&]*--write\b/ },
  { re: /\b(?:eslint|ruff|rubocop)\b[^|;&]*--fix\b/ },
  { re: /\b(?:black|gofmt\s+-w|cargo\s+fmt|ruff\s+format)\b/ },
];
// Redirect into a file: > or >> followed by a path. Not 2>&1, not >&2, not /dev/null, not process substitution.
const REDIRECT = /(?:^|[^\d&>])>>?\s*(?!&|\/dev\/null|\()([^\s;&|<>]+)/g;

const clean = (p: string) => p.replace(/^['"]|['"]$/g, '');

export function shellWrites(command: string): string[] {
  const files = new Set<string>();
  let unknown = false;
  // Look at each simple command of a pipeline/list separately.
  for (const part of command.split(/&&|\|\||;|\n/)) {
    for (const m of part.matchAll(REDIRECT)) files.add(clean(m[1]));
    for (const w of WRITERS) {
      const m = w.re.exec(part);
      if (!m) continue;
      const t = w.target ? w.target.exec(part)?.[1] : m[1];
      if (t && !t.startsWith('-')) files.add(clean(t)); else unknown = true;
    }
  }
  return files.size ? [...files] : unknown ? ['?'] : [];
}
