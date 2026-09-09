import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

// 用户反馈 bug：点击系统通知能激活窗口，但不会跳转到对应会话。
// 根因：notifySessionEnd 用 tab.sessionId（pi 侧会话 id）嵌入 toast launch，
// renderer 的 sessionRecordByIdAtomFamily 只按 SessionRecord.id 索引，两套 id
// 不一致（见 index.ts attachRuntime 的 sessionId/piSessionId 双字段），
// 导致通知点击后 record 解析永远失败，仅完成窗口激活。
// 修复：通知跳转目标统一用 record.id（coordinator 绑定维护），piSessionId 仅兜底。

const RECORD_ID = "11111111-2222-3333-4444-555555555555";
const PI_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("resolveNotificationSessionId prefers record id over pi session id", () => {
  // 原生 ESM import 解析不了无扩展名的 TS 包内路径；用 ts.transpileModule 编译后注入
  const agentUtilsModule = { exports: {} };
  const ts = nodeRequire("typescript");
  vm.runInNewContext(
    ts.transpileModule(
      readFileSync("src/main/pi/agentUtils.ts", "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    {
      module: agentUtilsModule,
      exports: agentUtilsModule.exports,
      // agentUtils 顶层依赖 src/shared/sessionIdentity（bundler 根导入）：
      // 本测试只调 resolveNotificationSessionId，会话身份工具用不到，空导出即可
      require: (id) => {
        if (id === "../../shared/sessionIdentity" || id === "src/shared/sessionIdentity") {
          // looksLikePiSessionFileStem 顶层引用：resolveNotificationSessionId 用不到，空导出
          return { looksLikePiSessionFileStem: () => false };
        }
        return nodeRequire(id);
      },
    },
    { filename: "agentUtils.ts" },
  );
  const { resolveNotificationSessionId } = agentUtilsModule.exports;
  // record.id 解析成功：用 record.id（renderer 能索引到会话）
  assert.equal(
    resolveNotificationSessionId(() => RECORD_ID, PI_SESSION_ID),
    RECORD_ID,
  );
  // coordinator 未绑定（resolver 返回 undefined）：兜底 pi session id（旧 toast 格式）
  assert.equal(
    resolveNotificationSessionId(() => undefined, PI_SESSION_ID),
    PI_SESSION_ID,
  );
  // 无 resolver（AgentManager 未注入）：直接用 pi session id
  assert.equal(resolveNotificationSessionId(undefined, PI_SESSION_ID), PI_SESSION_ID);
  // 两者皆缺：undefined（通知只聚焦窗口，不跳转）
  assert.equal(resolveNotificationSessionId(undefined, undefined), undefined);
});

// 契约断言：notifySessionEnd 必须走 resolveNotificationSessionId（不再直接取 tab.sessionId）
test("AgentManager notification target uses record id resolver", () => {
  const source = readFileSync(
    "src/main/pi/AgentManager.ts",
    "utf8",
  );
  assert.match(source, /resolveNotificationSessionId\(\s*resolveSessionId \? \(\) => resolveSessionId\(agentId\) : undefined,/);
});

// 冷启动时序：加载期目标必须进 pending 队列，且 renderer 挂载后主动拉取
test("cold start focus target goes through pending queue", () => {
  const indexSource = readFileSync("src/main/index.ts", "utf8");
  // 焦点目标为 FocusTargetPayload 联合（sessionId/projectId/projectPath 三形态）
  assert.match(indexSource, /function queueFocusTarget\(target: \{ sessionId: string \} \| \{ projectId: string \} \| \{ projectPath: string \}\)/);
  assert.match(indexSource, /pendingFocusTarget = target;/);
  assert.match(indexSource, /flushPendingFocusTargetOnLoad\(\);/);
  // 拉取通道必须注册（renderer 挂载后取走即清空）
  assert.match(indexSource, /ipcMain\.handle\(ipcChannels\.petGetFocusTargetPending/);

  const rendererSource = readFileSync(
    "src/renderer/src/hooks/useSessionWorkspaceChrome.ts",
    "utf8",
  );
  assert.match(rendererSource, /getPendingFocusTarget\?\.\(\)\.then/);
  // 拉取与事件推送共用同一解析/重试逻辑（修复后不能出现两份 tryFocus）
  assert.equal(
    (rendererSource.match(/const tryFocus = \(attempt: number\) =>/g) ?? []).length,
    1,
  );
});
