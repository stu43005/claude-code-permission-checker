import { assertEquals } from "@std/assert";
import { parseCommand } from "../engine/parse.ts";
import { walk } from "../engine/walk.ts";
import type { CwdState } from "../types.ts";
import { matchesAny, matchesPattern, parseBashRule, reconstructCommand, settingsAllows } from "./matcher.ts";
import type { PermissionRules } from "./settings.ts";
import { EMPTY_READ_SCOPE } from "./path_scope.ts";
import { EMPTY_DOMAIN_SCOPE } from "./domain_scope.ts";

const ROOT = "/proj";
const START: CwdState = { kind: "known", path: "/proj" };

/** 取單一指令的第一筆 invocation。 */
function firstInv(src: string) {
  return walk(parseCommand(src).script, START, ROOT)[0];
}

Deno.test("parseBashRule: :* -> prefix-boundary", () => {
  assertEquals(parseBashRule("Bash(npm test:*)"), { kind: "prefix-boundary", prefix: "npm test" });
});

Deno.test("parseBashRule: space-star -> prefix-boundary", () => {
  assertEquals(parseBashRule("Bash(ls *)"), { kind: "prefix-boundary", prefix: "ls" });
});

Deno.test("parseBashRule: trailing star no space -> prefix-loose", () => {
  assertEquals(parseBashRule("Bash(ls*)"), { kind: "prefix-loose", prefix: "ls" });
});

Deno.test("parseBashRule: no star -> exact", () => {
  assertEquals(parseBashRule("Bash(git status)"), { kind: "exact", text: "git status" });
});

Deno.test("parseBashRule: non-Bash tool -> null", () => {
  assertEquals(parseBashRule("Read(./x)"), null);
});

Deno.test("parseBashRule: mid-star -> null", () => {
  assertEquals(parseBashRule("Bash(git * --x)"), null);
  assertEquals(parseBashRule("Bash(git * status:*)"), null);
});

Deno.test("parseBashRule: empty inner -> null", () => {
  assertEquals(parseBashRule("Bash()"), null);
});

Deno.test("parseBashRule: empty prefix (matches all) -> null", () => {
  assertEquals(parseBashRule("Bash(*)"), null);
  assertEquals(parseBashRule("Bash(:*)"), null);
  assertEquals(parseBashRule("Bash( *)"), null);
});

Deno.test("parseBashRule: not Bash(...) shape -> null", () => {
  assertEquals(parseBashRule("Bash(ls"), null);
  assertEquals(parseBashRule("npm test"), null);
});

Deno.test("matchesPattern: prefix-boundary matches prefix and prefix+space, not glued", () => {
  const p = parseBashRule("Bash(ls *)")!;
  assertEquals(matchesPattern("ls", p), true);
  assertEquals(matchesPattern("ls -la", p), true);
  assertEquals(matchesPattern("lsof", p), false);
});

Deno.test("matchesPattern: prefix-loose matches glued", () => {
  const p = parseBashRule("Bash(ls*)")!;
  assertEquals(matchesPattern("lsof", p), true);
  assertEquals(matchesPattern("ls -la", p), true);
});

Deno.test("matchesPattern: exact matches only equal", () => {
  const p = parseBashRule("Bash(git status)")!;
  assertEquals(matchesPattern("git status", p), true);
  assertEquals(matchesPattern("git status --short", p), false);
});

Deno.test("matchesAny: true if any pattern matches", () => {
  const pats = [parseBashRule("Bash(git status)")!, parseBashRule("Bash(npm test:*)")!];
  assertEquals(matchesAny("npm test --silent", pats), true);
  assertEquals(matchesAny("rm -rf x", pats), false);
});

Deno.test("reconstructCommand: name + static argv joined by single space", () => {
  assertEquals(reconstructCommand(firstInv("git diff --stat")), "git diff --stat");
});

Deno.test("reconstructCommand: quoted arg is de-quoted, single-space joined", () => {
  assertEquals(reconstructCommand(firstInv('grep "foo bar" f')), "grep foo bar f");
});

Deno.test("reconstructCommand: dynamic argv (variable) -> null", () => {
  assertEquals(reconstructCommand(firstInv("cat $FILE")), null);
});

Deno.test("reconstructCommand: command substitution arg -> null", () => {
  assertEquals(reconstructCommand(firstInv("cat $(ls)")), null);
});

Deno.test("reconstructCommand: unquoted glob arg -> null", () => {
  assertEquals(reconstructCommand(firstInv("cat *.txt")), null);
});

