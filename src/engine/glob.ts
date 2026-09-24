import type { Word } from "../deps.ts";
import { isDriveRelative } from "./word.ts";

/**
 * glob 路徑操作元的純詞法形態判定（不碰檔案系統）。
 *
 * 依 GNU bash 5.3.9 實測行為設計：
 *  - `shopt -u globskipdots` 時，以字面 `.` 開頭的 glob 段（`.*`、`.[.]`）可展開成 `..`；
 *  - glob 段之後的字面 `..`（`sub*\/../x`）原樣保留，會逃出字面前綴；
 *  - 沒有字面前綴的 glob（`*.md`）展開結果取自 cwd 檔名，可能以 `-` 開頭而被當成旗標；
 *    多段者（`*\/x`）的注入值還會帶 `/`。
 * 只接受在上述行為下仍能保證「展開結果落在字面前綴目錄之下」的形態。
 */

const GLOB_CHAR = /[*?[]/;

export interface GlobPath {
  /** 第一個 glob 段之前的字面前綴（原樣以 `/` 連接）；`""` 代表 cwd，`"/"` 代表根。 */
  prefix: string;
}

/** 未加引號、且第一個字元即 glob 元字元：展開結果可能以 `-` 開頭而被當成旗標。 */
export function mayExpandToOption(word: Word): boolean {
  return word.parts === undefined && GLOB_CHAR.test(word.value.charAt(0));
}

/** 是否含恰為 `**` 的段（globstar 開啟時 shell 展開本身即遞迴遍歷前綴目錄）。 */
export function hasGlobstarSegment(word: Word): boolean {
  return word.value.split("/").includes("**");
}

/** 可被當成 glob 路徑操作元接受時回傳其字面前綴；其餘一律 null（呼叫端維持 dynamic → ask）。 */
export function parseGlobPath(word: Word): GlobPath | null {
  if (word.parts !== undefined) return null; // 含任何引號 / 展開片段
  const v = word.value;
  if (v.includes("\\") || !GLOB_CHAR.test(v)) return null;
  if (v.startsWith("-") || v.startsWith("~") || isDriveRelative(v)) return null;
  // 可能展開成旗標者必須單段：被注入的 token 才不可能帶 `/`（旗標值只能指向 cwd 內檔名）
  if (mayExpandToOption(word) && v.includes("/")) return null;
  const segs = v.split("/");
  const g = segs.findIndex((s) => GLOB_CHAR.test(s));
  for (const s of segs.slice(g)) {
    if (s === "..") return null;
    if (GLOB_CHAR.test(s) && (s.startsWith(".") || s.startsWith("["))) return null;
  }
  const head = segs.slice(0, g);
  if (head.length === 0) return { prefix: "" };
  const joined = head.join("/");
  if (joined === "") return { prefix: "/" }; // `/*.md`
  // `C:/*.md` 切段後前綴只剩 `C:`；補回分隔符，否則會被當成相對路徑而解析到 cwd 之內
  if (/^[A-Za-z]:$/.test(joined)) return { prefix: joined + "/" };
  return { prefix: joined };
}

/**
 * `--flag=<glob>` 黏寫值形態：值含 glob 字元、整個 value 不含反斜線且不含 `/`。
 * bash 把整個 word 當路徑 pattern 展開；單段只會匹配 cwd 內名為 `--flag=...` 的項目，
 * 結果仍以 `--flag=` 開頭（同一旗標、不同值）。多段者可經 `..` / `**` 遍歷 cwd 之外，一律拒絕。
 */
export function isGlobAttachedValue(word: Word, flagName: string): boolean {
  if (word.parts !== undefined) return false;
  const v = word.value;
  const head = flagName + "=";
  if (!v.startsWith(head)) return false;
  if (v.includes("\\") || v.includes("/")) return false;
  return GLOB_CHAR.test(v.slice(head.length));
}
