import type { EnvReader } from "../project.ts";
import { normalizeAbsolute } from "../engine/scope.ts";
import { type BashPattern, parseBashRule } from "./matcher.ts";
import { EMPTY_READ_SCOPE, parsePathRule, type ReadScope } from "./path_scope.ts";

/** Bash(...) 規則三分類（對齊 settings permissions 結構）。 */
export interface BashRules {
  allow: BashPattern[];
  deny: BashPattern[];
  ask: BashPattern[];
}

/** Read/Edit/Write 化約的外部唯讀範圍三分類（與 settings 對齊；deny/ask 不在載入層合併）。 */
export interface ReadScopeRules {
  allow: ReadScope;
  deny: ReadScope;
  ask: ReadScope;
}

export interface PermissionRules {
  bash: BashRules; // 原扁平的 { allow, deny, ask } 移入此層
  readScope: ReadScopeRules;
}

export const EMPTY_RULES: PermissionRules = {
  bash: { allow: [], deny: [], ask: [] },
  readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
};

/** 讀檔器：回傳檔案內容字串；不存在 / 無法讀 → null。注入以利測試。 */
export type ReadText = (path: string) => string | null;

/** 預設讀檔器：任何錯誤（NotFound / 權限 / 路徑為目錄 / I/O）一律吞掉回 null，不區分類型、不重拋。 */
export const defaultReadText: ReadText = (path) => {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
};

function emptyRules(): PermissionRules {
  return {
    bash: { allow: [], deny: [], ask: [] },
    readScope: {
      allow: { roots: [], files: [] },
      deny: { roots: [], files: [] },
      ask: { roots: [], files: [] },
    },
  };
}

function parseRuleList(value: unknown): BashPattern[] {
  if (!Array.isArray(value)) return [];
  const out: BashPattern[] = [];
  for (const el of value) {
    if (typeof el !== "string") continue;
    const pat = parseBashRule(el);
    if (pat !== null) out.push(pat);
  }
  return out;
}

function parsePathRuleList(value: unknown, home: string | null): ReadScope {
  const out: ReadScope = { roots: [], files: [] };
  if (!Array.isArray(value)) return out;
  for (const el of value) {
    if (typeof el !== "string") continue;
    let entry: ReturnType<typeof parsePathRule>;
    try {
      entry = parsePathRule(el, home);
    } catch {
      entry = null;
    }
    if (entry === null) continue;
    if (entry.kind === "root") out.roots.push(entry.path);
    else out.files.push(entry.path);
  }
  return out;
}

function parseFile(content: string | null, home: string | null): PermissionRules {
  if (content === null) return emptyRules();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return emptyRules();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyRules();
  const perms = (parsed as Record<string, unknown>).permissions;
  if (typeof perms !== "object" || perms === null) return emptyRules();
  const p = perms as Record<string, unknown>;
  return {
    bash: {
      allow: parseRuleList(p.allow),
      deny: parseRuleList(p.deny),
      ask: parseRuleList(p.ask),
    },
    readScope: {
      allow: parsePathRuleList(p.allow, home),
      deny: parsePathRuleList(p.deny, home),
      ask: parsePathRuleList(p.ask, home),
    },
  };
}

/** 依平台解析家目錄；皆無 → null。 */
function resolveHome(env: EnvReader): string | null {
  const isWindows = Deno.build.os === "windows";
  const primary = isWindows ? env.get("USERPROFILE") : env.get("HOME");
  const fallback = isWindows ? env.get("HOME") : env.get("USERPROFILE");
  if (primary && primary.trim() !== "") return primary;
  if (fallback && fallback.trim() !== "") return fallback;
  return null;
}

/**
 * 讀取並合併 專案 settings.json / settings.local.json / 使用者 ~/.claude/settings.json。
 * 任一檔失敗僅該檔貢獻空集合；永不丟例外、永不回 null（最外層 try/catch 兜底）。
 */
export function loadPermissionRules(
  env: EnvReader,
  root: string,
  readText: ReadText = defaultReadText,
): PermissionRules {
  try {
    const paths: string[] = [
      `${root}/.claude/settings.json`,
      `${root}/.claude/settings.local.json`,
    ];
    const home = resolveHome(env);
    if (home !== null) {
      paths.push(normalizeAbsolute(`${home}/.claude/settings.json`));
    }
    const merged = emptyRules();
    for (const path of paths) {
      let rules: PermissionRules;
      try {
        rules = parseFile(readText(path), home);
      } catch {
        rules = emptyRules();
      }
      merged.bash.allow.push(...rules.bash.allow);
      merged.bash.deny.push(...rules.bash.deny);
      merged.bash.ask.push(...rules.bash.ask);
      for (const k of ["allow", "deny", "ask"] as const) {
        merged.readScope[k].roots.push(...rules.readScope[k].roots);
        merged.readScope[k].files.push(...rules.readScope[k].files);
      }
    }
    return merged;
  } catch {
    return emptyRules();
  }
}
