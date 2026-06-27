import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { canonicalizeExecPath, dangerousRoot, isDangerousRootAbs, isReadScoped, isWithin, normalizeAbsolute, resolvePath, rootScope, type PathScope, type ScopeConfig } from "./scope.ts";
import type { CwdState } from "../types.ts";

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
    rootScope("/proj"),
  );
  assertEquals(scope, "in-project");
});

Deno.test("resolvePath: absolute outside project", () => {
  assertEquals(
    resolvePath(firstArg("cat /etc/passwd"), { kind: "known", path: "/proj" }, rootScope("/proj")),
    "out-of-project",
  );
});

Deno.test("resolvePath: relative escaping via .. is out-of-project", () => {
  assertEquals(
    resolvePath(firstArg("cat ../secret"), { kind: "known", path: "/proj" }, rootScope("/proj")),
    "out-of-project",
  );
});

Deno.test("resolvePath: dynamic arg is dynamic", () => {
  assertEquals(
    resolvePath(firstArg("cat $X"), { kind: "known", path: "/proj" }, rootScope("/proj")),
    "dynamic",
  );
});

Deno.test("resolvePath: relative arg with unknown cwd is dynamic", () => {
  assertEquals(
    resolvePath(firstArg("cat a.ts"), { kind: "unknown" }, rootScope("/proj")),
    "dynamic",
  );
});

Deno.test("resolvePath: absolute arg resolves even when cwd unknown", () => {
  assertEquals(
    resolvePath(firstArg("cat /proj/a.ts"), { kind: "unknown" }, rootScope("/proj")),
    "in-project",
  );
});

function scopeWith(
  allowRoots: string[] = [],
  denyRoots: string[] = [],
  askRoots: string[] = [],
  allowFiles: string[] = [],
): ScopeConfig {
  return {
    root: "/proj",
    home: null,
    allow: { roots: allowRoots, files: allowFiles },
    deny: { roots: denyRoots, files: [] },
    ask: { roots: askRoots, files: [] },
    trusted: [],
  };
}

Deno.test("isReadScoped: project root always in (root-first)", () => {
  assertEquals(isReadScoped("/proj/a", rootScope("/proj")), true);
});

Deno.test("isReadScoped: external allow root widens to in-scope", () => {
  assertEquals(isReadScoped("/srv/pkg/x", scopeWith(["/srv/pkg"])), true);
});

Deno.test("isReadScoped: external not covered -> false", () => {
  assertEquals(isReadScoped("/etc/passwd", scopeWith(["/srv/pkg"])), false);
});

Deno.test("isReadScoped: deny vetoes external allow", () => {
  assertEquals(isReadScoped("/srv/pkg/secret", scopeWith(["/srv/pkg"], ["/srv/pkg/secret"])), false);
});

Deno.test("isReadScoped: ask vetoes external allow", () => {
  assertEquals(isReadScoped("/srv/pkg/secret", scopeWith(["/srv/pkg"], [], ["/srv/pkg/secret"])), false);
});

Deno.test("isReadScoped: project path NOT demoted by external deny (root-first)", () => {
  assertEquals(isReadScoped("/proj/a", scopeWith([], ["/proj"])), true);
});

Deno.test("isReadScoped: allow file exact match only (no recurse)", () => {
  const s = scopeWith([], [], [], ["/srv/f.txt"]);
  assertEquals(isReadScoped("/srv/f.txt", s), true);
  assertEquals(isReadScoped("/srv/f.txt/child", s), false);
});

const KNOWN: CwdState = { kind: "known", path: "/proj" };

Deno.test("isDangerousRootAbs: 磁碟根 / 家目錄 / 子目錄", () => {
  assertEquals(isDangerousRootAbs("/", null), true);
  assertEquals(isDangerousRootAbs("C:/", null), true);
  assertEquals(isDangerousRootAbs("D:/", null), true);
  assertEquals(isDangerousRootAbs("/usr", null), false);
  assertEquals(isDangerousRootAbs("/home/me", "/home/me"), true);
  assertEquals(isDangerousRootAbs("/home/me/x", "/home/me"), false);
});

