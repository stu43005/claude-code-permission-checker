import type { Word, WordPart } from "../deps.ts";

/** 會讓 Word 失去靜態確定性的 WordPart type。 */
const DYNAMIC_PART_TYPES = new Set<string>([
  "SimpleExpansion",
  "ParameterExpansion",
  "CommandExpansion",
  "ArithmeticExpansion",
  "ProcessSubstitution",
  "BraceExpansion",
  "ExtendedGlob",
]);

/**
 * 未加引號的 glob 元字元。unbash 不結構化表示 glob（`*.txt` 與字面值 `a.txt` 的
 * Word 結構相同、皆無 parts），故須詞法偵測：未加引號的 `*` / `?` / `[` 會被 shell
 * 展開、無法靜態確定指向哪些路徑 → 視為動態。
 */
const GLOB_CHARS = /[*?[]/;

/** 移除未引號的反斜線跳脫（bash quote removal）：`\x` → `x`。供無 parts（未引號）token 還原成 bash 實際解讀值。 */
function removeBackslashEscapes(s: string): string {
  return s.replace(/\\([\s\S])/g, "$1");
}

/** 是否含「未被反斜線跳脫」的 glob 元字元（`* ? [`）。`\*` 視為字面、`*` 視為 glob。 */
function hasUnescapedGlob(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; } // 跳過被跳脫的字元
    if (c === "*" || c === "?" || c === "[") return true;
  }
  return false;
}

/** 雙引號內的 part：glob 字元被引號保護不展開，僅展開類 part 才算動態。 */
export function nestedPartIsDynamic(part: WordPart): boolean {
  return DYNAMIC_PART_TYPES.has(part.type);
}

/** 頂層 part：展開類 → 動態；未加引號的 Literal 含 glob 字元 → 動態。 */
export function topPartIsDynamic(part: WordPart): boolean {
  if (DYNAMIC_PART_TYPES.has(part.type)) return true;
  // 未加引號字面值：含 glob 元字元，或含反斜線跳脫（bash 會移除、值與 unbash 不一致）→ 不可靜態確定
  if (part.type === "Literal") return GLOB_CHARS.test(part.value) || part.value.includes("\\");
  // 雙引號 / locale 字串：內部 glob 不展開，只看展開類 part
  if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
    return part.parts.some(nestedPartIsDynamic);
  }
  return false; // SingleQuoted / AnsiCQuoted → 引號保護的字面值
}

/** Word 是否為純靜態字面值（不含展開、且無未加引號的 glob）。 */
export function isStatic(word: Word): boolean {
  if (!word.parts) {
    // 無 parts = 未加引號的字面值；含「未被反斜線跳脫」的 glob 元字元才算動態
    // （`\*` 是字面、`*` 是 glob）。反斜線本身不使其非靜態——由 staticValue 做 bash quote removal。
    return !hasUnescapedGlob(word.value);
  }
  return !word.parts.some(topPartIsDynamic);
}

/** 靜態時回傳字面值，動態回傳 null。 */
export function staticValue(word: Word): string | null {
  if (!isStatic(word)) return null;
  // 無 parts（未引號）→ 套用 bash quote removal（移除未引號反斜線），使名稱/旗標比對對齊 bash 實際解讀；
  // 有 parts → 沿用 unbash 的 value（引號內反斜線已正確保留）。
  return word.parts ? word.value : removeBackslashEscapes(word.value);
}
