import type { Word } from "../deps.ts";
import { staticValue } from "./word.ts";
import type { CwdState } from "../types.ts";
import type { ReadScope } from "../permissions/path_scope.ts";

export type PathScope = "in-project" | "out-of-project" | "dynamic";

/**
 * 是否為 Windows 目標。MSYS / Git-Bash 的 `/d/` 磁碟路徑慣例只存在於 Windows；
 * 在 Linux / macOS，`/d/...` 是貨真價實的 POSIX 路徑（且檔名區分大小寫），
 * 不可改寫。編譯後的 binary 此值固定為編譯目標 OS。
 */
const IS_WINDOWS = Deno.build.os === "windows";

/** 反斜線轉斜線。 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 是否為絕對路徑（posix `/`、Windows `X:/`、UNC `//`）。 */
export function isAbsolute(p: string): boolean {
  const s = toPosix(p);
  return s.startsWith("/") || /^[A-Za-z]:\//.test(s);
}

/**
 * 詞法正規化為絕對 posix 路徑（折疊 `.` / `..`）。
 * 假設輸入已是絕對路徑；Windows drive 一律轉大寫以便比較。
 */
export function normalizeAbsolute(abs: string): string {
  let posix = toPosix(abs);
  // 僅 Windows：MSYS / Git-Bash 磁碟路徑 `/d/foo` 等同 `D:/foo`。
  // 單字母頂層段（`/<letter>` 後接 `/` 或結尾）視為磁碟機，轉成 `<LETTER>:/…`，
  // 使 `/d/`、`D:/`、`D:\` 三種寫法正規化為同一字串以便比較。
  // Linux / macOS 不套用（`/a/c/d` 是真實 POSIX 路徑、且區分大小寫）。
  if (IS_WINDOWS) {
    const msys = posix.match(/^\/([A-Za-z])(\/.*|)$/);
    if (msys) posix = msys[1].toUpperCase() + ":" + (msys[2] || "/");
  }
  let prefix = "";
  let rest = posix;
  const drive = posix.match(/^([A-Za-z]):\//);
  if (drive) {
    prefix = drive[1].toUpperCase() + ":";
    rest = posix.slice(drive[0].length - 1); // 保留開頭的 "/"
  }
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  return prefix + "/" + out.join("/");
}

/** 把相對路徑接在 cwd 之後再正規化。 */
function resolveAgainst(cwdPath: string, arg: string): string {
  const a = toPosix(arg);
  if (isAbsolute(a)) return normalizeAbsolute(a);
  const base = cwdPath.endsWith("/") ? cwdPath : cwdPath + "/";
  return normalizeAbsolute(base + a);
}

/** target 是否等於 root 或在 root 之下（兩者皆會先正規化）。 */
export function isWithin(root: string, target: string): boolean {
  const r = normalizeAbsolute(root);
  const t = normalizeAbsolute(target);
  if (t === r) return true;
  const rSlash = r.endsWith("/") ? r : r + "/";
  return t.startsWith(rSlash);
}

/** 範圍設定：專案根 + 外部唯讀範圍三分類（allow/deny/ask，與 settings 對齊）。 */
export interface ScopeConfig {
  root: string;
  allow: ReadScope;
  deny: ReadScope;
  ask: ReadScope;
}

/** 由裸 root 字串組成「無外部放寬」的 ScopeConfig；供既有測試與不需外部範圍的呼叫端使用（向後相容）。 */
export function rootScope(root: string): ScopeConfig {
  return {
    root,
    allow: { roots: [], files: [] },
    deny: { roots: [], files: [] },
    ask: { roots: [], files: [] },
  };
}

/** 單一 ReadScope 是否命中（roots 用 isWithin、files 用精確相等）。 */
function hits(s: ReadScope, absPosix: string): boolean {
  return s.roots.some((r) => isWithin(r, absPosix)) || s.files.some((f) => f === absPosix);
}

/**
 * 已正規化絕對 POSIX 路徑是否落在「允許讀取的位置」（政策合併在此決策層，非載入層）：
 *   專案根內 → true（永遠允許，不受外部 deny/ask 影響，保留「只放寬、不收窄」語義）；
 *   否則（外部）命中 deny → false；命中 ask → false（兩者皆否決放寬，維持 deny>ask>allow）；
 *   否則 命中 allow → true；其餘 → false。
 */
export function isReadScoped(absPosix: string, scope: ScopeConfig): boolean {
  if (isWithin(scope.root, absPosix)) return true; // root-first：專案內永遠允許
  if (hits(scope.deny, absPosix)) return false;
  if (hits(scope.ask, absPosix)) return false;
  if (hits(scope.allow, absPosix)) return true;
  return false;
}

/** 對「已取得的字串路徑值」做範圍檢查（三態）。 */
export function resolvePathValue(value: string | null, cwd: CwdState, scope: ScopeConfig): PathScope {
  if (value === null) return "dynamic";
  let abs: string;
  if (isAbsolute(value)) {
    abs = normalizeAbsolute(value);
  } else {
    if (cwd.kind === "unknown") return "dynamic";
    abs = resolveAgainst(cwd.path, value);
  }
  return isReadScoped(abs, scope) ? "in-project" : "out-of-project";
}

/** 解析單一參數對專案根的範圍（三態）。 */
export function resolvePath(arg: Word, cwd: CwdState, scope: ScopeConfig): PathScope {
  return resolvePathValue(staticValue(arg), cwd, scope);
}
