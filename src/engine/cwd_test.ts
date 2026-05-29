import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { applyCd, gitEffectiveCwd, isCd } from "./cwd.ts";

function cmdOf(src: string): Command {
  return parse(src).commands[0].command as Command;
}

Deno.test("isCd recognises cd", () => {
  assertEquals(isCd(cmdOf("cd src")), true);
  assertEquals(isCd(cmdOf("cat src")), false);
});

Deno.test("applyCd: static relative path updates known cwd", () => {
  const next = applyCd(cmdOf("cd src"), { kind: "known", path: "/proj" });
  assertEquals(next, { kind: "known", path: "/proj/src" });
});

Deno.test("applyCd: absolute path", () => {
  const next = applyCd(cmdOf("cd /tmp"), { kind: "known", path: "/proj" });
  assertEquals(next, { kind: "known", path: "/tmp" });
});

Deno.test("applyCd: no arg (=$HOME) -> unknown", () => {
  assertEquals(applyCd(cmdOf("cd"), { kind: "known", path: "/proj" }), { kind: "unknown" });
});

Deno.test("applyCd: dynamic arg -> unknown", () => {
  assertEquals(applyCd(cmdOf("cd $X"), { kind: "known", path: "/proj" }), { kind: "unknown" });
});

Deno.test("gitEffectiveCwd: -C subdir resolves under cwd", () => {
  const c = gitEffectiveCwd(cmdOf("git -C sub status"), { kind: "known", path: "/proj" });
  assertEquals(c, { kind: "known", path: "/proj/sub" });
});

Deno.test("gitEffectiveCwd: --work-tree wins over -C base", () => {
  const c = gitEffectiveCwd(
    cmdOf("git -C sub --work-tree=wt status"),
    { kind: "known", path: "/proj" },
  );
  assertEquals(c, { kind: "known", path: "/proj/sub/wt" });
});

Deno.test("gitEffectiveCwd: -c core.worktree changes base", () => {
  const c = gitEffectiveCwd(
    cmdOf("git -c core.worktree=/outside status"),
    { kind: "known", path: "/proj" },
  );
  assertEquals(c, { kind: "known", path: "/outside" });
});

Deno.test("gitEffectiveCwd: --git-dir out-of-project sets cwd outside", () => {
  assertEquals(
    gitEffectiveCwd(cmdOf("git --git-dir=/outside/.git status"), { kind: "known", path: "/proj" }),
    { kind: "known", path: "/outside/.git" },
  );
});

Deno.test("gitEffectiveCwd: dynamic path option -> unknown", () => {
  assertEquals(
    gitEffectiveCwd(cmdOf("git -C $D status"), { kind: "known", path: "/proj" }),
    { kind: "unknown" },
  );
});

Deno.test("gitEffectiveCwd: no path options -> unchanged", () => {
  assertEquals(
    gitEffectiveCwd(cmdOf("git status"), { kind: "known", path: "/proj" }),
    { kind: "known", path: "/proj" },
  );
});