Deno.test("reconstructCommand: assignment prefix -> null", () => {
  assertEquals(reconstructCommand(firstInv("FOO=bar cat a")), null);
});

Deno.test("reconstructCommand: dynamic command name -> null", () => {
  assertEquals(reconstructCommand(firstInv("$CMD a")), null);
});

/** 由字串規則組出 PermissionRules。 */
function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return {
    bash: { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) },
    readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
    webFetch: { allow: EMPTY_DOMAIN_SCOPE, deny: EMPTY_DOMAIN_SCOPE, ask: EMPTY_DOMAIN_SCOPE },
  };
}

Deno.test("settingsAllows: allow match -> true", () => {
  assertEquals(settingsAllows(firstInv("npm test --silent"), rulesOf({ allow: ["Bash(npm test:*)"] }), null), true);
});

Deno.test("settingsAllows: also denied -> false", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"], deny: ["Bash(npm test:*)"] });
  assertEquals(settingsAllows(firstInv("npm test"), rules, null), false);
});

Deno.test("settingsAllows: also asked -> false", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"], ask: ["Bash(npm test:*)"] });
  assertEquals(settingsAllows(firstInv("npm test"), rules, null), false);
});

Deno.test("settingsAllows: no allow match -> false", () => {
  assertEquals(settingsAllows(firstInv("npm run build"), rulesOf({ allow: ["Bash(npm test:*)"] }), null), false);
});

Deno.test("settingsAllows: non-reconstructable (dynamic) -> false", () => {
  assertEquals(settingsAllows(firstInv("cat $FILE"), rulesOf({ allow: ["Bash(cat:*)"] }), null), false);
});

Deno.test("settingsAllows: ~ pattern + // command upgrades (the motivating case)", () => {
  assertEquals(
    settingsAllows(
      firstInv("/home/me/proj//tool.sh --x"),
      rulesOf({ allow: ["Bash(~/proj/tool.sh *)"] }),
      "/home/me",
    ),
    true,
  );
});

Deno.test("settingsAllows: ~ pattern not expanded when home is null -> no upgrade", () => {
  assertEquals(
    settingsAllows(
      firstInv("/home/me/proj/tool.sh --x"),
      rulesOf({ allow: ["Bash(~/proj/tool.sh *)"] }),
      null,
    ),
    false,
  );
});

Deno.test("settingsAllows: // folding upgrades without ~ (home irrelevant)", () => {
  assertEquals(
    settingsAllows(firstInv("/opt/t//run.sh --x"), rulesOf({ allow: ["Bash(/opt/t/run.sh *)"] }), null),
    true,
  );
});

Deno.test("settingsAllows: union non-regression - existing literal allow still matches", () => {
  assertEquals(
    settingsAllows(firstInv("npm test --silent"), rulesOf({ allow: ["Bash(npm test:*)"] }), null),
    true,
  );
});

Deno.test("settingsAllows: spaced exec path deny preserved via raw branch (not bypassed)", () => {
  const rules = rulesOf({
    allow: ["Bash(/o/My App/run.sh *)"],
    deny: ["Bash(/o/My App/run.sh *)"],
  });
  assertEquals(settingsAllows(firstInv('"/o/My App/run.sh" x'), rules, null), false);
});

Deno.test("settingsAllows: spaced exec path allow matches via raw branch", () => {
  assertEquals(
    settingsAllows(firstInv('"/o/My App/run.sh" x'), rulesOf({ allow: ["Bash(/o/My App/run.sh *)"] }), null),
    true,
  );
});

Deno.test("settingsAllows: .. in command stays literal -> folded allow does not match", () => {
  assertEquals(
    settingsAllows(firstInv("/allowed/link/../tool x"), rulesOf({ allow: ["Bash(/allowed/tool *)"] }), null),
    false,
  );
});

Deno.test("settingsAllows: UNC fail-closed - local allow does not match UNC command", () => {
  assertEquals(
    settingsAllows(firstInv("//server/share/tool x"), rulesOf({ allow: ["Bash(/server/share/tool *)"] }), null),
    false,
  );
});

Deno.test("settingsAllows: identical UNC literal matches", () => {
  assertEquals(
    settingsAllows(firstInv("//server/share/tool x"), rulesOf({ allow: ["Bash(//server/share/tool *)"] }), null),
    true,
  );
});

Deno.test("settingsAllows: zero-segment pattern ./ does not match everything", () => {
  assertEquals(settingsAllows(firstInv("rm -rf /"), rulesOf({ allow: ["Bash(./*)"] }), null), false);
});

