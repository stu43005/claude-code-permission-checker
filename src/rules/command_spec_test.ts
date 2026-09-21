import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { type CommandSpec, parseArgv } from "./command_spec.ts";
import type { RuleContext } from "./types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../engine/scope.ts";

function ctxOf(name: string, src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

const DEMO: CommandSpec = {
  flags: [
    { name: "-b", value: "none" },
    { name: "-w", value: "required" },
    { name: "--width", value: "required" },
    { name: "--color", value: "attached-only" },
    { name: "--from", value: "required", valueIsPath: true },
  ],
  positionals: "paths",
};

Deno.test("a required value is consumed in all three forms", () => {
  assertEquals(parseArgv(ctxOf("demo", "demo -w 80 a.txt"), DEMO).pathOperands.length, 1);
  assertEquals(parseArgv(ctxOf("demo", "demo -w80 a.txt"), DEMO).pathOperands.length, 1);
  assertEquals(parseArgv(ctxOf("demo", "demo --width=80 a.txt"), DEMO).pathOperands.length, 1);
  assertEquals(parseArgv(ctxOf("demo", "demo --width 80 a.txt"), DEMO).pathOperands.length, 1);
});

Deno.test("attached-only accepts =value and consumes nothing when bare", () => {
  const bare = parseArgv(ctxOf("demo", "demo --color pat a.txt"), DEMO);
  assertEquals(bare.unknownFlag, null);
  assertEquals(bare.pathOperands.map((w) => w.value), ["pat", "a.txt"]);
  const glued = parseArgv(ctxOf("demo", "demo --color=auto a.txt"), DEMO);
  assertEquals(glued.unknownFlag, null);
  assertEquals(glued.pathOperands.map((w) => w.value), ["a.txt"]);
});

Deno.test("an unknown flag is reported, never silently skipped", () => {
  assertEquals(parseArgv(ctxOf("demo", "demo --nope"), DEMO).unknownFlag, "--nope");
  assertEquals(parseArgv(ctxOf("demo", "demo -bZ"), DEMO).unknownFlag, "-Z");
  assertEquals(parseArgv(ctxOf("demo", "demo -b=1"), DEMO).unknownFlag, "-b");
});

Deno.test("numericShorthand is opt-in and must be the entire token", () => {
  const HEAD: CommandSpec = {
    flags: [{ name: "-n", value: "required" }],
    positionals: "paths",
    numericShorthand: true,
  };
  // 整個 token 是 `-` 加數字 → 接受
  assertEquals(parseArgv(ctxOf("head", "head -100"), HEAD).unknownFlag, null);
  // 形式不符 → 落入群集掃描，回報第一個未知字母旗標（不是整個 token）
  assertEquals(parseArgv(ctxOf("head", "head -100x"), HEAD).unknownFlag, "-1");
  // 未開啟 numericShorthand 的指令：數字同樣落入群集掃描
  assertEquals(parseArgv(ctxOf("demo", "demo -100"), DEMO).unknownFlag, "-1");
});

Deno.test("positionals: pattern-then-paths drops only the first", () => {
  const GREP: CommandSpec = { flags: [{ name: "-E", value: "none" }], positionals: "pattern-then-paths" };
  const r = parseArgv(ctxOf("grep", "grep -E pat a.txt b.txt"), GREP);
  assertEquals(r.pathOperands.map((w) => w.value), ["a.txt", "b.txt"]);
  assertEquals(r.nonPathOperands.map((w) => w.value), ["pat"]);
});

Deno.test("a path-valued flag records its value in both forms", () => {
  assertEquals(parseArgv(ctxOf("demo", "demo --from=list"), DEMO).pathValues, ["list"]);
  assertEquals(parseArgv(ctxOf("demo", "demo --from list"), DEMO).pathValues, ["list"]);
});

Deno.test("any dynamic token makes the whole parse dynamic", () => {
  assertEquals(parseArgv(ctxOf("demo", "demo -w $N"), DEMO).dynamic, true);
  assertEquals(parseArgv(ctxOf("demo", "demo $F"), DEMO).dynamic, true);
});

Deno.test("-- terminates option parsing", () => {
  const r = parseArgv(ctxOf("demo", "demo -- -w"), DEMO);
  assertEquals(r.unknownFlag, null);
  assertEquals(r.pathOperands.map((w) => w.value), ["-w"]);
});

Deno.test("a missing required value is reported, not silently accepted", () => {
  assertEquals(parseArgv(ctxOf("demo", "demo -w"), DEMO).unknownFlag, "-w");
});

Deno.test("seenFlags records every occurrence, in order", () => {
  const r = parseArgv(ctxOf("demo", "demo -b -w 80 --color=auto"), DEMO);
  assertEquals(r.seenFlags.get("-b"), [null]);
  assertEquals(r.seenFlags.get("-w"), ["80"]);
  assertEquals(r.seenFlags.get("--color"), ["auto"]);
  assertEquals(r.seenFlags.has("--width"), false);
  // 重複出現時全部保留，順序即命令列順序
  const rep2 = parseArgv(ctxOf("demo", "demo -w 1 -w 2"), DEMO);
  assertEquals(rep2.seenFlags.get("-w"), ["1", "2"]);
});

Deno.test("an unknown cluster letter does not hide the rest of the cluster", () => {
  const SPEC: CommandSpec = {
    flags: [{ name: "-r", value: "none" }],
    positionals: "paths",
  };
  const r = parseArgv(ctxOf("demo", "demo -Tr x"), SPEC);
  assertEquals(r.unknownFlag, "-T");       // 仍回報未知旗標
  assertEquals(r.seenFlags.has("-r"), true); // 但 -r 仍被記下，遞迴偵測不會漏
});

Deno.test("the LAST occurrence wins where the command says so", () => {
  const SPEC: CommandSpec = {
    flags: [{ name: "-d", value: "required" }],
    positionals: "paths",
    recursive: (_n, seen) => (seen.get("-d") ?? []).at(-1) === "recurse",
  };
  assertEquals(parseArgv(ctxOf("demo", "demo -d skip -d recurse x"), SPEC).isRecursive, true);
  assertEquals(parseArgv(ctxOf("demo", "demo -d recurse -d skip x"), SPEC).isRecursive, false);
});

Deno.test("positionals can be derived from seenFlags in the same parse", () => {
  const SPEC: CommandSpec = {
    flags: [{ name: "-e", value: "required" }, { name: "-i", value: "none" }],
    // 有 -e 時第一個位置參數不是 pattern
    positionals: (seen) => (seen.has("-e") ? "paths" : "pattern-then-paths"),
  };
  assertEquals(
    parseArgv(ctxOf("demo", "demo pat a.txt"), SPEC).pathOperands.map((w) => w.value),
    ["a.txt"],
  );
  assertEquals(
    parseArgv(ctxOf("demo", "demo -e pat a.txt"), SPEC).pathOperands.map((w) => w.value),
    ["a.txt"],
  );
  assertEquals(
    parseArgv(ctxOf("demo", "demo -e pat"), SPEC).pathOperands.length,
    0,
  );
});

Deno.test("recursive is derived from seenFlags, including value-bearing forms", () => {
  const SPEC: CommandSpec = {
    flags: [{ name: "-d", value: "required" }, { name: "--directories", value: "required" }],
    positionals: "paths",
    recursive: (_n, seen) =>
      (seen.get("-d") ?? []).at(-1) === "recurse" ||
      (seen.get("--directories") ?? []).at(-1) === "recurse",
  };
  assertEquals(parseArgv(ctxOf("demo", "demo -d recurse"), SPEC).isRecursive, true);
  assertEquals(parseArgv(ctxOf("demo", "demo --directories=recurse"), SPEC).isRecursive, true);
  assertEquals(parseArgv(ctxOf("demo", "demo -d skip"), SPEC).isRecursive, false);
  // 重複出現：以最後一次為準
  assertEquals(parseArgv(ctxOf("demo", "demo -d skip -d recurse"), SPEC).isRecursive, true);
});

Deno.test("parseArgv memoizes per RuleContext so both consumers share one result", () => {
  const ctx = ctxOf("demo", "demo -w 80 a.txt");
  assertEquals(parseArgv(ctx, DEMO) === parseArgv(ctx, DEMO), true);
});

Deno.test("a short attached-only flag takes its =value and stops the cluster", () => {
  const SPEC: CommandSpec = {
    flags: [{ name: "-b", value: "none" }, { name: "-c", value: "attached-only" }],
    positionals: "paths",
  };
  // 黏寫 =value：取值、不再掃描該 token 剩餘字元
  const glued = parseArgv(ctxOf("demo", "demo -c=auto a.txt"), SPEC);
  assertEquals(glued.unknownFlag, null);
  assertEquals(glued.seenFlags.get("-c"), ["auto"]);
  assertEquals(glued.pathOperands.map((w) => w.value), ["a.txt"]);
  // 群集中段亦同
  const cluster = parseArgv(ctxOf("demo", "demo -bc=auto a.txt"), SPEC);
  assertEquals(cluster.unknownFlag, null);
  assertEquals(cluster.seenFlags.get("-b"), [null]);
  assertEquals(cluster.seenFlags.get("-c"), ["auto"]);
  // 裸寫：不吃下一個 token，行為不變
  const bare = parseArgv(ctxOf("demo", "demo -c pat a.txt"), SPEC);
  assertEquals(bare.unknownFlag, null);
  assertEquals(bare.seenFlags.get("-c"), [null]);
  assertEquals(bare.pathOperands.map((w) => w.value), ["pat", "a.txt"]);
});
