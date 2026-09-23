import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { applyCd, gitEffectiveCwd, isCd } from "./cwd.ts";
import { walk } from "./walk.ts";
import { parseCommand } from "./parse.ts";

function cmdOf(src: string): Command {
  return parse(src).commands[0].command as Command;
}

Deno.test("isCd recognises cd", () => {
  assertEquals(isCd(cmdOf("cd src")), true);
  assertEquals(isCd(cmdOf("cat src")), false);
});

Deno.test("applyCd: static relative path updates known cwd", () => {
  const next = applyCd(cmdOf("cd src"), { kind: "known", path: "/proj" });
  assertEquals(next, { kind: "known", path: "/proj/src", origin: "chain-cd" });
});

Deno.test("applyCd: absolute path", () => {
  const next = applyCd(cmdOf("cd /tmp"), { kind: "known", path: "/proj" });
  assertEquals(next, { kind: "known", path: "/tmp", origin: "chain-cd" });
});

Deno.test("applyCd: no arg (=$HOME) -> unknown", () => {
  assertEquals(applyCd(cmdOf("cd"), { kind: "known", path: "/proj" }), { kind: "unknown" });
});

Deno.test("applyCd: dynamic arg -> unknown", () => {
  assertEquals(applyCd(cmdOf("cd $X"), { kind: "known", path: "/proj" }), { kind: "unknown" });
});

Deno.test("gitEffectiveCwd: -C subdir resolves under cwd", () => {
  const c = gitEffectiveCwd(cmdOf("git -C sub status"), { kind: "known", path: "/proj" });
  assertEquals(c, { kind: "known", path: "/proj/sub", origin: "chain-cd" });
});

Deno.test("gitEffectiveCwd: --work-tree wins over -C base", () => {
  const c = gitEffectiveCwd(
    cmdOf("git -C sub --work-tree=wt status"),
    { kind: "known", path: "/proj" },
  );
  assertEquals(c, { kind: "known", path: "/proj/sub/wt", origin: "chain-cd" });
});

Deno.test("gitEffectiveCwd: -c core.worktree changes base", () => {
  const c = gitEffectiveCwd(
    cmdOf("git -c core.worktree=/outside status"),
    { kind: "known", path: "/proj" },
  );
  assertEquals(c, { kind: "known", path: "/outside", origin: "chain-cd" });
});

Deno.test("gitEffectiveCwd: --git-dir out-of-project sets cwd outside", () => {
  assertEquals(
    gitEffectiveCwd(cmdOf("git --git-dir=/outside/.git status"), { kind: "known", path: "/proj" }),
    { kind: "known", path: "/outside/.git", origin: "chain-cd" },
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

Deno.test("applyCd: cd - 靜態不可知 → unknown", () => {
  assertEquals(applyCd(cmdOf("cd -"), { kind: "known", path: "/proj" }).kind, "unknown");
});

Deno.test("applyCd: cd ~ / cd ~/x 以 shell home 展開", () => {
  assertEquals(
    applyCd(cmdOf("cd ~"), { kind: "known", path: "/proj" }, "/home/u"),
    { kind: "known", path: "/home/u", origin: "chain-cd" },
  );
  assertEquals(
    applyCd(cmdOf("cd ~/src"), { kind: "known", path: "/proj" }, "/home/u"),
    { kind: "known", path: "/home/u/src", origin: "chain-cd" },
  );
});

Deno.test("applyCd: home 在專案內時展開結果仍在專案內", () => {
  assertEquals(
    applyCd(cmdOf("cd ~/src"), { kind: "known", path: "/proj" }, "/proj/home"),
    { kind: "known", path: "/proj/home/src", origin: "chain-cd" },
  );
});

Deno.test("applyCd: shell home 未知 → unknown", () => {
  assertEquals(applyCd(cmdOf("cd ~"), { kind: "known", path: "/proj" }).kind, "unknown");
  assertEquals(applyCd(cmdOf("cd ~/src"), { kind: "known", path: "/proj" }, null).kind, "unknown");
  assertEquals(applyCd(cmdOf("cd ~/src"), { kind: "known", path: "/proj" }, "   ").kind, "unknown");
});

Deno.test("applyCd: 不支援的 tilde 形態即使 home 已知也 unknown", () => {
  assertEquals(applyCd(cmdOf("cd ~user/x"), { kind: "known", path: "/proj" }, "/home/u").kind, "unknown");
  assertEquals(applyCd(cmdOf("cd ~+"), { kind: "known", path: "/proj" }, "/home/u").kind, "unknown");
  assertEquals(applyCd(cmdOf("cd ~-"), { kind: "known", path: "/proj" }, "/home/u").kind, "unknown");
});

Deno.test('applyCd: cd "~" 引號抑制展開，維持相對語義', () => {
  const r = applyCd(cmdOf('cd "~"'), { kind: "known", path: "/proj" }, "/home/u");
  assertEquals(r, { kind: "known", path: "/proj/~", origin: "chain-cd" });
});

Deno.test("applyCd: 混合引號 tilde 形態 → unknown", () => {
  // `cd ~/"src"` 的開頭 ~ 仍會展開，但後段是引號內容；不臆測混合展開結果
  assertEquals(applyCd(cmdOf('cd ~/"src"'), { kind: "known", path: "/proj" }, "/home/u").kind, "unknown");
});

Deno.test("applyCd: 可求值的 substitution 推導出具體 cwd", () => {
  const r = applyCd(cmdOf('cd "$(dirname /proj/src/a.ts)"'), { kind: "known", path: "/proj" });
  assertEquals(r, { kind: "known", path: "/proj/src", origin: "chain-cd" });
});

Deno.test("applyCd: 不可求值的 substitution 仍為 unknown", () => {
  assertEquals(applyCd(cmdOf('cd "$(uname -a)"'), { kind: "known", path: "/proj" }).kind, "unknown");
  assertEquals(applyCd(cmdOf("cd $(dirname /a/b)"), { kind: "known", path: "/proj" }).kind, "unknown");
});

Deno.test("applyCd: 求值結果為 - 時也要擋下", () => {
  // basename ./- → "-"；bash 會把它當成 cd -（回上一個工作目錄），不是相對路徑 "./-"
  assertEquals(applyCd(cmdOf(`cd "$(basename ./-)"`), { kind: "known", path: "/proj" }).kind, "unknown");
  assertEquals(applyCd(cmdOf(`cd "$(printf '%s' -)"`), { kind: "known", path: "/proj" }).kind, "unknown");
  // 求值出的字面 ~ 由 bash 視為普通字元（tilde expansion 早於 substitution），故維持相對語義
  const r = applyCd(cmdOf(`cd "$(echo '~')"`), { kind: "known", path: "/proj" });
  assertEquals(r, { kind: "known", path: "/proj/~", origin: "chain-cd" });
});

Deno.test({
  ignore: Deno.build.os !== "windows",
  name: "applyCd: cygpath 推導出專案內 cwd（本次的主要需求）",
  fn() {
    const r = applyCd(cmdOf(`cd "$(cygpath -u 'D:/proj/src')"`), { kind: "known", path: "D:/proj" });
    assertEquals(r, { kind: "known", path: "D:/proj/src", origin: "chain-cd" });
  },
});

Deno.test("walk: shell home 傳達到巢狀結構中的 cd ~", () => {
  const { script } = parseCommand("{ cd ~/src && cat a.ts; }");
  const invs = walk(script, { kind: "known", path: "/proj" }, "/proj", "/home/u");
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(cat.cwd, { kind: "known", path: "/home/u/src", origin: "chain-cd" });
});
