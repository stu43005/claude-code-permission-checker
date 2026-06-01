import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { isWithin, normalizeAbsolute, resolvePath, type PathScope } from "./scope.ts";

function firstArg(src: string) {
  return (parse(src).commands[0].command as Command).suffix[0];
}

Deno.test("normalizeAbsolute collapses . and ..", () => {
  // 多字母頂層段，純測 . / .. 折疊（單字母段會被當磁碟機，另有測試涵蓋）
  assertEquals(normalizeAbsolute("/srv/b/../c/./d"), "/srv/c/d");
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

Deno.test("normalizeAbsolute canonicalizes MSYS drive paths to Windows form", () => {
  assertEquals(normalizeAbsolute("/d/proj/src"), "D:/proj/src");
  assertEquals(normalizeAbsolute("/c/Users/x"), "C:/Users/x");
  assertEquals(normalizeAbsolute("/d"), "D:/");
  // 一般 POSIX 路徑（頂層段非單字母）不受影響
  assertEquals(normalizeAbsolute("/etc/passwd"), "/etc/passwd");
  assertEquals(normalizeAbsolute("/usr/bin"), "/usr/bin");
  assertEquals(normalizeAbsolute("/tmp"), "/tmp");
});

Deno.test("isWithin: /d/proj, D:/proj and D:\\proj are equivalent", () => {
  assertEquals(isWithin("D:/proj", "/d/proj"), true);
  assertEquals(isWithin("D:\\proj", "/d/proj/src/a.ts"), true);
  assertEquals(isWithin("/d/proj", "D:/proj/src"), true);
  // 不同磁碟仍視為專案外
  assertEquals(isWithin("D:/proj", "/c/Windows/system32"), false);
  assertEquals(isWithin("D:/proj", "/d/other"), false);
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
