import type { Word } from "../deps.ts";

/**
 * word 是否會被 bash 施以 tilde expansion——即開頭的 `~` 未被引號保護。
 *
 * **只看 word 結構，不看 `staticValue` 的結果字串**：引號會抑制 tilde expansion，
 * 而 staticValue 已把引號資訊抹除。實測三種 word：
 *   `~/src`    parts=[]                              staticValue="~/src"  → 展開為 $HOME/src
 *   `"~"`      parts=["DoubleQuoted"]                 staticValue="~"      → 不展開，相對 ./~
 *   `~/"src"`  parts=["Literal(~/)","DoubleQuoted"]   staticValue="~/src"  → 開頭 ~ 仍展開
 * 第三列是混合形態，第一個 part 未加引號，故第二個分支不可省略。
 */
export function hasUnquotedLeadingTilde(word: Word): boolean {
  const parts = word.parts;
  if (!parts || parts.length === 0) return word.value.startsWith("~");
  const head = parts[0];
  return head.type === "Literal" && head.value.startsWith("~");
}

/**
 * 展開「支援的 tilde 形態」：恰為 `~`，或 `~/<rest>`。
 *
 * 其餘形態一律回 null（不可解析），因為本工具無從得知它們展開成什麼：
 *   `~<username>`  其他使用者的 home
 *   `~+` / `~-`    $PWD / $OLDPWD
 *   `~+N` / `~-N` / `~N`  directory stack 項目
 * 絕不可寫成「以 `~` 開頭就當成 home」——那會把 `~otheruser/x` 錯誤映射到當前使用者的 home。
 *
 * `shellHome` 必須是 bash 的 `$HOME`，不是 settings 的 `resolveHome`（後者在 Windows
 * 優先 USERPROFILE）。未知時回 null，呼叫端據此 fail-closed。
 */
export function expandTilde(value: string, shellHome: string | null): string | null {
  if (value !== "~" && !value.startsWith("~/")) return null;
  if (shellHome === null || shellHome.trim() === "") return null;
  return value === "~" ? shellHome : shellHome + value.slice(1);
}
