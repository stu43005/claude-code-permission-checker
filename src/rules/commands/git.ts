import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/** git 全域選項中會吃掉下一 token 當值者（不含 -c，單獨處理）。 */
const GLOBAL_VALUE_OPTS = new Set<string>([
  "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
]);

/** 純讀取子指令（其餘子指令一律 ask）。 */
const READ_SUBCOMMANDS = new Set<string>([
  "status", "log", "diff", "show", "blame", "rev-parse", "describe",
  "cat-file", "ls-files", "ls-tree", "for-each-ref", "reflog", "shortlog", "grep",
]);

/**
 * 判斷 -c 傳入的 config key 是否安全（不會執行外部程式）。
 * 只放行純外觀 / 路徑類的已知安全 key；其餘一律視為不安全。
 */
function isSafeConfigKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.startsWith("color.") ||
    k.startsWith("i18n.") ||
    k.startsWith("advice.") ||
    k === "core.quotepath" ||
    k === "core.abbrev" ||
    k === "log.date" ||
    k === "core.worktree" // 路徑，另由 cwd.ts 範圍檢查
  );
}

/** 取得子指令與其後的引數（跳過全域選項及其值）。 */
function parseSub(
  argv: RuleContext["argv"],
): { sub: string | null; rest: string[]; dynamic: boolean; dangerous: string | null } {
  let i = 0;
  let dangerous: string | null = null;
  while (i < argv.length) {
    const t = staticValue(argv[i]);
    if (t === null) return { sub: null, rest: [], dynamic: true, dangerous };
    if (!t.startsWith("-")) break;

    // 全域 -c key=val（空格形式）
    if (t === "-c") {
      const valTok = argv[i + 1] ? staticValue(argv[i + 1]) : null;
      if (valTok === null || !isSafeConfigKey(valTok.split("=")[0])) {
        dangerous = "git：-c 指定了非安全 config（可能執行外部程式）";
      }
      i += 2;
      continue;
    }
    // 全域 -ckey=val（黏寫形式）
    if (t.startsWith("-c") && t.length > 2) {
      const inline = t.slice(2);
      if (!isSafeConfigKey(inline.split("=")[0])) {
        dangerous = "git：-c 指定了非安全 config（可能執行外部程式）";
      }
      i += 1;
      continue;
    }
    // 全域 --exec-path[=<dir>]：會把 <dir> 前置到 git 子程序的 PATH，
    // 進而劫持預設 pager（less）等外部程式 → 可執行任意碼。
    if (t === "--exec-path" || t.startsWith("--exec-path=")) {
      dangerous = "git：--exec-path 會改寫 PATH 並可劫持 pager（執行外部程式）";
      // `--exec-path` 無值（查詢用）或 `--exec-path=<dir>` 皆為單 token。
      i += 1;
      continue;
    }

    // 吃值的全域選項：`--opt=val` 為單 token；`--opt val` / `-C val` 吃下一個
    if (GLOBAL_VALUE_OPTS.has(t)) i += 2;
    else i += 1;
  }
  if (i >= argv.length) return { sub: null, rest: [], dynamic: false, dangerous };
  const subTok = staticValue(argv[i]);
  if (subTok === null) return { sub: null, rest: [], dynamic: true, dangerous };
  const rest: string[] = [];
  for (let j = i + 1; j < argv.length; j++) {
    const r = staticValue(argv[j]);
    rest.push(r ?? " "); // 動態值以哨符代表
  }
  return { sub: subTok, rest, dynamic: false, dangerous };
}

function has(rest: string[], ...flags: string[]): boolean {
  return rest.some((r) => flags.includes(r));
}

export const gitRule: CommandRule = {
  names: ["git"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const { sub, rest, dynamic, dangerous } = parseSub(ctx.argv);
    if (dynamic) return ask("git：子指令含動態值，無法靜態判定");
    if (sub === null) return ask("git：未指定子指令");

    // 全域 -c 含不安全 config key
    if (dangerous) return ask(dangerous);

    // --ext-diff 啟用外部 diff driver（在子指令之後的 rest 中）
    if (rest.includes("--ext-diff")) {
      return ask("git：--ext-diff 啟用外部 diff driver（執行外部程式）");
    }

    // 讀取子指令的危險 flag：--output= 寫檔；git grep -O 執行任意 pager
    if (rest.some((r) => r === "--output" || r.startsWith("--output="))) {
      return ask(`git ${sub}：--output 會寫檔`);
    }
    if (
      sub === "grep" &&
      rest.some((r) =>
        r.startsWith("-O") ||
        r === "--open-files-in-pager" ||
        r.startsWith("--open-files-in-pager=")
      )
    ) {
      return ask("git grep：-O / --open-files-in-pager 會執行任意 pager 程式");
    }

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
