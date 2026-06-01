import { normalizeAbsolute } from "./engine/scope.ts";

export interface EnvReader {
  get(key: string): string | undefined;
}

/** 從 $CLAUDE_PROJECT_DIR 解析專案根；未設定 / 空白 → null。 */
export function resolveProjectRoot(env: EnvReader): string | null {
  const raw = env.get("CLAUDE_PROJECT_DIR");
  if (!raw || raw.trim() === "") return null;
  return normalizeAbsolute(raw.trim());
}
