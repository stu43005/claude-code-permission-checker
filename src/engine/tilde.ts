import type { Word } from "../deps.ts";

/**
 * word 是否會被 bash 施以 tilde expansion。
 *
 * POSIX/bash 規則：tilde-prefix 是從 `~` 開始、到第一個**未加引號**的 `/` 為止（無則
 * 整個 word 都是 prefix）的區間。只要這個區間內出現任何引號字元，整個 tilde expansion
 * 就不會發生——不是只看開頭那個 `~` 有沒有被引號包住。
 *
 * **只看 word 結構，不看 `staticValue` 的結果字串**：引號會抑制 tilde expansion，
 * 而 staticValue 已把引號資訊抹除。實測五種 word（皆 staticValue="~/src" 或 "~"）：
 *   `~/src`      parts=[]                                     → 展開為 $HOME/src
 *   `"~"`        parts=[DoubleQuoted]                         → 不展開，相對 ./~
 *   `~/"src"`    parts=[Literal(~/), DoubleQuoted]             → prefix=`~/` 全無引號 → 展開
 *   `~""/src`    parts=[Literal(~), DoubleQuoted(""), Literal(/src)] → prefix=`~""` 含引號 → 不展開
 *   `~"/src"`    parts=[Literal(~), DoubleQuoted(/src)]        → 無未引號 `/`，整個 word 是
 *                                                                 prefix 且含引號 → 不展開
 * 故不能只看 `parts[0]`：必須走訪到 prefix 結束（第一個未引號 `/`）為止，途中任何非
 * Literal part 都代表 prefix 內含引號。
 */
export function hasUnquotedLeadingTilde(word: Word): boolean {
  const parts = word.parts;
  if (!parts || parts.length === 0) {
    return word.value.startsWith("~") && tildePrefixIsUnquoted(word.value);
  }
  const head = parts[0];
  if (head.type !== "Literal" || !head.value.startsWith("~")) return false;
  // tilde-prefix = `~` 到第一個**未加引號**的 `/` 之間。POSIX/bash：該區間內只要出現任何
  // 引號字元，整個 tilde expansion 就不發生（`~""/src`、`~"/src"` 都維持字面）。
  // 故須走訪 parts 直到 prefix 結束，中途遇到非 Literal（引號片段）即判定不展開。
  if (head.value.includes("/")) return true; // prefix 在第一個 part 內就結束，且無引號
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.type !== "Literal") return false; // 引號片段落在 prefix 內
    if (p.value.includes("/")) return true; // prefix 在此結束，且全程無引號
  }
  // 整個 word 都是未加引號的 tilde-prefix（如 `~us\er`）。bash 會嘗試把它當 ~username 展開，
  // 結果取決於該使用者是否存在——靜態不可知。回 true 讓 expandTilde 判定為不支援形態
  // （→ 呼叫端 fail-closed），而不是退回相對路徑語義那條會誤放行的路。
  return true;
}

/**
 * 未加引號的字面 token：tilde-prefix（`~` 到第一個**未跳脫**的 `/`）內是否不含反斜線跳脫。
 *
 * `\/` 是被跳脫的 `/`，不終止 prefix，於是整個 token 都落在 prefix 內且含引號字元——
 * bash 因此完全不展開（實測 `echo ~\/src` → `~/src`，而 `echo ~/src` → `$HOME/src`）。
 * 有 parts 的 word 不需在此處理：未加引號的 Literal 含反斜線時，word.ts 的
 * topPartIsDynamic 已使該 word 非靜態，呼叫端本就 fail closed。
 */
function tildePrefixIsUnquoted(value: string): boolean {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "\\") return false; // prefix 內出現跳脫字元 → 不展開
    if (value[i] === "/") return true; // prefix 在此結束，且全程未加引號
  }
  return true; // 整個 token 都是未跳脫的 prefix（如 `~username`）
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
