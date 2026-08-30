/**
 * The one definition of "safe Maven coordinate segment".
 *
 * Every route that turns caller-supplied text into a filesystem path component
 * - the `coordinate` target parsed by `parseCoordinate`, and the `dependency`
 * target that synthesises a coordinate from `group`/`name`/`version` - has to
 * agree on what a segment may contain, because they share the same downstream
 * sinks. Two copies of this rule would be two chances to disagree.
 *
 * Deliberately a leaf module: it imports nothing. `maven-resolver.ts` is the
 * chokepoint that enforces the rule and pulls in only `node:fs`, `node:path`
 * and `./errors.js`; importing it from `workspace-mapping-service.ts`, where
 * the rule used to live, would drag fast-glob and the whole workspace-detection
 * surface into the resolver's import graph.
 *
 * The name records where the rule was first enforced (a dependency target's
 * `version`). The grammar is now shared by all four segments of a coordinate,
 * with one deliberate split between them - see `SAFE_MAVEN_VALUE_RE` - and one
 * deliberately narrower variant for tokens read off disk rather than supplied
 * by a caller - see `isSafeMavenVersionToken`.
 */

/** The four components of `group:artifact:version[:classifier]`. */
export type MavenSegmentComponent = "groupId" | "artifactId" | "version" | "classifier";

/**
 * Characters an IDENTIFIER segment (`groupId`, `artifactId`) may contain.
 *
 * Everything else is out, path separators and NUL and control characters
 * included - a segment becomes a directory or file name verbatim.
 */
export const SAFE_MAVEN_TOKEN_RE = /^[A-Za-z0-9._+-]+$/;

/**
 * The same set plus U+0020, for a VALUE segment (`version`, `classifier`).
 *
 * Fabric publishes Yarn against Minecraft's own pre-release ids, and those ids
 * contain spaces: `net.fabricmc:yarn:1.14 Pre-Release 1+build.10:v2` is a real,
 * published coordinate. A rule without this branch refuses to resolve it - a
 * false rejection of a genuine artifact, which is the worse of the two failure
 * directions here, because a space is not a path separator and cannot traverse
 * a directory. Permitting it costs nothing in containment: the segment still
 * becomes exactly one path component, and every other escape character stays
 * out.
 *
 * `groupId` and `artifactId` stay on the identifier rule. Maven identifiers
 * never contain spaces and no real ecosystem coordinate uses one there, so
 * widening them would buy no artifact and only enlarge the accepted surface.
 */
const SAFE_MAVEN_VALUE_RE = /^[A-Za-z0-9._+ -]+$/;

/**
 * Upper bound on a segment. A sanity limit ONLY - it is not, and cannot be, a
 * control on the length of the file name a coordinate produces: `artifactId`,
 * `version` and `classifier` are concatenated into one name
 * (`<artifact>-<version>-<classifier>-sources.jar`), so three segments at this
 * bound still build a name past 600 characters. What the bound does buy is that
 * a pathological megabyte-long input cannot be spent building paths; the
 * filesystem's own NAME_MAX is what refuses an overlong file name, and it does
 * so on open, harmlessly.
 */
const MAX_MAVEN_TOKEN_LENGTH = 200;

/** Length, leading dot and `..` - the clauses every token shares. */
function passesCommonTokenRules(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MAVEN_TOKEN_LENGTH) {
    return false;
  }
  if (value.startsWith(".") || value.includes("..")) {
    return false;
  }
  // An already-trimmed value is the contract: a segment with leading or
  // trailing whitespace is rejected rather than repaired here, so the one place
  // that trims (each route, before it validates) stays the one place that
  // decides what "the caller's segment" is. That also keeps the space branch
  // from admitting a version of nothing but spaces.
  return value.trim() === value;
}

/**
 * The shared rule for a segment of a CALLER-SUPPLIED coordinate, per component.
 *
 * Both routes go through this and only this: `parseCoordinate` for a
 * `coordinate` target, and `synthesizeDependencyTarget` for the `group`, `name`
 * and explicit `version` of a `dependency` target. They cannot drift apart,
 * because there is no second definition for them to drift towards.
 */
export function isSafeMavenSegment(value: string, component: MavenSegmentComponent): boolean {
  if (!passesCommonTokenRules(value)) {
    return false;
  }
  const pattern =
    component === "version" || component === "classifier" ? SAFE_MAVEN_VALUE_RE : SAFE_MAVEN_TOKEN_RE;
  return pattern.test(value);
}

/**
 * The identifier grammar on its own, for a version token DISCOVERED in the
 * workspace rather than stated by a caller: a `gradle.properties` value, a
 * `modules-2` directory entry, an umbrella POM's `<version>`.
 *
 * It deliberately does NOT take the space branch, so this is narrower than
 * `isSafeMavenSegment(value, "version")`. The two inputs are not the same kind
 * of thing. A caller naming `1.14 Pre-Release 1+build.10` has stated which
 * artifact they want, and refusing it loses them a real one. A scan of
 * `~/.gradle/caches/modules-2/.../<name>/` is guessing which of somebody else's
 * directories is a version, and every name it admits becomes a candidate that
 * can make the resolution ambiguous or supply a version the project never
 * declared - so the narrower rule is the right default where nothing is lost by
 * it. Widening it is a separate decision with its own evidence, not a
 * consequence of this one.
 */
export function isSafeMavenVersionToken(token: string): boolean {
  return passesCommonTokenRules(token) && SAFE_MAVEN_TOKEN_RE.test(token);
}

/**
 * The rule in words, for an error message that must not drift from the code.
 *
 * `label` names the field that failed as the CALLER spells it, so a caller
 * reading the message can tell which of the four segments to fix; it defaults
 * to the component name, and the `dependency` route passes its own field names
 * (`group`, `name`) instead.
 */
export function describeSafeMavenSegmentRule(
  component: MavenSegmentComponent,
  label: string = component
): string {
  const allowed =
    component === "version" || component === "classifier"
      ? "[A-Za-z0-9._+-] characters or the space character"
      : "[A-Za-z0-9._+-] characters";
  return `${label} must contain only ${allowed}, must not start with '.', and must not include '..'.`;
}
