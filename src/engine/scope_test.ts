import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { isWithin, normalizeAbsolute, resolvePath, type PathScope } from "./scope.ts";

function firstArg(src: string) {
  return (parse(src).commands[0].command as Command).suffix[0];
}

Deno.test("normalizeAbsolute collapses . and ..", () => {
  assertEquals(normalizeAbsolute("/a/b/../c/./d"), "/a/c/d");
});

Deno.test("normalizeAbsolute keeps windows drive and uppercases it", () => {
  assertEquals(normalizeAbsolute("d:\\proj\\src"), "D:/proj/src");
});

Deno.test("isWithin: exact root and descendant true, sibling false", () => {
  assertEquals(isWithin("/proj", "/proj"), true);
  assertEquals(isWithin("/proj", "/proj/src/a.ts"), true);
  assertEquals(isWithin("/proj", "/proj-other/a"), false);
  assertEquals(isWithin("/proj", "/etc/passwd"), false);
});

Deno.test("resolvePath: relative in-project under known cwd", () => {
  const scope: PathScope = resolvePath(
    firstArg("cat src/a.ts"),
    { kind: "known", path: "/proj" },
    "/proj",
  );
  assertEquals(scope, "in-project");
});

Deno.test("resolvePath: absolute outside project", () => {
  assertEquals(
    resolvePath(firstArg("cat /etc/passwd"), { kind: "known", path: "/proj" }, "/proj"),
    "out-of-project",
  );
});

Deno.test("resolvePath: relative escaping via .. is out-of-project", () => {
  assertEquals(
    resolvePath(firstArg("cat ../secret"), { kind: "known", path: "/proj" }, "/proj"),
    "out-of-project",
  );
});

Deno.test("resolvePath: dynamic arg is dynamic", () => {
  assertEquals(
    resolvePath(firstArg("cat $X"), { kind: "known", path: "/proj" }, "/proj"),
    "dynamic",
  );
});

Deno.test("resolvePath: relative arg with unknown cwd is dynamic", () => {
  assertEquals(
    resolvePath(firstArg("cat a.ts"), { kind: "unknown" }, "/proj"),
    "dynamic",
  );
});

Deno.test("resolvePath: absolute arg resolves even when cwd unknown", () => {
  assertEquals(
    resolvePath(firstArg("cat /proj/a.ts"), { kind: "unknown" }, "/proj"),
    "in-project",
  );
});
