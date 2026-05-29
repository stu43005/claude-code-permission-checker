import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/** git 全域選項中會吃掉下一 token 當值者。 */
const GLOBAL_VALUE_OPTS = new Set<string>([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix",
]);

/** 純讀取子指令（其餘子指令一律 ask）。 */
const READ_SUBCOMMANDS = new Set<string>([
  "status", "log", "diff", "show", "blame", "rev-parse", "describe",
  "cat-file", "ls-files", "ls-tree", "for-each-ref", "reflog", "shortlog", "grep",
]);

/** 取得子指令與其後的引數（跳過全域選項及其值）。 */
function parseSub(argv: RuleContext["argv"]): { sub: string | null; rest: string[]; dynamic: boolean } {
  let i = 0;
  while (i < argv.length) {
    const t = staticValue(argv[i]);
    if (t === null) return { sub: null, rest: [], dynamic: true };
    if (!t.startsWith("-")) break;
    // 吃值的全域選項：`--opt=val` 為單 token；`--opt val` / `-C val` 吃下一個
    if (GLOBAL_VALUE_OPTS.has(t)) i += 2;
    else i += 1;
  }
  if (i >= argv.length) return { sub: null, rest: [], dynamic: false };
  const subTok = staticValue(argv[i]);
  if (subTok === null) return { sub: null, rest: [], dynamic: true };
  const rest: string[] = [];
  for (let j = i + 1; j < argv.length; j++) {
    const r = staticValue(argv[j]);
    rest.push(r ?? " "); // 動態值以哨符代表
  }
  return { sub: subTok, rest, dynamic: false };
}

function has(rest: string[], ...flags: string[]): boolean {
  return rest.some((r) => flags.includes(r));
}

export const gitRule: CommandRule = {
  names: ["git"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const { sub, rest, dynamic } = parseSub(ctx.argv);
    if (dynamic) return ask("git：子指令含動態值，無法靜態判定");
    if (sub === null) return ask("git：未指定子指令");

    if (READ_SUBCOMMANDS.has(sub)) return allow();

    switch (sub) {
      case "branch":
        return has(rest, "-d", "-D", "-m", "-M", "--delete", "--move")
          ? ask("git branch：含刪除 / 改名旗標")
          : allow();
      case "tag":
        // 純列出（無引數或 -l/--list/-n）→ allow；建立 / 刪除 → ask
        return rest.length === 0 || has(rest, "-l", "--list") ||
            rest.every((r) => r.startsWith("-n"))
          ? allow()
          : ask("git tag：非列出操作");
      case "config":
        return has(rest, "--get", "--get-all", "--get-regexp", "--list", "-l")
          ? allow()
          : ask("git config：非讀取操作（set / unset）");
      case "stash":
        return rest[0] === "list" ? allow() : ask("git stash：非 list 操作");
      case "remote":
        return rest.length === 0 || has(rest, "-v", "--verbose") || rest[0] === "show"
          ? allow()
          : ask("git remote：非列出操作");
      default:
        return ask(`git ${sub}：非唯讀子指令或未列入 allowlist`);
    }
  },
};