Deno.test("settingsAllows: deny equivalent (only differs by //) blocks upgrade", () => {
  const rules = rulesOf({
    allow: ["Bash(/opt/t/run.sh *)"],
    deny: ["Bash(/opt//t/run.sh *)"],
  });
  assertEquals(settingsAllows(firstInv("/opt/t/run.sh x"), rules, null), false);
});

Deno.test("settingsAllows: ask equivalent (only differs by //) blocks upgrade", () => {
  const rules = rulesOf({
    allow: ["Bash(/opt/t/run.sh *)"],
    ask: ["Bash(/opt//t/run.sh *)"],
  });
  assertEquals(settingsAllows(firstInv("/opt/t/run.sh x"), rules, null), false);
});

Deno.test("settingsAllows: case mismatch is not aligned -> no upgrade (case-sensitive)", () => {
  assertEquals(
    settingsAllows(firstInv("/opt/t/run.sh x"), rulesOf({ allow: ["Bash(/Opt/T/run.sh *)"] }), null),
    false,
  );
});

// --- matcher-level acceptance for path normalization (not only the unit-level function) ---

Deno.test("settingsAllows: middle . segment removal matches at matcher level", () => {
  assertEquals(
    settingsAllows(firstInv("/a/./b x"), rulesOf({ allow: ["Bash(/a/b *)"] }), null),
    true,
  );
});

Deno.test("settingsAllows: identical .. literal on both sides matches", () => {
  assertEquals(
    settingsAllows(
      firstInv("/allowed/link/../tool x"),
      rulesOf({ allow: ["Bash(/allowed/link/../tool *)"] }),
      null,
    ),
    true,
  );
});

Deno.test("settingsAllows: '..' inside filename does not trigger guard, // still folds", () => {
  assertEquals(
    settingsAllows(firstInv("/a//foo..bar x"), rulesOf({ allow: ["Bash(/a/foo..bar *)"] }), null),
    true,
  );
});

Deno.test("settingsAllows: prefix-loose with .. stays literal (a/..*), not overbroad", () => {
  assertEquals(
    settingsAllows(firstInv("a/../b x"), rulesOf({ allow: ["Bash(a/..*)"] }), null),
    true,
  );
  assertEquals(
    settingsAllows(firstInv("a/b x"), rulesOf({ allow: ["Bash(a/..*)"] }), null),
    false,
  );
});

Deno.test("settingsAllows: trailing-slash prefix boundary - matches child, not sibling", () => {
  const rules = rulesOf({ allow: ["Bash(/a/scripts/*)"] });
  assertEquals(settingsAllows(firstInv("/a/scripts/x y"), rules, null), true);
  assertEquals(settingsAllows(firstInv("/a/scriptsEVIL y"), rules, null), false);
});

Deno.test("settingsAllows: relative pattern does not match absolute command", () => {
  assertEquals(
    settingsAllows(firstInv("/proj/scripts/run.sh x"), rulesOf({ allow: ["Bash(scripts/run.sh *)"] }), null),
    false,
  );
});

Deno.test("settingsAllows: relative pattern matches relative command (// folded)", () => {
  assertEquals(
    settingsAllows(firstInv("scripts//run.sh x"), rulesOf({ allow: ["Bash(scripts/run.sh *)"] }), null),
    true,
  );
});

