import { assertEquals } from "@std/assert";
import { resolveProjectRoot } from "./project.ts";

function envOf(value: string | undefined) {
  return { get: (_k: string) => value } as { get(k: string): string | undefined };
}

Deno.test("resolves and normalizes CLAUDE_PROJECT_DIR", () => {
  assertEquals(resolveProjectRoot(envOf("/home/me/proj/")), "/home/me/proj");
});

Deno.test("normalizes windows path", () => {
  assertEquals(resolveProjectRoot(envOf("D:\\proj")), "D:/proj");
});

Deno.test("unset returns null", () => {
  assertEquals(resolveProjectRoot(envOf(undefined)), null);
});

Deno.test("blank returns null", () => {
  assertEquals(resolveProjectRoot(envOf("   ")), null);
});
