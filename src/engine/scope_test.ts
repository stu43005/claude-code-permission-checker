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

// 多字母頂層段的 POSIX 路徑：跨平台皆不應被改寫
Deno.test("normalizeAbsolute leaves multi-letter POSIX top segments intact", () => {
  assertEquals(normalizeAbsolute("/etc/passwd"), "/etc/passwd");
  assertEquals(normalizeAbsolute("/usr/bin"), "/usr/bin");
  assertEquals(normalizeAbsolute("/tmp"), "/tmp");
});

// MSYS `/d/` ↔ `D:/` 等價僅在 Windows 成立；Linux/macOS 上 `/d/` 是真實 POSIX 路徑
Deno.test({
  name: "normalizeAbsolute canonicalizes MSYS drive paths to Windows form (Windows only)",
  ignore: Deno.build.os !== "windows",
  fn() {
    assertEquals(normalizeAbsolute("/d/proj/src"), "D:/proj/src");
    assertEquals(normalizeAbsolute("/c/Users/x"), "C:/Users/x");
    assertEquals(normalizeAbsolute("/d"), "D:/");
  },
});

Deno.test({
  name: "isWithin: /d/proj, D:/proj and D:\\proj are equivalent (Windows only)",
  ignore: Deno.build.os !== "windows",
  fn() {
    assertEquals(isWithin("D:/proj", "/d/proj"), true);
    assertEquals(isWithin("D:\\proj", "/d/proj/src/a.ts"), true);
    assertEquals(isWithin("/d/proj", "D:/proj/src"), true);
    // 不同磁碟仍視為專案外
    assertEquals(isWithin("D:/proj", "/c/Windows/system32"), false);
    assertEquals(isWithin("D:/proj", "/d/other"), false);
  },
});

// Linux/macOS：單字母頂層段是真實 POSIX 路徑，不可改寫成磁碟形式
Deno.test({
  name: "normalizeAbsolute keeps single-letter POSIX top segments on non-Windows",
  ignore: Deno.build.os === "windows",
  fn() {
    assertEquals(normalizeAbsolute("/a/c/d"), "/a/c/d");
    assertEquals(isWithin("/a/c/d", "/a/c/d/file"), true);
    assertEquals(isWithin("/a/c/d", "/A/c/d/file"), false); // 區分大小寫
  },
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