Deno.test("dangerousRoot: tilde 與磁碟根", () => {
  assertEquals(dangerousRoot(firstArg("find ~"), KNOWN, null), true);
  assertEquals(dangerousRoot(firstArg("find ~/"), KNOWN, null), true);
  assertEquals(dangerousRoot(firstArg("find /"), KNOWN, null), true);
  assertEquals(dangerousRoot(firstArg("find ~/.claude"), KNOWN, null), false);
  assertEquals(dangerousRoot(firstArg("find ."), KNOWN, null), false);
});

Deno.test("dangerousRoot: $HOME 各形式", () => {
  assertEquals(dangerousRoot(firstArg("find $HOME"), KNOWN, null), true);
  assertEquals(dangerousRoot(firstArg("find ${HOME}"), KNOWN, null), true);
  assertEquals(dangerousRoot(firstArg("find $HOME/"), KNOWN, null), true);
  assertEquals(dangerousRoot(firstArg("find $HOME/foo"), KNOWN, null), false);
  assertEquals(dangerousRoot(firstArg("find $HOMER"), KNOWN, null), false);
  assertEquals(dangerousRoot(firstArg("find ${HOME:-/tmp}"), KNOWN, null), false);
});

Deno.test("dangerousRoot: 靜態絕對等於 home（需 home）", () => {
  assertEquals(dangerousRoot(firstArg("find /home/me"), KNOWN, "/home/me"), true);
  assertEquals(dangerousRoot(firstArg("find /home/me"), KNOWN, null), false);
});

Deno.test("dangerousRoot: cwd 未知的相對路徑不可確認", () => {
  assertEquals(dangerousRoot(firstArg("find sub"), { kind: "unknown" }, null), false);
});

Deno.test("dangerousRoot: 磁碟根字面（跨平台）", () => {
  assertEquals(dangerousRoot(firstArg("find C:/"), KNOWN, null), true);
});

Deno.test({
  name: "dangerousRoot: $USERPROFILE 在 Windows 視為家目錄根",
  ignore: Deno.build.os !== "windows",
  fn() {
    assertEquals(dangerousRoot(firstArg("find $USERPROFILE"), KNOWN, null), true);
  },
});

Deno.test({
  name: "dangerousRoot: $USERPROFILE 在非 Windows 不算家目錄根",
  ignore: Deno.build.os === "windows",
  fn() {
    assertEquals(dangerousRoot(firstArg("find $USERPROFILE"), KNOWN, null), false);
  },
});

Deno.test("rootScope sets empty trusted", () => {
  assertEquals(rootScope("/proj").trusted, []);
});

Deno.test("canonicalizeExecPath: bare command name unchanged", () => {
  assertEquals(canonicalizeExecPath("git", null), "git");
  assertEquals(canonicalizeExecPath("cat", "/home/me"), "cat");
});

Deno.test("canonicalizeExecPath: folds middle // and removes . segment", () => {
  assertEquals(canonicalizeExecPath("/a//b/c", null), "/a/b/c");
  assertEquals(canonicalizeExecPath("/a/./b", null), "/a/b");
});

Deno.test("canonicalizeExecPath: home unavailable still normalizes non-tilde paths", () => {
  assertEquals(canonicalizeExecPath("/a//b", null), "/a/b");
});

Deno.test("canonicalizeExecPath: expands ~ and ~/x when home known", () => {
  assertEquals(canonicalizeExecPath("~", "/home/me"), "/home/me");
  assertEquals(canonicalizeExecPath("~/x/y", "/home/me"), "/home/me/x/y");
  assertEquals(canonicalizeExecPath("~/proj//tool.sh", "/home/me"), "/home/me/proj/tool.sh");
});

Deno.test("canonicalizeExecPath: ~ left literal when home is null", () => {
  assertEquals(canonicalizeExecPath("~/x", null), "~/x");
  assertEquals(canonicalizeExecPath("~", null), "~");
});

Deno.test("canonicalizeExecPath: .. segment left literal (symlink safety)", () => {
  assertEquals(canonicalizeExecPath("/a/../b", null), "/a/../b");
  assertEquals(canonicalizeExecPath("/allowed/link/../tool", null), "/allowed/link/../tool");
});

