import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { exact, hasAnyFlag, positionals, prefix } from "../flags.ts";
import { staticValue } from "../../engine/word.ts";

const ASK_FLAGS = [exact("-i", "--in-place", "-f", "--file"), prefix("--in-place=", "--file=")];
const VALUE_FLAGS = [exact("-F", "-v", "-f", "--file", "--field-separator", "--assign")];

/** awk 程式中代表副作用的構造：輸出重導向、pipe、system(、getline、close(、fflush(。 */
function programHasSideEffect(program: string): boolean {
  // 輸出重導向：僅在 print / printf 之後出現 > 或 >> 才算寫檔，避開比較運算子
  // （bare pattern 過濾如 $3>100、NR>=8940 必須維持 allow）。
  if (/\b(?:print|printf)\b[^;{}\n]*>/.test(program)) return true;
  // pipe：偵測單一 |（print | "cmd" / "cmd" | getline），排除邏輯 ||。
  if (/(?:^|[^|])\|(?:[^|]|$)/.test(program)) return true;
  if (/\bsystem\s*\(/.test(program)) return true;
  if (/\bgetline\b/.test(program)) return true;
  if (/\bclose\s*\(/.test(program)) return true;
  if (/\bfflush\s*\(/.test(program)) return true;
  return false;
}

/** 隱含程式 = 第一個非 flag 位置參數（awk 無 -e 的普遍標準形式以此為主）。 */
function collectProgram(ctx: RuleContext): { text: string | null; pos: ReturnType<typeof positionals> } {
  // 支援 gawk 的 -e 'prog'
  const eParts: string[] = [];
  let hasE = false;
  const argv = ctx.argv;
  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) continue;
    if (t === "-e") {
      hasE = true;
      const v = argv[i + 1] ? staticValue(argv[i + 1]) : null;
      if (v === null) return { text: null, pos: [] };
      eParts.push(v);
      i++;
    } else if (t.startsWith("-e") && t.length > 2 && !t.startsWith("--")) {
      hasE = true;
      eParts.push(t.slice(2));
    }
  }
  const pos = positionals(argv, [...VALUE_FLAGS, exact("-e")]);
  if (hasE) return { text: eParts.join("\n"), pos };
  if (pos.length === 0) return { text: null, pos };
  const v = staticValue(pos[0]);
  if (v === null) return { text: null, pos };
  return { text: v, pos: pos.slice(1) };
}

export const awkRule: CommandRule = {
  names: ["awk", "gawk", "mawk"],
  evaluate(ctx: RuleContext): RuleVerdict {
    if (hasAnyFlag(ctx.argv, ASK_FLAGS)) {
      return ask("awk：-i / -f 可就地寫檔或載入不可見程式");
    }
    const { text, pos } = collectProgram(ctx);
    if (text === null) return ask("awk：無法靜態取得程式內容");
    if (programHasSideEffect(text)) {
      return ask("awk：程式含寫檔 / 執行構造（> / | / system / getline / close / fflush）");
    }
    for (const p of pos) {
      if (ctx.resolvePath(p) !== "in-project") {
        return ask(`awk：輸入路徑超出專案範圍或無法解析（${p.value}）`);
      }
    }
    return allow();
  },
};
