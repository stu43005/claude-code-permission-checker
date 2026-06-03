import { normalizeAbsolute, toPosix } from "../engine/scope.ts";

/** 由 Read()/Edit()/Write() 規則化約而來的外部唯讀範圍（路徑皆為已正規化的絕對 POSIX 形式）。 */
export interface ReadScope {
  /** 目錄 root（來自結尾 `/**` 的遞迴模式）；以 isWithin 比對「在其下」。 */
  roots: string[];
  /** 精確單一路徑（來自無 glob 的字面模式）；以正規化後字串相等比對。 */
  files: string[];
}

/** 空 ReadScope 常數。 */
export const EMPTY_READ_SCOPE: ReadScope = { roots: [], files: [] };

export type PathScopeEntry =
  | { kind: "root"; path: string } // 目錄 root，已正規化絕對 POSIX
  | { kind: "file"; path: string }; // 精確單檔，已正規化絕對 POSIX

/** glob 字元集合（自有常數，不複用 word.ts 的 GLOB_CHARS；多納入 `]` 只會更保守）。 */
const GLOB_CHARS = /[*?[\]]/;

/**
 * 解析 "Read(...)" / "Edit(...)" / "Write(...)" 規則為外部唯讀 scope entry。
 * 只認 `//`（絕對）與 `~/`（家目錄）前綴；其餘前綴、含 glob 的複雜形式、否定模式 → null（忽略）。
 * home 為 null（無法解析家目錄）時，`~/` 規則一律回 null。
 */
export function parsePathRule(rule: string, home: string | null): PathScopeEntry | null {
  const m = /^(?:Read|Edit|Write)\((.+)\)$/.exec(rule);
  if (m === null) return null;
  const inner = m[1];
  if (inner.startsWith("!")) return null; // 否定模式不支援

  let p: string;
  if (inner.startsWith("//")) {
    p = inner.slice(1); // 去一個前導斜線：//c/foo/** -> /c/foo/**
  } else if (inner.startsWith("~/")) {
    if (home === null) return null;
    p = toPosix(home).replace(/\/$/, "") + "/" + inner.slice(2);
  } else {
    return null; // /path（專案相對）、path、./path（cwd 相對）皆非目標前綴
  }

  if (p.endsWith("/**")) {
    let base = p.slice(0, -3);
    if (base === "") base = "/"; // //** -> 整個檔案系統
    if (GLOB_CHARS.test(base)) return null; // base 仍含 glob（如 /c/foo*/**）
    return { kind: "root", path: normalizeAbsolute(base) };
  }
  if (!GLOB_CHARS.test(p)) {
    return { kind: "file", path: normalizeAbsolute(p) };
  }
  return null; // 含 glob 但非乾淨結尾 /**
}
