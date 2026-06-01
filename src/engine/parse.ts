import { parse } from "../deps.ts";
import type { ParseError, Script } from "../deps.ts";

export interface ParseResult {
  script: Script;
  errors: ParseError[];
}

/** 包 unbash.parse；errors 統一為陣列（容錯解析永不拋例外）。 */
export function parseCommand(source: string): ParseResult {
  const script = parse(source);
  return { script, errors: script.errors ?? [] };
}
