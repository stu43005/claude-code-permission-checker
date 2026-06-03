import { assertEquals } from "@std/assert";
import { parsePathRule } from "./path_scope.ts";

// 跨平台斷言一律用「多字母頂層段」路徑（如 /srv/...），normalizeAbsolute 在兩平台皆不改寫。
Deno.test("parsePathRule: // absolute /** -> root", () => {
  assertEquals(parsePathRule("Read(//srv/pkg/**)", null), { kind: "root", path: "/srv/pkg" });
});

Deno.test("parsePathRule: //** -> whole-filesystem root '/'", () => {
  // §7 邊界：base === "" → "/"；normalizeAbsolute("/") 兩平台皆為 "/"
  assertEquals(parsePathRule("Read(//**)", null), { kind: "root", path: "/" });
});

Deno.test("parsePathRule: ~/ /** -> root with home joined", () => {
  assertEquals(parsePathRule("Read(~/cache/**)", "/srv/home"), { kind: "root", path: "/srv/home/cache" });
});

Deno.test("parsePathRule: ~/ with home=null -> null", () => {
  assertEquals(parsePathRule("Read(~/cache/**)", null), null);
});

Deno.test("parsePathRule: no-glob single file -> file", () => {
  assertEquals(parsePathRule("Read(//srv/pkg/a.txt)", null), { kind: "file", path: "/srv/pkg/a.txt" });
  assertEquals(parsePathRule("Read(~/.zshrc)", "/srv/home"), { kind: "file", path: "/srv/home/.zshrc" });
});

Deno.test("parsePathRule: mid-glob or glob-in-base -> null", () => {
  assertEquals(parsePathRule("Read(//srv/dir/*.json)", null), null);
  assertEquals(parsePathRule("Read(//srv/**/foo)", null), null);
  assertEquals(parsePathRule("Read(//srv/a*b/**)", null), null);
  assertEquals(parsePathRule("Read(//srv/foo]/**)", null), null);
});

Deno.test("parsePathRule: non-target prefix -> null", () => {
  assertEquals(parsePathRule("Read(/src/**)", null), null);
  assertEquals(parsePathRule("Read(src/**)", null), null);
  assertEquals(parsePathRule("Read(./x)", null), null);
  assertEquals(parsePathRule("Read(.env)", null), null);
});

Deno.test("parsePathRule: negation -> null; non-RRW tool -> null", () => {
  assertEquals(parsePathRule("Read(!//srv/x)", null), null);
  assertEquals(parsePathRule("Bash(ls)", null), null);
});

Deno.test("parsePathRule: Edit/Write behave same as Read", () => {
  assertEquals(parsePathRule("Edit(//srv/pkg/**)", null), { kind: "root", path: "/srv/pkg" });
  assertEquals(parsePathRule("Write(//srv/pkg/a.txt)", null), { kind: "file", path: "/srv/pkg/a.txt" });
});

Deno.test({
  name: "parsePathRule: windows // drive -> C:/ form",
  ignore: Deno.build.os !== "windows",
  fn: () => {
    assertEquals(parsePathRule("Read(//c/Users/me/**)", null), { kind: "root", path: "C:/Users/me" });
  },
});

Deno.test({
  name: "parsePathRule: linux /c stays POSIX",
  ignore: Deno.build.os === "windows",
  fn: () => {
    assertEquals(parsePathRule("Read(//c/data/**)", null), { kind: "root", path: "/c/data" });
  },
});
