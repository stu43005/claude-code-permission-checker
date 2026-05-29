import { assertEquals } from "@std/assert";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
import { classify } from "./classify.ts";
import type { CwdState } from "../types.ts";

const ROOT = "/proj";
const START: CwdState = { kind: "known", path: "/proj" };

function only(src: string) {
  const invs = walk(parseCommand(src).script, START, ROOT);
  return classify(invs[0], ROOT);
}

Deno.test("dynamic command name asks", () => {
  assertEquals(only("$CMD a").kind, "ask");
});

Deno.test("not-in-allowlist asks", () => {
  assertEquals(only("rm -rf x").kind, "ask");
});

Deno.test("known-out-of-project cwd asks before rule", () => {
  const invs = walk(parseCommand("cd /tmp && cat a").script, START, ROOT);
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(classify(cat, ROOT).kind, "ask");
});

Deno.test("write redirect asks", () => {
  assertEquals(only("echo hi > out.txt").kind, "ask");
});

Deno.test("read-only in-project allows", () => {
  assertEquals(only("cat src/a.ts").kind, "allow");
});

Deno.test("null-device redirect still allows", () => {
  assertEquals(only("grep x f 2>/dev/null").kind, "allow");
});