Deno.test("settingsAllows: degenerate deny pattern ./ does not over-block unrelated allow", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"], deny: ["Bash(./*)"] });
  assertEquals(settingsAllows(firstInv("npm test x"), rules, null), true);
});

Deno.test("settingsAllows: spaced deny containing // still blocks via raw branch", () => {
  const rules = rulesOf({
    allow: ["Bash(/o/My App//run.sh *)"],
    deny: ["Bash(/o/My App//run.sh *)"],
  });
  assertEquals(settingsAllows(firstInv('"/o/My App//run.sh" x'), rules, null), false);
});

// Spaced-exec-path deny-precedence safety net. The pattern head-split only normalizes the
// pattern's first whitespace-delimited token, so a `//` in a spaced pattern path after the
// first space is not folded. This never weakens deny vs. the official (raw-literal) baseline:
// whenever the COMMAND carries `//` (the only case our normalization could add an allow), the
// path-equivalent deny still blocks — via the raw branch for a `//`-deny, or via the canon
// branch for a `/`-deny. A `//`-deny against a `/`-command does not match under official
// literal semantics either, so matching that is out of scope (not a regression).
Deno.test("settingsAllows: spaced // command blocked by single-/ deny via canon branch", () => {
  const rules = rulesOf({
    allow: ["Bash(/o/My App/run.sh *)"],
    deny: ["Bash(/o/My App/run.sh *)"],
  });
  assertEquals(settingsAllows(firstInv('"/o/My App//run.sh" x'), rules, null), false);
});

Deno.test("settingsAllows: spaced // command blocked by // deny even when allow is single-/", () => {
  const rules = rulesOf({
    allow: ["Bash(/o/My App/run.sh *)"],
    deny: ["Bash(/o/My App//run.sh *)"],
  });
  assertEquals(settingsAllows(firstInv('"/o/My App//run.sh" x'), rules, null), false);
});

Deno.test("settingsAllows: spaced / command + // deny matches official (deny // does not apply to / cmd)", () => {
  // Official Claude Code (raw literal) would allow this: allow '/o/My App/run.sh *' matches the
  // '/'-command, and deny '/o/My App//run.sh *' does NOT match a '/'-command. We reproduce that
  // exactly via the raw branch — no normalization-induced upgrade, hence no deny weakening.
  const rules = rulesOf({
    allow: ["Bash(/o/My App/run.sh *)"],
    deny: ["Bash(/o/My App//run.sh *)"],
  });
  assertEquals(settingsAllows(firstInv('"/o/My App/run.sh" x'), rules, null), true);
});

Deno.test("settingsAllows: ./local exec is NOT upgraded by a PATH allow rule (no bypass)", () => {
  assertEquals(
    settingsAllows(firstInv("./npm install"), rulesOf({ allow: ["Bash(npm *)"] }), null),
    false,
  );
});

Deno.test("settingsAllows: ./tool pattern does NOT match a bare PATH tool command", () => {
  assertEquals(
    settingsAllows(firstInv("tool x"), rulesOf({ allow: ["Bash(./tool *)"] }), null),
    false,
  );
});

Deno.test("settingsAllows: deeper ./a/b command still matches relative a/b allow (legit equivalence)", () => {
  assertEquals(
    settingsAllows(firstInv("./a/b x"), rulesOf({ allow: ["Bash(a/b *)"] }), null),
    true,
  );
});

Deno.test("settingsAllows: quoted-tilde command is NOT expanded -> home-absolute allow does not match (no bypass)", () => {
  // Bash does not tilde-expand a quoted "~/...". The command side must not expand it either,
  // otherwise a literal ~-named file would be auto-allowed as the home-dir absolute path.
  assertEquals(
    settingsAllows(
      firstInv('"~/proj/tool.sh" x'),
      rulesOf({ allow: ["Bash(/home/me/proj/tool.sh *)"] }),
      "/home/me",
    ),
    false,
  );
});

Deno.test("settingsAllows: spaced-path allow not matched across exec/argv boundary by a // command (no bypass)", () => {
  // command executes /tmp//My (== /tmp/My), with argv "App/run.sh"; the spaced allow targets a
  // DIFFERENT executable /tmp/My App/run.sh. The canon exec-boundary gate must reject this.
  assertEquals(
    settingsAllows(
      firstInv('"/tmp//My" "App/run.sh" evil'),
      rulesOf({ allow: ["Bash(/tmp/My App/run.sh *)"] }),
      null,
    ),
    false,
  );
});

Deno.test("settingsAllows: exec-boundary gate does not over-block deny either (canon precision)", () => {
  // Symmetric to the allow case: a // command whose real exec is /tmp/My must NOT be canon-matched
  // by a spaced deny meant for the different exec /tmp/My App/run.sh. Official (raw) does not match
  // it; with only this deny and no allow, the result is no-upgrade (false) regardless, but this
  // locks that the gate applies symmetrically.
  assertEquals(
    settingsAllows(
      firstInv('"/tmp//My" "App/run.sh" evil'),
      rulesOf({ deny: ["Bash(/tmp/My App/run.sh *)"] }),
      null,
    ),
    false,
  );
});

Deno.test("settingsAllows: exec-only pattern still upgrades a // command (gate allows in-exec match)", () => {
  // The motivating shape: pattern's exec-path == command's exec token (lengths equal after folding).
  assertEquals(
    settingsAllows(
      firstInv("/opt/t//run.sh --x"),
      rulesOf({ allow: ["Bash(/opt/t/run.sh *)"] }),
      null,
    ),
    true,
  );
});
