import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 流程守卫回归（备忘录 2026-09-17 第三批 H5/L12）：
 * 1. ci.yml 必须接入 check:* 守卫（--check 模式只校验不写盘），
 *    挡住「改了 md/扩展/清单源但忘跑对应 generate/build」的漂移直入 main；
 * 2. 守卫步骤必须先于 Build 执行——npm run build 链会静默再生成清单，
 *    放在 Build 之后会 mask 掉已提交的漂移，等于白接；
 * 3. npm test 必须默认串行——并发模式（--test-concurrency=4）下测试文件
 *    共享进程全局状态，Windows 偶发死锁挂起（ci.yml Test 步骤注释同源）。
 */

const ciYml = readFileSync(".github/workflows/ci.yml", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

test("ci.yml 接入全部 check:* 守卫，且位于 npm ci 之后、Build 之前", () => {
 const guardScripts = [
  "check:announcements",
  "check:pi-ai-catalog",
  "check:extensions-manifest",
  "check:prompts-manifest",
  "check:skills-manifest",
 ];
 for (const script of guardScripts) {
  assert.ok(pkg.scripts[script], `package.json 缺少 ${script}`);
  assert.ok(
   ciYml.includes(`npm run ${script}`),
   `ci.yml 缺少守卫命令 npm run ${script}`,
  );
 }
 // check:xueprompts 已内联在 npm run build 脚本链里，不重复接入

 const guardStepIndex = ciYml.indexOf("Check generated artifacts drift");
 const npmCiIndex = ciYml.indexOf("run: npm ci");
 const buildIndex = ciYml.indexOf("run: npm run build");
 assert.ok(guardStepIndex >= 0, "ci.yml 缺少守卫步骤 Check generated artifacts drift");
 assert.ok(
  guardStepIndex > npmCiIndex,
  "守卫步骤必须在 npm ci 之后（check 脚本可能依赖 node_modules）",
 );
 assert.ok(
  guardStepIndex < buildIndex,
  "守卫步骤必须在 Build 之前（build 链会静默再生成清单，mask 已提交漂移）",
 );
});
