const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'];

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
}

/** Counts delimiter occurrences outside of quoted sections (a quoted field may contain the delimiter). */
function countUnquotedOccurrences(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delimiter && !inQuotes) count++;
  }
  return count;
}

/**
 * Picks the delimiter that's both present and used consistently (same count on every sampled
 * line) — favouring consistency over raw frequency avoids e.g. picking a comma that only shows up
 * inside one free-text cell while every row is actually semicolon-separated.
 */
export function detectDelimiter(text: string): string {
  const lines = splitLines(text).slice(0, 20);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = -1;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = lines.map((line) => countUnquotedOccurrences(line, delimiter));
    const total = counts.reduce((sum, c) => sum + c, 0);
    if (total === 0) continue;
    const consistent = counts.every((c) => c === counts[0]);
    const score = total + (consistent ? 1000 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** Parses one line into fields, supporting "quoted, fields" with "" as an escaped quote. */
function parseLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"' && current === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

/**
 * Splits pasted CSV-ish text into rows of trimmed cells. Delimiter is auto-detected (comma,
 * semicolon, tab, or pipe) unless explicitly passed. Blank lines are skipped. Note: quoted fields
 * spanning multiple lines aren't supported — each line is parsed independently, which covers the
 * common case of pasting simple single-line text/number cells from a spreadsheet.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const delim = delimiter ?? detectDelimiter(text);
  return splitLines(text).map((line) => parseLine(line, delim));
}