Deno.test("canonicalizeExecPath: '..' inside a filename is not a .. segment", () => {
  assertEquals(canonicalizeExecPath("/a//foo..bar", null), "/a/foo..bar");
});

Deno.test("canonicalizeExecPath: leading // (UNC) left literal", () => {
  assertEquals(canonicalizeExecPath("//server/share/tool", null), "//server/share/tool");
});

Deno.test("canonicalizeExecPath: zero-segment / bare-root collapse left literal", () => {
  assertEquals(canonicalizeExecPath("./", null), "./");
  assertEquals(canonicalizeExecPath("/.", null), "/.");
});

Deno.test("canonicalizeExecPath: slash token collapsing to bare name is left literal (category safety)", () => {
  assertEquals(canonicalizeExecPath("a/.", null), "a/.");
});

Deno.test("canonicalizeExecPath: relative stays relative, folds //", () => {
  assertEquals(canonicalizeExecPath("scripts//run.sh", null), "scripts/run.sh");
  assertEquals(canonicalizeExecPath("scripts/run.sh", null), "scripts/run.sh");
});

Deno.test("canonicalizeExecPath: preserves trailing slash (directory boundary)", () => {
  assertEquals(canonicalizeExecPath("/a/scripts/", null), "/a/scripts/");
});

Deno.test("canonicalizeExecPath: leading ./ kept literal (path-exec vs PATH-lookup)", () => {
  assertEquals(canonicalizeExecPath("./npm", null), "./npm");
  assertEquals(canonicalizeExecPath("./tool", null), "./tool");
});

Deno.test("canonicalizeExecPath: deeper ./a/b still normalizes (stays a path)", () => {
  assertEquals(canonicalizeExecPath("./a/b", null), "a/b");
  assertEquals(canonicalizeExecPath("./a//b", null), "a/b");
});

Deno.test("canonicalizeExecPath: ~ expansion into a UNC home is declined (fail-closed)", () => {
  assertEquals(canonicalizeExecPath("~/tool", "//server/share/user"), "~/tool");
  assertEquals(canonicalizeExecPath("~", "//server/share/user"), "~");
});

Deno.test("canonicalizeExecPath: ~ expansion into a home with a .. segment is declined", () => {
  assertEquals(canonicalizeExecPath("~/tool", "/home/../etc"), "~/tool");
});

Deno.test("canonicalizeExecPath: ~ expansion into a normal absolute home still works", () => {
  assertEquals(canonicalizeExecPath("~/tool", "/home/me"), "/home/me/tool");
});

Deno.test({
  name: "canonicalizeExecPath: POSIX backslash kept literal (not a separator)",
  ignore: Deno.build.os === "windows",
  fn() {
    assertEquals(canonicalizeExecPath("/tmp/foo\\bar", null), "/tmp/foo\\bar");
    assertEquals(canonicalizeExecPath("foo\\bar", null), "foo\\bar");
  },
});

Deno.test("isReadScoped: trusted root grants read; root-first and deny/ask override", () => {
  const SID = "/home/me/.claude/projects/-proj/115826ef-e830-461f-8101-edac56694d2b";
  const scope: ScopeConfig = { ...rootScope("/proj"), trusted: [SID] };
  // trusted 子路徑可讀
  assertEquals(isReadScoped(SID + "/tool-results/x.txt", scope), true);
  assertEquals(isReadScoped(SID, scope), true);
  // 專案內仍 root-first
  assertEquals(isReadScoped("/proj/src/a.ts", scope), true);
  // trusted 外（同專案 memory）仍 false
  assertEquals(isReadScoped("/home/me/.claude/projects/-proj/memory/x", scope), false);
  // deny 覆蓋 trusted（deny > allow=trusted）
  const denied: ScopeConfig = { ...scope, deny: { roots: [SID], files: [] } };
  assertEquals(isReadScoped(SID + "/x", denied), false);
  // ask 覆蓋 trusted
  const asked: ScopeConfig = { ...scope, ask: { roots: [SID], files: [] } };
  assertEquals(isReadScoped(SID + "/x", asked), false);
});
