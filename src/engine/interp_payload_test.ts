import { assertEquals } from "@std/assert";
import { payloadIsAllStaticPrint, printExprIsStaticString } from "./interp_payload.ts";

Deno.test("payloadIsAllStaticPrint: js 命中", () => {
  const t = (s: string) => assertEquals(payloadIsAllStaticPrint(s, "js"), true, s);
  t('console.log("fake")');
  t('console.log("a");\nconsole.log("b")');
  t('// comment\nconsole.log("x")');
  t('console.log("a", "b", 1)');
  t('console.log(`plain`)');
  t('console.error("e"); console.info("i")');
  t('process.stdout.write("fake")');
  t('console.log(42)');
  t('console.log(-1)');            // 帶號數字
});

Deno.test("payloadIsAllStaticPrint: js 不命中", () => {
  const f = (s: string) => assertEquals(payloadIsAllStaticPrint(s, "js"), false, s);
  f('console.log(1+1)');
  f('console.log("a"+"b")');
  f('console.log(JSON.stringify(x))');
  f('console.log(x)');
  f('console.log(`${x}`)');
  f('import x from "y"; console.log("a")');
  f('if (a) console.log("x")');
  f('console.log(');
  f('console.log("unterminated');
  f('');
  f('console.log()');
  f('process.stdout.write(42)');
  f('foo("x")');
  f('console.log(r"x")');                    // js 無 r 前綴 → r 為識別字 → 非法
  f('console.log("a")console.log("b")');     // 兩敘述無分隔符 → 非法
  f('console.log(0x)');                       // 基底前綴無數字 → 非法
  f('console.log(0b2)');                       // 二進位含 2 → 非法
  f('console.log(0o9)');                       // 八進位含 9 → 非法
  f('console.log("a" "b")');                   // js 無相鄰字串串接 → 語法錯誤 → 非法
});

Deno.test("payloadIsAllStaticPrint: py 邊界（前綴需緊鄰、單行、無 js 專屬形式）", () => {
  assertEquals(payloadIsAllStaticPrint('print(1n)', "py"), false);     // BigInt 僅 js
  assertEquals(payloadIsAllStaticPrint('print(r "x")', "py"), false);  // 前綴與引號間有空白 → 非法
  assertEquals(payloadIsAllStaticPrint('print("a\nb")', "py"), false); // 非三引號字串跨行 → 非法
});

Deno.test("payloadIsAllStaticPrint: py", () => {
  assertEquals(payloadIsAllStaticPrint('print("x")', "py"), true);
  assertEquals(payloadIsAllStaticPrint("print('a')\nprint('b')", "py"), true);
  assertEquals(payloadIsAllStaticPrint('# c\nprint("x")', "py"), true);
  assertEquals(payloadIsAllStaticPrint('print("""multi""")', "py"), true);
  assertEquals(payloadIsAllStaticPrint('sys.stdout.write("x")', "py"), true);
  assertEquals(payloadIsAllStaticPrint('print(-1)', "py"), true);
  assertEquals(payloadIsAllStaticPrint('print(json.dumps(d))', "py"), false);
  assertEquals(payloadIsAllStaticPrint('print(f"{x}")', "py"), false);
  assertEquals(payloadIsAllStaticPrint('print("x", end="")', "py"), false);
  assertEquals(payloadIsAllStaticPrint('sys.stdout.write(1)', "py"), false);
  assertEquals(payloadIsAllStaticPrint("print(`x`)", "py"), false);   // py 無反引號字串
  assertEquals(payloadIsAllStaticPrint('print(r"x")', "py"), true);   // py r 前綴 → 靜態字串
});

Deno.test("payloadIsAllStaticPrint: 資源上限超標 → false", () => {
  assertEquals(payloadIsAllStaticPrint('console.log("x");'.repeat(20000), "js"), false);
});

Deno.test("printExprIsStaticString", () => {
  assertEquals(printExprIsStaticString('"fake"', "js"), true);
  assertEquals(printExprIsStaticString('"a" + "b"', "js"), true);
  assertEquals(printExprIsStaticString('`x`', "js"), true);
  assertEquals(printExprIsStaticString('1+1', "js"), false);
  assertEquals(printExprIsStaticString('os.cpus()', "js"), false);
  assertEquals(printExprIsStaticString('`${x}`', "js"), false);
});
