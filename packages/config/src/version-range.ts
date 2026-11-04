/**
 * Exact versions and the small range syntax extensions use for `framework_range`
 * (design doc 06, for example `>=0.1.0 <0.2.0`).
 *
 * A range is one or more alternatives separated by `||`. Each alternative is a space-separated list
 * of comparators that must all hold: `>=`, `>`, `<=`, `<` or `=` followed by `MAJOR.MINOR.PATCH`,
 * or a bare version meaning `=`. Pre-release tags, wildcards, `^` and `~` are not accepted, so a
 * range always means exactly what it says.
 */

export type Version = readonly [number, number, number];

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const COMPARATOR = /^(>=|<=|>|<|=)?(.+)$/;

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

type Comparator = { operator: string; version: Version };

/** Parses a range, or returns null when any part of it is outside the supported syntax. */
export function parseRange(range: string): Comparator[][] | null {
  const alternatives = range.split("||").map((part) => part.trim());
  const parsed: Comparator[][] = [];
  for (const alternative of alternatives) {
    if (alternative === "") return null;
    const comparators: Comparator[] = [];
    for (const token of alternative.split(/\s+/)) {
      const match = COMPARATOR.exec(token);
      const version = match ? parseVersion(match[2] ?? "") : null;
      if (!match || !version) return null;
      comparators.push({ operator: match[1] ?? "=", version });
    }
    parsed.push(comparators);
  }
  return parsed;
}

/** True when the version satisfies the range. Throws for a malformed version or range. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsedVersion = parseVersion(version);
  const parsedRange = parseRange(range);
  if (!parsedVersion) throw new Error(`not a MAJOR.MINOR.PATCH version: ${JSON.stringify(version)}`);
  if (!parsedRange) throw new Error(`unsupported version range: ${JSON.stringify(range)}`);
  return parsedRange.some((comparators) =>
    comparators.every(({ operator, version: bound }) => {
      const order = compareVersions(parsedVersion, bound);
      switch (operator) {
        case ">=":
          return order >= 0;
        case ">":
          return order > 0;
        case "<=":
          return order <= 0;
        case "<":
          return order < 0;
        default:
          return order === 0;
      }
    }),
  );
}
