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

/** 雙引號內的 part：glob 字元被引號保護不展開，僅展開類 part 才算動態。 */
export function nestedPartIsDynamic(part: WordPart): boolean {
  return DYNAMIC_PART_TYPES.has(part.type);
}

/** 頂層 part：展開類 → 動態；未加引號的 Literal 含 glob 字元 → 動態。 */
export function topPartIsDynamic(part: WordPart): boolean {
  if (DYNAMIC_PART_TYPES.has(part.type)) return true;
  if (part.type === "Literal") return GLOB_CHARS.test(part.value); // 未加引號字面值
  // 雙引號 / locale 字串：內部 glob 不展開，只看展開類 part
  if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
    return part.parts.some(nestedPartIsDynamic);
  }
  return false; // SingleQuoted / AnsiCQuoted → 引號保護的字面值
}

/** Word 是否為純靜態字面值（不含展開、且無未加引號的 glob）。 */
export function isStatic(word: Word): boolean {
  if (!word.parts) {
    // 無 parts = 未加引號的字面值；含 glob 元字元即視為動態
    return !GLOB_CHARS.test(word.value);
  }
  return !word.parts.some(topPartIsDynamic);
}

/** 靜態時回傳字面值，動態回傳 null。 */
export function staticValue(word: Word): string | null {
  return isStatic(word) ? word.value : null;
}
