import type { Word } from "../deps.ts";
import { staticValue } from "./word.ts";
import type { CwdState } from "../types.ts";

export type PathScope = "in-project" | "out-of-project" | "dynamic";

/**
 * 是否為 Windows 目標。MSYS / Git-Bash 的 `/d/` 磁碟路徑慣例只存在於 Windows；
 * 在 Linux / macOS，`/d/...` 是貨真價實的 POSIX 路徑（且檔名區分大小寫），
 * 不可改寫。編譯後的 binary 此值固定為編譯目標 OS。
 */
const IS_WINDOWS = Deno.build.os === "windows";

/** 反斜線轉斜線。 */
function toPosix(p: string): string {
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

/** 對「已取得的字串路徑值」做範圍檢查（三態）。 */
export function resolvePathValue(value: string | null, cwd: CwdState, root: string): PathScope {
  if (value === null) return "dynamic";
  if (isAbsolute(value)) {
    return isWithin(root, value) ? "in-project" : "out-of-project";
  }
  if (cwd.kind === "unknown") return "dynamic";
  const resolved = resolveAgainst(cwd.path, value);
  return isWithin(root, resolved) ? "in-project" : "out-of-project";
}

/** 解析單一參數對專案根的範圍（三態）。 */
export function resolvePath(arg: Word, cwd: CwdState, root: string): PathScope {
  return resolvePathValue(staticValue(arg), cwd, root);
}
