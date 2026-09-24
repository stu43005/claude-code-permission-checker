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

/** 回傳第一個未跳脫 glob 元字元（`*` `?` `[`）的索引；無則回 -1。 */
export function firstGlobMetacharIndex(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\") { i++; continue; } // 跳過被跳脫的字元
    if (c === "*" || c === "?" || c === "[") return i;
  }
  return -1;
}

/**
 * 「單一 `?` 查詢串」形態：三項全部成立才容忍。
 *  1. 未跳脫的 glob 元字元恰好一個，且該字元是 `?`（`*` / `[` 一律不容忍）；
 *  2. 該 `?` 不在索引 0 —— 字面前綴非空，故展開結果不可能以 `-` 開頭、不會變成旗標；
 *  3. 該 `?` 之後的子字串不含 `/` —— 等價於「`?` 位於最後一個 `/` 之後」，
 *     故所有前段路徑都落在字面前綴內。
 */
function isSingleQueryGlob(value: string): boolean {
  const first = firstGlobMetacharIndex(value);
  if (first <= 0) return false;
  if (value[first] !== "?") return false;
  const rest = value.slice(first + 1);
  if (firstGlobMetacharIndex(rest) !== -1) return false;
  return !rest.includes("/");
}

/**
 * `nonPathStaticValue` 的回傳型別。
 *
 * 與 `staticValue` 的唯一差異：未加引號、且符合「單一 `?` 查詢串」形態的 token
 * 不再視為動態，而是回傳一組結構化結果而非單純字串——因為呼叫端（gh）必須另外
 * 檢查那個被容忍的 `?` 位在哪裡（必須落在 endpoint 的第一個 `/` 之後）。
 */
export interface RelaxedOperand {
  /** bash quote removal 後的值 —— 這是要拿去做語義判定（子指令、佔位符…）的字串。 */
  value: string;
  /**
   * 被容忍的 `?` 在**原始未展開字串**中的索引；該 token 本就靜態（無活躍元字元）時為 -1。
   * 呼叫端要判斷「元字元位置」時**必須**用這個索引搭配 `raw`，
   * 不可對 `value` 重跑 `firstGlobMetacharIndex` —— quote removal 已抹除跳脫資訊，
   * 重掃會把 `a\?b`（活躍 `?`）誤判成無元字元，也會把 `a\?b`（字面 `?`）誤判成活躍。
   */
  globIndex: number;
  /** 原始字串（未做 quote removal），供呼叫端與 globIndex 搭配做位置判定。 */
  raw: string;
}

/**
 * 「本工具的判定完全不讀其內容」的操作元專用靜態取值。
 * 與 staticValue 的唯一差異：未加引號、且符合「單一 `?` 查詢串」形態的 token
 * 不再視為動態。`*` / `[` / 多重元字元 / `?` 後含 `/` 一律回 null。
 *
 * **目前唯一合法用途是 `gh api` 的 endpoint 操作元**——gh api 的判定只掃描旗標、
 * 完全不讀 endpoint 路徑，故展開結果不影響判定。路徑、旗標、旗標值，以及 curl 的
 * 任何 token（其判定會比對 preapproved 的 path 前綴）一律不得使用本函式。
 */
export function nonPathStaticValue(word: Word): RelaxedOperand | null {
  const strict = staticValue(word);
  if (strict !== null) return { value: strict, globIndex: -1, raw: word.value };
  // 有 parts（含任何引號片段）→ 一律拒絕。word.value 是 quote-removed 的串接，
  // 引號內的反斜線與 shell 跳脫已無法區分，逐字掃描會誤判哪些元字元是活的。
  if (word.parts) return null;
  // 無 parts = 整個 word 皆為未加引號字面值：firstGlobMetacharIndex 本身處理跳脫，
  // 故在原字串上判形態並記下位置，再回傳 bash quote removal 後的值。
  const raw = word.value;
  if (!isSingleQueryGlob(raw)) return null;
  return { value: removeBackslashEscapes(raw), globIndex: firstGlobMetacharIndex(raw), raw };
}

/**
 * Windows 磁碟前綴但缺分隔符（`C:Windows`）。這個形態的語義有歧義——不同程式解析結果不同
 * （實測 `cd`/`realpath` 解析到 C 磁碟，`cat`/`ls` 當成含冒號的相對檔名）——且沒有任何正當
 * 寫法會用它：要指 C 磁碟就寫 `/c/Windows` 或 `C:/Windows`。歧義且無正當用途，依 default-deny
 * 一律拒絕，不去臆測它會落在哪裡。
 *
 * 定義於 word.ts（而非 scope.ts）以便 glob.ts 使用而不形成 glob.ts ↔ scope.ts 循環 import；
 * scope.ts 以 re-export 維持既有匯入點。
 */
export function isDriveRelative(p: string): boolean {
  return /^[A-Za-z]:(?![/\\])/.test(p);
}
