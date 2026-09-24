import type { Word, WordPart } from "../deps.ts";
import { isDriveRelative, staticValue } from "./word.ts";
import type { CwdState } from "../types.ts";
import type { ReadScope } from "../permissions/path_scope.ts";
import type { PermissionRules } from "../permissions/settings.ts";
import { expandTilde, hasUnquotedLeadingTilde } from "./tilde.ts";
import { parseGlobPath } from "./glob.ts";

// 維持既有匯入點（cwd.ts 等從 scope.ts 匯入）；定義已搬到 word.ts。
export { isDriveRelative };

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

/** 路徑是否含獨立 ".." 段（以 "/" 切段比對，排除檔名內的 ".." 如 foo..bar）。 */
function hasDotDotSegment(posix: string): boolean {
  return posix.split("/").some((seg) => seg === "..");
}

/**
 * 相對路徑詞法正規化：折疊 `//`、移除 `.` 段；**不**解析 `..`、**不**加前導 `/`。
 * 呼叫端保證傳入的 posix 不含獨立 `..` 段（已由 canonicalizeExecPath 規則 3 攔截）。
 */
function lexicalNormalizeRelative(posix: string): string {
  const out: string[] = [];
  for (const seg of posix.split("/")) {
    if (seg === "" || seg === ".") continue;
    out.push(seg);
  }
  return out.join("/");
}

/**
 * 把單一執行檔 token 做純詞法正規化（不碰檔案系統、不依賴 cwd、idempotent）。
 * 指令側與 pattern 側對稱套用。轉換限定：展開 `~`/`~/`、折疊中段 `//`、移除 `.` 段。
 * 三道 fail-closed：前導 `//`（UNC，避免 UNC 根被改寫）、含獨立 `..` 段（symlink/junction 下
 * 詞法折疊不等於真實路徑）、正規化後塌成空/裸根 → 一律原樣返回 token。
 */
export function canonicalizeExecPath(token: string, home: string | null): string {
  // 規則 1：裸指令名（無 / 無 \ 且非 ~、~/）→ 原樣
  if (!token.includes("/") && !token.includes("\\") && token !== "~" && !token.startsWith("~/")) {
    return token;
  }
  // POSIX 反斜線守門：非 Windows 上 `\` 是路徑字面 byte（非分隔符）；toPosix 會把 `\`→`/`，
  // 對含反斜線的執行檔 token 會改寫成不同路徑（不同檔）→ 留字面、不正規化（fail-closed）。
  // Windows 上 `\` 為分隔符，照常處理。
  if (Deno.build.os !== "windows" && token.includes("\\")) return token;
  // 規則 2：前導 //（UNC / 歧義絕對）→ 原樣（fail-closed，不 toPosix、不折疊）
  if (toPosix(token).startsWith("//")) return token;
  // 規則 3：含獨立 .. 段 → 原樣（symlink/junction 安全）
  if (hasDotDotSegment(toPosix(token))) return token;

  // 規則 4：~ / ~/ 展開（home 為 null → 原樣，僅停用 ~ 展開）
  let work = token;
  if (token === "~" || token.startsWith("~/")) {
    if (home === null) return token;
    work = token === "~" ? home : home + token.slice(1); // "~/x" -> home + "/x"
    // 展開後重檢 fail-closed：home 本身為 UNC（前導 //）或含 `..` 段時，展開結果會把 UNC 根
    // 改寫成本機絕對路徑、或在 symlink 下失真 → 拒絕展開、原樣返回 token（規則 2/3 套用於展開後路徑）。
    const expanded = toPosix(work);
    if (expanded.startsWith("//") || hasDotDotSegment(expanded)) return token;
  }

  const posix = toPosix(work);
  // 尾斜線語義（依原 token，非 work）；單一根 "/" 不算
  const hadTrailingSlash = /[/\\]$/.test(token) && toPosix(token) !== "/";

  let normalized: string;
  if (isAbsolute(posix)) {
    // 規則 6：絕對 → normalizeAbsolute（.. 已被規則 3 攔截，故僅折疊 //、移除 .、Windows 磁碟正規化）
    normalized = normalizeAbsolute(posix);
  } else {
    // 規則 5：相対 → 維持相對的詞法正規化
    normalized = lexicalNormalizeRelative(posix);
    // 類別保留 fail-closed：相對 token 原含 "/"（→ 以路徑執行、非 PATH 查找）卻塌成
    // 無 "/" 的裸名（→ PATH 查找）時，兩者 shell 語義不同（如 ./npm vs npm），
    // 正規化跨越此邊界會造成誤升級 → 原樣返回 token。
    if (posix.includes("/") && !normalized.includes("/")) return token;
  }

  // 零段／塌根 fail-closed：結果塌成空、或塌成裸根而原非該裸根 → 原樣 token
  const isBareRoot = normalized === "/" || /^[A-Za-z]:\/$/.test(normalized);
  if (normalized === "" || (isBareRoot && posix !== normalized)) {
    return token;
  }

  // 尾斜線保留（零段 fail-closed 已先返回者不到這裡）
  if (hadTrailingSlash && !normalized.endsWith("/")) normalized += "/";
  return normalized;
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
  home: string | null;
  /**
   * bash 的 home（`$HOME`），**僅供 tilde 展開**。與上方 `home` 刻意分離：
   * `home` 來自 settings 的 resolveHome（Windows 優先 USERPROFILE），供權限規則
   * 與 <home>/.claude 定位使用；bash 的 tilde expansion 只看 HOME。兩者不同時混用
   * 會拿「已授權的 USERPROFILE 路徑」核准「未授權的 HOME 路徑」。
   */
  shellHome: string | null;
  allow: ReadScope;
  deny: ReadScope;
  ask: ReadScope;
  /** hook 自身推導的「當前 session」可信唯讀目錄根（與使用者規則分離；allow 同級）。 */
  trusted: string[];
}

