import { isAbsolute, isWithin, normalizeAbsolute, toPosix } from "./engine/scope.ts";

/** 已正規化絕對 POSIX 路徑的最後一段（"/" → ""）。 */
function posixBasename(absPosix: string): string {
  const idx = absPosix.lastIndexOf("/");
  return idx < 0 ? absPosix : absPosix.slice(idx + 1);
}

/** 已正規化絕對 POSIX 路徑的 dirname；頂層 "/x" → "/"；無分隔符 → null。 */
function posixDirname(absPosix: string): string | null {
  const idx = absPosix.lastIndexOf("/");
  if (idx < 0) return null;
  if (idx === 0) return "/";
  return absPosix.slice(0, idx);
}

/** session_id 安全單一路徑段：僅 alnum / '_' / '-'（UUID 形即符合）；拒 . / .. / 分隔符 / 點 / 空。 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * 推導「當前 session 的 Claude Code 工具/任務輸出子目錄」清單（trusted read roots）。
 * 全部以 .../<session_id>/ 結尾（以全域唯一 session_id 為鍵 → 碰撞免疫）。
 * 任一安全閘不過或前置缺失 → []（fail-safe）。純詞法、不碰 FS、不丟例外。
 *
 * @param uid Deno.uid() 結果（由呼叫端 try/catch 取得；null 時不產生 /tmp 根）
 * @param includePrivateTmp main.ts 傳 Deno.build.os === "darwin"（macOS /tmp 為 /private/tmp 的 symlink）
 */
export function sessionTrustedReadRoots(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  home: string | null,
  uid: number | null,
  includePrivateTmp: boolean,
): string[] {
  if (home === null) return [];
  if (!sessionId || sessionId.trim() === "") return [];
  if (!transcriptPath || transcriptPath.trim() === "") return [];

  const sid = sessionId.trim();
  if (!SAFE_SESSION_ID.test(sid)) return []; // 先於任何把 sid 串入路徑的動作（封 . / .. / 逃逸）

  const t = transcriptPath.trim();
  if (!isAbsolute(t)) return [];
  if (!toPosix(t).endsWith(".jsonl")) return []; // 大小寫敏感

  const abs = normalizeAbsolute(t);
  if (posixBasename(abs) !== sid + ".jsonl") return []; // transcript 檔名須等於 <session_id>.jsonl（綁定當前 session）

  const dir = posixDirname(abs);
  if (dir === null) return [];

  const projectsRoot = normalizeAbsolute(home + "/.claude/projects");
  if (!isWithin(projectsRoot, dir) || dir === projectsRoot) return []; // dir 須嚴格在 <home>/.claude/projects/ 之下且至少一段

  const e = posixBasename(dir); // 權威編碼段（非重算）
  const roots: string[] = [normalizeAbsolute(dir + "/" + sid)]; // ~/.claude session 子目錄
  if (uid !== null) {
    const bases = includePrivateTmp ? ["/tmp", "/private/tmp"] : ["/tmp"];
    for (const b of bases) {
      roots.push(normalizeAbsolute(b + "/claude-" + uid + "/" + e + "/" + sid));
    }
  }

  // Post-construction 不變量（defense-in-depth）：~/.claude 根（roots[0]）的 dirname 必為已驗證的 dir，
  // 且每個 root 的 basename 必為 sid。SAFE_SESSION_ID 安全段檢查已保證此恆成立，此處僅防未來建構邏輯回歸。
  if (posixDirname(roots[0]) !== dir) return [];
  for (const r of roots) {
    if (posixBasename(r) !== sid) return [];
  }
  return roots;
}
