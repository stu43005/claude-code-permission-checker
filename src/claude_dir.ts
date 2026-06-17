import { isAbsolute, isWithin, normalizeAbsolute, toPosix } from "./engine/scope.ts";
import { basename, dirname } from "node:path/posix";
import type { EnvReader } from "./project.ts";

/** session_id 安全單一路徑段：僅 alnum / '_' / '-'（UUID 形即符合）；拒 . / .. / 分隔符 / 點 / 空。 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Claude 設定目錄解析（依 domain 與 trusted root 推導同置於本檔）：
 * CLAUDE_CONFIG_DIR（去空白、正規化）優先，否則 <home>/.claude；home 亦無 → null。
 * 收已解析的 home 參數、不內呼 resolveHome，維持 settings.ts → claude_dir.ts 單向依賴、避免循環。
 */
export function resolveClaudeConfigDir(env: EnvReader, home: string | null): string | null {
  const explicit = env.get("CLAUDE_CONFIG_DIR");
  if (explicit && explicit.trim() !== "") return normalizeAbsolute(explicit.trim());
  if (home === null) return null;
  return normalizeAbsolute(`${home}/.claude`);
}

/**
 * 推導「當前 session 的 Claude Code 工具/任務輸出子目錄」清單（trusted read roots）。
 * 全部以 .../<session_id>/ 結尾（以全域唯一 session_id 為鍵 → 碰撞免疫）。
 * 任一安全閘不過或前置缺失 → []（fail-safe）。純詞法、不碰 FS/env、不丟例外。
 *
 * @param claudeConfigDir CLAUDE_CONFIG_DIR ?? <home>/.claude（由 main.ts 解析；null → []）
 * @param os              Deno.build.os 的值（"windows"/"darwin"/"linux"…）
 * @param uid             Deno.uid() 結果（呼叫端 try/catch；null 時 POSIX 不產生 tmp 系根、Windows 不受影響）
 * @param osTmpBase       CLAUDE_CODE_TMPDIR ?? os.tmpdir()（由 main.ts 解析；null/空 → 不納入該 base）
 */
export function sessionTrustedReadRoots(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  claudeConfigDir: string | null,
  os: string,
  uid: number | null,
  osTmpBase: string | null,
): string[] {
  if (claudeConfigDir === null) return [];
  if (!sessionId || sessionId.trim() === "") return [];
  if (!transcriptPath || transcriptPath.trim() === "") return [];

  const trimmedSessionId = sessionId.trim();
  if (!SAFE_SESSION_ID.test(trimmedSessionId)) return []; // 先於任何把 sid 串入路徑的動作

  const trimmedTranscript = transcriptPath.trim();
  if (!isAbsolute(trimmedTranscript)) return [];
  if (!toPosix(trimmedTranscript).endsWith(".jsonl")) return []; // 大小寫敏感

  const absoluteTranscript = normalizeAbsolute(trimmedTranscript);
  if (basename(absoluteTranscript) !== trimmedSessionId + ".jsonl") return []; // transcript 檔名須等於 <session_id>.jsonl

  const encodedProjectDir = dirname(absoluteTranscript); // <configDir>/projects/<E>
  const projectsRoot = normalizeAbsolute(claudeConfigDir + "/projects");
  if (!isWithin(projectsRoot, encodedProjectDir) || encodedProjectDir === projectsRoot) return []; // transcript 須在 <configDir>/projects/<E> 之下且非該根本身

  const encodedSegment = basename(encodedProjectDir); // <E>（權威編碼段，非重算）
  const trustedRoots: string[] = [normalizeAbsolute(encodedProjectDir + "/" + trimmedSessionId)];

  // —— tmp 來源跨 OS 聯集（純靜態目錄推導；信任 osTmpBase，不做 fs/symlink/junction/UNC/共享檢查）——
  const normalizedOsTmp = osTmpBase && osTmpBase.trim() !== "" ? normalizeAbsolute(osTmpBase.trim()) : null;
  let tmpBases: { base: string; claudeDirName: string }[] = [];
  if (os === "windows") {
    if (normalizedOsTmp !== null) tmpBases = [{ base: normalizedOsTmp, claudeDirName: "claude" }]; // 無 uid
  } else if (uid !== null) {
    const claudeDirName = "claude-" + uid;
    tmpBases = [normalizedOsTmp, "/tmp", os === "darwin" ? "/private/tmp" : null]
      .filter((base): base is string => base !== null)
      .map((base) => ({ base, claudeDirName }));
  }
  for (const { base, claudeDirName } of tmpBases) {
    trustedRoots.push(
      normalizeAbsolute(base + "/" + claudeDirName + "/" + encodedSegment + "/" + trimmedSessionId),
    );
  }

  const dedupedRoots = [...new Set(trustedRoots)]; // normalizedOsTmp 與 /tmp 相同時去重、保序

  // Post-construction 不變量（defense-in-depth）：session 根 dirname 必為已驗證的 encodedProjectDir，
  // 且每個 root 的 basename 必為 sid。SAFE_SESSION_ID 已保證恆成立，此處僅防未來回歸。
  if (dirname(dedupedRoots[0]) !== encodedProjectDir) return [];
  for (const root of dedupedRoots) {
    if (basename(root) !== trimmedSessionId) return [];
  }
  return dedupedRoots;
}