/**
 * 由 root / rules / home / trusted 建構 ScopeConfig。
 * evaluate（計算 session cwd 是否在範圍內）與 classify（逐葉路徑判定）皆呼叫此函式，
 * 確保兩處使用完全相同的範圍定義，不會分歧。
 */
export function buildScopeConfig(
  root: string,
  rules: PermissionRules,
  home: string | null,
  trustedReadRoots: string[],
  shellHome: string | null = null,
): ScopeConfig {
  return {
    root,
    home,
    shellHome,
    allow: rules.readScope.allow,
    deny: rules.readScope.deny,
    ask: rules.readScope.ask,
    trusted: trustedReadRoots,
  };
}

/** 由裸 root 字串組成「無外部放寬」的 ScopeConfig；供既有測試與不需外部範圍的呼叫端使用（向後相容）。 */
export function rootScope(root: string): ScopeConfig {
  return {
    root,
    home: null,
    shellHome: null,
    allow: { roots: [], files: [] },
    deny: { roots: [], files: [] },
    ask: { roots: [], files: [] },
    trusted: [],
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
  if (scope.trusted.some((r) => isWithin(r, absPosix))) return true; // trusted（allow 同級，deny/ask 已先否決）
  return false;
}

/** 絕對／相對路徑的範圍判定本體；呼叫端負責先處理 tilde 語義。 */
function resolveResolvedValue(value: string, cwd: CwdState, scope: ScopeConfig): PathScope {
  // 磁碟相對形態（`C:Windows`）語義有歧義且無正當寫法 → 直接拒絕
  if (isDriveRelative(value)) return "out-of-project";
  let abs: string;
  if (isAbsolute(value)) {
    abs = normalizeAbsolute(value);
  } else {
    if (cwd.kind === "unknown") return "dynamic";
    abs = resolveAgainst(cwd.path, value);
  }
  return isReadScoped(abs, scope) ? "in-project" : "out-of-project";
}

/**
 * 對「已取得的字串路徑值」做範圍檢查（三態）。
 *
 * 字串值沒有 word 結構，無從判斷開頭的 `~` 是否被引號保護：未加引號時 bash 展開為 $HOME
 * （專案外），加引號時是 `./~`（專案內）。無法區分就取安全的一邊 → fail-closed。
 * 代價是 `--flag="~/x"` 這類引號形態會被誤 ask；此形態罕見，方向安全。
 */
export function resolvePathValue(value: string | null, cwd: CwdState, scope: ScopeConfig): PathScope {
  if (value === null) return "dynamic";
  if (value.startsWith("~")) return "out-of-project";
  return resolveResolvedValue(value, cwd, scope);
}

/**
 * 解析單一參數對專案根的範圍（三態）。
 *
 * 有 word 結構可用，因此能精確區分兩種 tilde：
 *   未加引號（`~/x`、`~/"x"`）→ bash 會展開 → 以 shellHome 展開後判定，不可解析則超出範圍
 *   引號包裝（`"~/x"`）      → bash 不展開，指向 `./~/x` → 走一般相對路徑語義（維持既有行為）
 */
export function resolvePath(arg: Word, cwd: CwdState, scope: ScopeConfig): PathScope {
  const v = staticValue(arg);
  if (v === null) return "dynamic";
  if (hasUnquotedLeadingTilde(arg)) {
    const expanded = expandTilde(v, scope.shellHome);
    // 不支援的 tilde 形態（~user / ~+ / ~-）或 shellHome 未知 → 絕不退回相對路徑語義，
    // 那正是本次要修的漏洞（`cat ~/.ssh/id_rsa` 被判成 <project>/~/.ssh/id_rsa）。
    if (expanded === null) return "out-of-project";
    return resolveResolvedValue(expanded, cwd, scope);
  }
  // 引號形態的 `~` 走到這裡：不經 resolvePathValue 的字串 tilde 檢查，維持相對語義。
  return resolveResolvedValue(v, cwd, scope);
}

/** 已正規化絕對 POSIX 路徑是否為磁碟根（/、X:/）或恰好等於家目錄。 */
export function isDangerousRootAbs(absPosix: string, home: string | null): boolean {
  if (absPosix === "/") return true;
  if (/^[A-Za-z]:\/$/.test(absPosix)) return true;
  if (home !== null && absPosix === normalizeAbsolute(home)) return true;
  return false;
}

const HOME_VAR_NAMES = IS_WINDOWS ? ["HOME", "USERPROFILE"] : ["HOME"];

/** Word 是否為「單獨的家目錄變數展開」：$HOME / ${HOME} / $HOME/ / $USERPROFILE(Windows)。 */
function loneHomeExpansion(word: Word): boolean {
  const parts = word.parts;
  if (!parts || parts.length === 0) return false;
  let head: WordPart;
  if (parts.length === 1) {
    head = parts[0];
  } else if (parts.length === 2) {
    const tail = parts[1];
    if (tail.type === "Literal" && tail.value === "/") {
      head = parts[0]; // $HOME/（純結尾斜線 = 家目錄本身）
    } else {
      return false;
    }
  } else {
    return false;
  }
  if (head.type === "SimpleExpansion") {
    const name = head.text.slice(1); // SimpleExpansionPart.text 形如 "$HOME"，去掉開頭 "$"
    return HOME_VAR_NAMES.includes(name);
  }
  if (head.type === "ParameterExpansion") {
    // 純 ${HOME}：任何修飾子（:- / # / ! / index…）都會讓 text ≠ "${<parameter>}"，故以 text 比對排除
    return head.text === "${" + head.parameter + "}" && HOME_VAR_NAMES.includes(head.parameter);
  }
  return false;
}

/**
 * Word 是否指向磁碟根 / 家目錄根：
 *   1) lone home expansion（$HOME/${HOME}/$HOME/、Windows $USERPROFILE）
 *   2) 字面 ~ 或 ~/
 *   3) 靜態絕對/相對解析後 isDangerousRootAbs
 *   其餘（動態、cwd 未知的相對路徑、子目錄）→ false
 */
export function dangerousRoot(arg: Word, cwd: CwdState, home: string | null): boolean {
  if (loneHomeExpansion(arg)) return true;
  const v = staticValue(arg);
  if (v === null) return false;
  if (v === "~" || v === "~/") return true;
  let abs: string;
  if (isAbsolute(v)) {
    abs = normalizeAbsolute(v);
  } else {
    if (cwd.kind === "unknown") return false;
    abs = resolveAgainst(cwd.path, v);
  }
  return isDangerousRootAbs(abs, home);
}

/** glob 前綴解析成已正規化絕對路徑；cwd unknown 且前綴為相對路徑時回 null。 */
function globPrefixAbs(prefix: string, cwd: CwdState): string | null {
  if (isAbsolute(prefix)) return normalizeAbsolute(prefix);
  if (cwd.kind === "unknown") return null;
  return prefix === "" ? normalizeAbsolute(cwd.path) : resolveAgainst(cwd.path, prefix);
}

/** ReadScope 是否有任何 root / file 嚴格位於 dir 之下。 */
function hasStrictDescendant(s: ReadScope, dir: string): boolean {
  return [...s.roots, ...s.files].some((x) => {
    const n = normalizeAbsolute(x);
    return n !== dir && isWithin(dir, n);
  });
}

/**
 * glob 路徑操作元的範圍判定（三態）。glob 展開結果必落在字面前綴目錄 P 之下，故判定 P 是否被
 * 「以目錄形式」涵蓋：專案根 → 涵蓋；外部則需 allow root / trusted root 涵蓋（**精確單檔 allow
 * 不算**），且 P 之下不得有任何 deny/ask 條目（glob 可能展開進被否決的子樹）。
 */
export function resolveGlobPath(arg: Word, cwd: CwdState, scope: ScopeConfig): PathScope {
  const g = parseGlobPath(arg);
  if (g === null) return "dynamic";
  const p = globPrefixAbs(g.prefix, cwd);
  if (p === null) return "dynamic";
  if (isWithin(scope.root, p)) return "in-project"; // root-first
  if (hits(scope.deny, p) || hits(scope.ask, p)) return "out-of-project";
  const covered = scope.allow.roots.some((r) => isWithin(r, p)) ||
    scope.trusted.some((r) => isWithin(r, p));
  if (!covered) return "out-of-project";
  if (hasStrictDescendant(scope.deny, p) || hasStrictDescendant(scope.ask, p)) return "out-of-project";
  return "in-project";
}

/**
 * glob 操作元是否可能選中磁碟根 / 家目錄根：前綴 P 本身是危險根（展開為其子項，效果等同遍歷整個根；
 * Windows 上 `/` 的子項 `/c` 即磁碟根），或 P 是家目錄的祖先（可能選中家目錄本身，如 `/home/m?`）。
 * cwd unknown 且前綴相對 → true（fail-closed）。非合格 glob 形態 → false（它不會被當成 glob 操作元接受）。
 */
export function globMaySelectDangerousRoot(arg: Word, cwd: CwdState, home: string | null): boolean {
  const g = parseGlobPath(arg);
  if (g === null) return false;
  const p = globPrefixAbs(g.prefix, cwd);
  if (p === null) return true;
  if (isDangerousRootAbs(p, home)) return true;
  return home !== null && isWithin(p, normalizeAbsolute(home));
}
