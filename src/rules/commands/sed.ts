import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { exact, hasAnyFlag, positionals, prefix } from "../flags.ts";
import { staticValue } from "../../engine/word.ts";

const ASK_FLAGS = [exact("-i", "--in-place", "-f", "--file"), prefix("-i", "--in-place=", "--file=")];
const VALUE_FLAGS = [exact("-e", "--expression", "-f", "--file", "-l")];

/**
 * sed 程式（隱含第一個非 flag 引數 + 所有 -e）中，下列構造代表寫檔 / 執行：
 * 獨立的 w / W / e / r / R 指令，或 s///… 旗標含 w 或 e。
 * 採保守正則偵測；命中或無法靜態取得程式即 ask。
 */
function programHasSideEffect(program: string): boolean {
  // s/.../.../<flags> 內若含 w 或 e 旗標
  if (/s([^\sa-zA-Z0-9])(?:\\.|[^\\])*?\1(?:\\.|[^\\])*?\1[a-z0-9]*[we]/.test(program)) {
    return true;
  }
  // 獨立的 w/W/e/r/R 指令（行首、分號、或位址後出現），保守偵測
  if (/(^|[;\n{])\s*[0-9$/]*\s*[wWeRr]\b/.test(program)) return true;
  if (/(^|[;\n{])\s*[wWeRr]\s/.test(program)) return true;
  return false;
}

/** 收集 sed 的程式片段：第一個非 flag 位置參數，加上所有 -e 的值。 */
function collectProgram(ctx: RuleContext): { text: string | null; explicitExpr: boolean } {
  const parts: string[] = [];
  let explicitExpr = false;
  const argv = ctx.argv;
  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) continue;
    if (t === "-e" || t === "--expression") {
      explicitExpr = true;
      const v = argv[i + 1] ? staticValue(argv[i + 1]) : null;
      if (v === null) return { text: null, explicitExpr };
      parts.push(v);
      i++;
    } else if (t.startsWith("--expression=")) {
      explicitExpr = true;
      parts.push(t.slice("--expression=".length));
    } else if (t.startsWith("-e")) {
      explicitExpr = true;
      parts.push(t.slice(2));
    }
  }
  if (!explicitExpr) {
    // 隱含程式 = 第一個非 flag 位置參數
    const pos = positionals(argv, VALUE_FLAGS);
    if (pos.length === 0) return { text: null, explicitExpr };
    const v = staticValue(pos[0]);
    if (v === null) return { text: null, explicitExpr };
    parts.push(v);
  }
  return { text: parts.join("\n"), explicitExpr };
}

/** sed 的輸入檔：隱含程式時為第二個起的位置參數；有 -e 時為所有位置參數。 */
function inputPaths(ctx: RuleContext, explicitExpr: boolean) {
  const pos = positionals(ctx.argv, VALUE_FLAGS);
  return explicitExpr ? pos : pos.slice(1);
}

export const sedRule: CommandRule = {
  names: ["sed"],
  evaluate(ctx: RuleContext): RuleVerdict {
    if (hasAnyFlag(ctx.argv, ASK_FLAGS)) {
      return ask("sed：-i / -f 可就地寫檔或載入不可見腳本");
    }
    const { text, explicitExpr } = collectProgram(ctx);
    if (text === null) return ask("sed：無法靜態取得程式內容");
    if (programHasSideEffect(text)) return ask("sed：程式含寫檔 / 執行構造（w/W/e/r 或 s///we）");
    for (const p of inputPaths(ctx, explicitExpr)) {
      if (ctx.resolvePath(p) !== "in-project") {
        return ask(`sed：輸入路徑超出專案範圍或無法解析（${p.value}）`);
      }
    }
    return allow();
  },
};
