import { assertEquals } from "@std/assert";
import type { EnvReader } from "../project.ts";
import { EMPTY_RULES, loadPermissionRules, type ReadText } from "./settings.ts";

const ROOT = "/proj";

/** 以 map 模擬讀檔；未列入的路徑回 null（不存在）。 */
function fakeReadText(map: Record<string, string>): ReadText {
  return (path) => (path in map ? map[path] : null);
}

/** 以 map 模擬環境變數。 */
function fakeEnv(map: Record<string, string>): EnvReader {
  return { get: (k) => map[k] };
}

const noHome = fakeEnv({});

Deno.test("EMPTY_RULES has three empty lists", () => {
  assertEquals(EMPTY_RULES, { allow: [], deny: [], ask: [] });
});

Deno.test("extracts Bash rules from a single project settings file", () => {
  const content = JSON.stringify({
    permissions: {
      allow: ["Bash(npm test:*)", "Read(./x)", 123, "Bash(git status)"],
      deny: ["Bash(rm:*)"],
      ask: ["Bash(curl:*)"],
    },
  });
  const rules = loadPermissionRules(
    noHome,
    ROOT,
    fakeReadText({ "/proj/.claude/settings.json": content }),
  );
  assertEquals(rules.allow, [
    { kind: "prefix-boundary", prefix: "npm test" },
    { kind: "exact", text: "git status" },
  ]);
  assertEquals(rules.deny, [{ kind: "prefix-boundary", prefix: "rm" }]);
  assertEquals(rules.ask, [{ kind: "prefix-boundary", prefix: "curl" }]);
});

Deno.test("missing file -> empty", () => {
  const rules = loadPermissionRules(noHome, ROOT, fakeReadText({}));
  assertEquals(rules, { allow: [], deny: [], ask: [] });
});

Deno.test("malformed JSON -> empty, no throw", () => {
  const rules = loadPermissionRules(
    noHome,
    ROOT,
    fakeReadText({ "/proj/.claude/settings.json": "not json {{{" }),
  );
  assertEquals(rules, { allow: [], deny: [], ask: [] });
});

Deno.test("permissions not an object -> empty", () => {
  const rules = loadPermissionRules(
    noHome,
    ROOT,
    fakeReadText({ "/proj/.claude/settings.json": JSON.stringify({ permissions: 42 }) }),
  );
  assertEquals(rules, { allow: [], deny: [], ask: [] });
});

Deno.test("top-level not an object (array/number) -> empty", () => {
  const rules = loadPermissionRules(
    noHome,
    ROOT,
    fakeReadText({ "/proj/.claude/settings.json": "[1,2,3]" }),
  );
  assertEquals(rules, { allow: [], deny: [], ask: [] });
});

Deno.test("rule list not an array -> that list empty", () => {
  const content = JSON.stringify({ permissions: { allow: "Bash(ls:*)", deny: ["Bash(rm:*)"] } });
  const rules = loadPermissionRules(
    noHome,
    ROOT,
    fakeReadText({ "/proj/.claude/settings.json": content }),
  );
  assertEquals(rules.allow, []);
  assertEquals(rules.deny, [{ kind: "prefix-boundary", prefix: "rm" }]);
});

Deno.test("merges project + local + user (union)", () => {
  const env = fakeEnv({ HOME: "/home/u", USERPROFILE: "/home/u" });
  const rules = loadPermissionRules(
    env,
    ROOT,
    fakeReadText({
      "/proj/.claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(a:*)"] } }),
      "/proj/.claude/settings.local.json": JSON.stringify({ permissions: { allow: ["Bash(b:*)"] } }),
      "/home/u/.claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(c:*)"] } }),
    }),
  );
  assertEquals(rules.allow.map((p) => (p as { prefix: string }).prefix), ["a", "b", "c"]);
});

Deno.test("requests the three expected file paths (posix home)", () => {
  const requested: string[] = [];
  const reader: ReadText = (path) => {
    requested.push(path);
    return null;
  };
  loadPermissionRules(fakeEnv({ HOME: "/home/u" }), ROOT, reader);
  assertEquals(requested, [
    "/proj/.claude/settings.json",
    "/proj/.claude/settings.local.json",
    "/home/u/.claude/settings.json",
  ]);
});

Deno.test("no home env -> only project paths requested", () => {
  const requested: string[] = [];
  const reader: ReadText = (path) => {
    requested.push(path);
    return null;
  };
  loadPermissionRules(noHome, ROOT, reader);
  assertEquals(requested, [
    "/proj/.claude/settings.json",
    "/proj/.claude/settings.local.json",
  ]);
});

Deno.test({
  name: "windows: USERPROFILE preferred; backslashes normalized",
  ignore: Deno.build.os !== "windows",
  fn() {
    const requested: string[] = [];
    const reader: ReadText = (path) => {
      requested.push(path);
      return null;
    };
    loadPermissionRules(fakeEnv({ USERPROFILE: "C:\\Users\\X", HOME: "/c/other" }), "D:/proj", reader);
    assertEquals(requested[2], "C:/Users/X/.claude/settings.json");
  },
});

Deno.test({
  name: "windows: falls back to HOME when USERPROFILE missing (MSYS form normalized)",
  ignore: Deno.build.os !== "windows",
  fn() {
    const requested: string[] = [];
    const reader: ReadText = (path) => {
      requested.push(path);
      return null;
    };
    loadPermissionRules(fakeEnv({ HOME: "/c/Users/X" }), "D:/proj", reader);
    assertEquals(requested[2], "C:/Users/X/.claude/settings.json");
  },
});
