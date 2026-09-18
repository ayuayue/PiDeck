import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 迁自 tests/pi-deck-nul-redirect-fix.test.ts（该文件从未被 npm test 执行，
// 且测的是手工复制的函数副本而非生产模块）。这里直接加载生产扩展本体；
// @earendil-works/pi-coding-agent 是 ESM+运行时依赖，isToolCallEventType 仅在
// default export 内使用，给最小桩即可完成纯函数加载。
const { normalizeNulRedirects } = loadTsCommonJs(
 "resources/extensions/pi-deck-nul-redirect-fix.ts",
 {
  stubs: {
   "@earendil-works/pi-coding-agent": { isToolCallEventType: () => false },
  },
 },
);

// 用例表与原 .ts 逐条一致；起草期已实测生产函数与副本无漂移（33 项抽查全一致，
// redirectRe 逐字相同），迁移后预期直接全绿。
const testCases = [
 // ---- 基础 ----
 { name: "空字符串", input: "", expected: "" },
 { name: "无 nul 不变", input: "echo hello", expected: "echo hello" },
 { name: "grep nul 不是重定向", input: "grep nul file.txt", expected: "grep nul file.txt" },
 { name: "echo nul 不含重定向", input: "echo nul", expected: "echo nul" },
 { name: "echo null value", input: "echo null value", expected: "echo null value" },
 // ---- stdout 覆盖 ----
 { name: "> nul", input: "echo hello > nul", expected: "echo hello >/dev/null" },
 { name: ">NUL (大写)", input: "echo hello >NUL", expected: "echo hello >/dev/null" },
 { name: ">Nul (混合)", input: "echo hello >Nul", expected: "echo hello >/dev/null" },
 { name: ">  nul (多空格)", input: "echo hello >  nul", expected: "echo hello >/dev/null" },
 { name: ">nul (无空格)", input: "echo hello >nul", expected: "echo hello >/dev/null" },
 // ---- stdout 追加 ----
 { name: ">> nul", input: "echo hello >> nul", expected: "echo hello >>/dev/null" },
 { name: ">>  NUL", input: "echo hello >>  NUL", expected: "echo hello >>/dev/null" },
 // ---- fd 前缀 ----
 { name: "1> nul", input: "echo hello 1> nul", expected: "echo hello 1>/dev/null" },
 { name: "2> nul", input: "echo hello 2> nul", expected: "echo hello 2>/dev/null" },
 { name: "1>> nul", input: "echo hello 1>> nul", expected: "echo hello 1>>/dev/null" },
 { name: "2>> nul", input: "echo hello 2>> nul", expected: "echo hello 2>>/dev/null" },
 // ---- &> / &>> ----
 { name: "&> nul", input: "echo hello &> nul", expected: "echo hello &>/dev/null" },
 { name: "&>  Nul", input: "echo hello &>  Nul", expected: "echo hello &>/dev/null" },
 { name: "&>> nul", input: "echo hello &>> nul", expected: "echo hello &>>/dev/null" },
 { name: "&>>  NuL", input: "echo hello &>>  NuL", expected: "echo hello &>>/dev/null" },
 // ---- >& (csh-style) ----
 { name: ">& nul", input: "echo hello >& nul", expected: "echo hello >&/dev/null" },
 { name: ">&nul", input: "echo hello >&nul", expected: "echo hello >&/dev/null" },
 { name: ">&  NUL", input: "echo hello >&  NUL", expected: "echo hello >&/dev/null" },
 // ---- 多重重定向 ----
 { name: "两个 > nul", input: "echo a > nul && echo b > nul", expected: "echo a >/dev/null && echo b >/dev/null" },
 // ---- 控制字符边界 ----
 { name: "管道后", input: "echo hello > nul|cat", expected: "echo hello >/dev/null|cat" },
 { name: "分号后", input: "echo hello > nul;echo done", expected: "echo hello >/dev/null;echo done" },
 { name: "括号后", input: "echo hello > nul(extra", expected: "echo hello >/dev/null(extra" },
 // ---- 裸重定向 ----
 { name: ">nul 裸", input: ">nul", expected: ">/dev/null" },
 { name: "> nul 裸", input: "> nul", expected: ">/dev/null" },
 // ---- 不应重写：文件名场景 ----
 { name: "> nul.txt", input: "echo data > nul.txt", expected: "echo data > nul.txt" },
 { name: "> nul-backup", input: "echo data > nul-backup", expected: "echo data > nul-backup" },
 { name: "> nul_suffix", input: "echo data > nul_suffix", expected: "echo data > nul_suffix" },
 { name: "> null_file", input: "echo data > null_file", expected: "echo data > null_file" },
 // ---- 不应重写：引号内 ----
 { name: "双引号内 > nul", input: 'echo "foo > nul bar"', expected: 'echo "foo > nul bar"' },
 { name: "双引号内嵌套单引号", input: 'echo "foo \'bar > nul baz\'"', expected: 'echo "foo \'bar > nul baz\'"' },
 { name: "单引号内 > nul", input: "echo 'foo > nul bar'", expected: "echo 'foo > nul bar'" },
 // ---- 转义 ----
 { name: "转义的 > (奇数反斜杠)", input: "echo \\> nul", expected: "echo \\> nul" },
 { name: "未转义 (偶数反斜杠)", input: "echo \\\\> nul", expected: "echo \\\\>/dev/null" },
 { name: "3反斜杠转义", input: "echo \\\\\\> nul", expected: "echo \\\\\\> nul" },
 { name: "4反斜杠未转义", input: "echo \\\\\\\\> nul", expected: "echo \\\\\\\\>/dev/null" },
 { name: "6反斜杠未转义", input: "echo \\\\\\\\\\\\> nul", expected: "echo \\\\\\\\\\\\>/dev/null" },
 // ---- fd 与操作符空格分离 ----
 { name: "1 > nul (空格)", input: "echo hello 1 > nul", expected: "echo hello 1 >/dev/null" },
 { name: "2  >  nul", input: "echo hello 2  >  nul", expected: "echo hello 2  >/dev/null" },
 { name: "2 >>  nul", input: "echo hello 2 >>  nul", expected: "echo hello 2 >>/dev/null" },
 // ---- 混合引号 ----
 { name: "混合单双引号外重写", input: "echo 'a' \"b\" > nul", expected: "echo 'a' \"b\" >/dev/null" },
 { name: "单引号内含双引号不重写", input: "echo 'a \"b\" c' > nul", expected: "echo 'a \"b\" c' >/dev/null" },
 // ---- 2>&1 组合 ----
 { name: "2>&1 > nul", input: "cmd 2>&1 > nul", expected: "cmd 2>&1 >/dev/null" },
 { name: "2>&1 单独不匹配", input: "cmd 2>&1", expected: "cmd 2>&1" },
 // ---- 转义引号 ----
 { name: "转义双引号外重写", input: 'echo \\"foo > nul bar\\"', expected: 'echo \\"foo >/dev/null bar\\"' },
 { name: "双引号内转义双引号不重写", input: 'echo "foo \\"bar > nul baz"', expected: 'echo "foo \\"bar > nul baz"' },
 // ---- 反斜杠后单引号 ----
 { name: "反斜杠+单引号结束引号上下文", input: "echo 'foo\\\\' > nul", expected: "echo 'foo\\\\' >/dev/null" },
];

test("Windows 上按 shell 引号/转义规则改写 NUL 重定向（非 Windows 原样透传）", () => {
 if (process.platform === "win32") {
  for (const { name, input, expected } of testCases) {
   assert.equal(normalizeNulRedirects(input), expected, name);
  }
 } else {
  // 非 Windows 环境：所有命令应原样返回
  for (const { name, input, expected } of testCases) {
   if (input === "" || input === expected) continue;
   assert.equal(normalizeNulRedirects(input), input, `${name} (non-Win no-op)`);
  }
 }
});

test("非 Windows 平台透传（临时改写 process.platform）", () => {
 const saved = process.platform;
 Object.defineProperty(process, "platform", { value: "linux", configurable: true });
 try {
  for (const cmd of [
   "echo hello > nul",
   "echo hello 2>> nul",
   "echo hello &>> nul",
   "echo hello >& nul",
  ]) {
   assert.equal(normalizeNulRedirects(cmd), cmd);
  }
 } finally {
  Object.defineProperty(process, "platform", { value: saved, configurable: true });
 }
});
