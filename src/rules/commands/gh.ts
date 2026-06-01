import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/**
 * 各 gh 指令的唯讀子指令——既不變更 GitHub 遠端狀態、也不寫本地檔。
 * （`gh repo clone` / `gh release download` 寫本地檔，故不在此列 → ask。）
 */
const READ_SUBS: Record<string, Set<string>> = {
  repo: new Set(["view", "list"]),
  issue: new Set(["view", "list", "status"]),
  pr: new Set(["view", "list", "status", "diff", "checks"]),
  release: new Set(["view", "list"]),
};

/**
 * `gh api` 是否為寫入請求：帶非 GET 的 `-X` / `--method`，或帶 `-f` / `-F` /
 * `--field` / `--raw-field` / `--input`（皆隱含送出 body → POST/寫入）。
 */
function ghApiMutates(after: string[]): boolean {
  for (let i = 0; i < after.length; i++) {
    const t = after[i];
    if (t === "-X" || t === "--method") {
      if ((after[i + 1] ?? "").toUpperCase() !== "GET") return true;
    } else if (t.startsWith("--method=")) {
      if (t.slice("--method=".length).toUpperCase() !== "GET") return true;
    } else if (t.startsWith("-X") && t.length > 2) {
      if (t.slice(2).toUpperCase() !== "GET") return true; // -XPOST 黏寫
    } else if (
      t === "-f" || (t.startsWith("-f") && t.length > 2) || // -f key=val / -fkey=val
      t === "-F" || (t.startsWith("-F") && t.length > 2) || // -F key=@file / -Fkey=@file
      t === "--field" || t === "--raw-field" || t === "--input" ||
      t.startsWith("--field=") || t.startsWith("--raw-field=") ||
      t.startsWith("--input=")
    ) {
      return true;
    }
  }
  return false;
}

export const ghRule: CommandRule = {
  names: ["gh"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const toks: string[] = [];
    for (const a of ctx.argv) {
      const t = staticValue(a);
      if (t === null) return ask("gh：含動態 token，無法靜態判定");
      toks.push(t);
    }

    // command = 第一個非旗標 token
    const cmdIdx = toks.findIndex((t) => !t.startsWith("-"));
    if (cmdIdx === -1) return ask("gh：未指定指令");
    const command = toks[cmdIdx];
    const after = toks.slice(cmdIdx + 1);

    // search：所有子指令皆為讀取
    if (command === "search") return allow();

    // api：僅 GET 請求
    if (command === "api") {
      return ghApiMutates(after) ? ask("gh api：非 GET（寫入）請求") : allow();
    }

    const readSubs = READ_SUBS[command];
    if (!readSubs) return ask(`gh ${command}：未列入唯讀 allowlist`);

    const sub = after.find((t) => !t.startsWith("-"));
    if (sub === undefined) return ask(`gh ${command}：未指定子指令`);
    return readSubs.has(sub) ? allow() : ask(`gh ${command} ${sub}：非唯讀操作`);
  },
};
