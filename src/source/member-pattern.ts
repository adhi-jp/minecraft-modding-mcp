/**
 * Match a class-member name against a `memberPattern` filter.
 *
 * Matching is case-insensitive substring. A `|` splits the pattern into OR
 * alternatives, so `"getStateForPlacement|canSurvive|setPlacedBy"` matches a
 * name that contains ANY of those tokens. Before this, the pattern was matched
 * as a single literal substring, so a piped pattern searched for a name
 * containing a literal `|` and matched nothing — which made member listing
 * return zero on large vanilla classes when callers used the natural OR syntax.
 *
 * Java member names never contain `|`, so treating `|` as OR never collides with
 * a legitimate substring search. Empty or whitespace-only alternatives are
 * dropped; a pattern with no usable alternative matches nothing (a non-empty
 * filter that excludes everything), matching the prior empty-filter behavior.
 */
export function matchesMemberPattern(name: string, pattern: string): boolean {
  const alternatives = pattern
    .split("|")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (alternatives.length === 0) {
    return false;
  }
  const lowerName = name.toLowerCase();
  return alternatives.some((alt) => lowerName.includes(alt));
}
