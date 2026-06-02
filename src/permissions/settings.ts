import type { EnvReader } from "../project.ts";
import { normalizeAbsolute } from "../engine/scope.ts";
import { type BashPattern, parseBashRule } from "./matcher.ts";

export interface PermissionRules {
  allow: BashPattern[];
  deny: BashPattern[];
  ask: BashPattern[];
}

/** 空規則常數，供 classify.ts / evaluate.ts 作為預設參數（只讀，勿變動）。 */
export const EMPTY_RULES: PermissionRules = { allow: [], deny: [], ask: [] };

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
  return { allow: [], deny: [], ask: [] };
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

function parseFile(content: string | null): PermissionRules {
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
    allow: parseRuleList(p.allow),
    deny: parseRuleList(p.deny),
    ask: parseRuleList(p.ask),
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
        rules = parseFile(readText(path));
      } catch {
        rules = emptyRules();
      }
      merged.allow.push(...rules.allow);
      merged.deny.push(...rules.deny);
      merged.ask.push(...rules.ask);
    }
    return merged;
  } catch {
    return emptyRules();
  }
}
