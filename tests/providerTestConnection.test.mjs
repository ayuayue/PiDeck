/**
 * 测试连接统一接线测试（config:test-provider = 隔离探针）。
 *
 * 背景：卡片（展开内联）与添加/编辑供应商页的测试连接统一为「临时 agent 目录 +
 * PI_CODING_AGENT_DIR 跑真实 pi」，测的是当前表单值（含未保存修改），正式配置零接触。
 * 测试 ≠ 保存：成功后不再清脏/回读，用户仍需显式点保存按钮。
 *
 * 断言：
 *  1. 契约层只有一条通道 config:test-provider（旧 test-provider-draft 已删除）；
 *  2. 主进程 handler：临时目录 + buildProbeDraftFiles + PROBE_AGENT_DIR_ENV + finally 清理，
 *     且不再调用 saveModelsConfig（不落盘）；
 *  3. preload 暴露统一 testProvider(providerName, modelId, provider, apiKey, proxyMode)；
 *  4. PiModelProber 支持 envOverrides 透传（降级链两处调用都带）；
 *  5. 渲染层两处入口都走统一通道；卡片测试成功不再隐式保存。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ipcSource = readFileSync("src/shared/ipc.ts", "utf8");
const systemIpcSource = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const preloadSource = readFileSync("src/preload/index.ts", "utf8");
const configModalSource = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
const dialogSource = readFileSync("src/renderer/src/config/AddProviderDialog.tsx", "utf8");
const proberSource = readFileSync("src/main/pi/PiModelProber.ts", "utf8");
const draftConfigSource = readFileSync("src/main/pi/probeDraftConfig.ts", "utf8");

test("契约层只有一条测试通道（旧草稿通道已删除）", () => {
  assert.match(ipcSource, /configTestProvider: "config:test-provider",/);
  assert.doesNotMatch(ipcSource, /configTestProviderDraft|test-provider-draft/);
});

test("主进程 handler：临时 agent 目录 + PI_CODING_AGENT_DIR + finally 清理，不落盘", () => {
  const start = systemIpcSource.indexOf("ipcChannels.configTestProvider,");
  assert.ok(start > -1, "config:test-provider handler must exist");
  const body = systemIpcSource.slice(start, start + 4200);
  // 临时目录：mkdtemp 生成、写完即用、finally 递归删除（待测密钥不留在磁盘）
  assert.match(body, /mkdtemp\(join\(tmpdir\(\), "pideck-probe-"\)\)/);
  assert.match(body, /await rm\(tempDir, \{ recursive: true, force: true \}\)/);
  assert.match(body, /\{ \[PROBE_AGENT_DIR_ENV\]: agentDirEnv \}/);
  // 文件构建收敛在 probeDraftConfig（纯函数可单测）
  assert.match(body, /buildProbeDraftFiles\(/);
  assert.match(draftConfigSource, /export const PROBE_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";/);
  // 正式 settings.json 副本进临时目录（扩展注册的 api 协议靠它加载）
  assert.match(body, /getSettingsConfig\(\)/);
  assert.match(body, /settingsConfig\.parsed/);
  // 统一后不得再「测试即保存」：handler 内不出现 saveModelsConfig
  assert.doesNotMatch(body, /saveModelsConfig/, "统一隔离探针不得落盘正式配置");
});

test("preload 暴露统一 testProvider 签名（provider + apiKey），无 testProviderDraft", () => {
  assert.match(preloadSource, /testProvider: \(/);
  assert.match(preloadSource, /provider: unknown,\s*\n\s*apiKey: string,/);
  assert.match(preloadSource, /ipcChannels\.configTestProvider/);
  assert.doesNotMatch(preloadSource, /testProviderDraft|configTestProviderDraft/);
});

test("PiModelProber 支持 envOverrides 覆盖子进程环境", () => {
  assert.match(proberSource, /envOverrides\?: NodeJS\.ProcessEnv,/);
  assert.match(proberSource, /\.\.\.\(envOverrides \?\? \{\}\),/);
  // 两处探针调用（全集/最小集与无扩展降级）都要带上覆盖，避免降级后读到正式配置
  const calls = proberSource.match(/runProbeOnce\(piLocator, probeSettings, invocation, envOverrides\)/g) ?? [];
  assert.equal(calls.length, 2, `expected 2 probe calls with envOverrides, got ${calls.length}`);
});

test("两处入口都走统一通道；卡片测试成功不再隐式保存", () => {
  // 添加/编辑供应商页
  assert.match(dialogSource, /desktopApi\.config\.testProvider\(/);
  assert.doesNotMatch(dialogSource, /testProviderDraft/);
  // 展开卡片（ConfigModal.handleTestProvider）
  const start = configModalSource.indexOf("const handleTestProvider");
  assert.ok(start > -1, "ConfigModal.handleTestProvider must exist");
  const rest = configModalSource.slice(start);
  const nextConst = rest.indexOf("\n\tconst ");
  const body = nextConst > 0 ? rest.slice(0, nextConst) : rest.slice(0, 2400);
  assert.match(body, /api\.config\.testProvider\(/);
  // 测试 ≠ 保存：不再清脏标记、不再回读磁盘
  assert.doesNotMatch(body, /clearDirty\("config:models"\)/);
  assert.doesNotMatch(body, /loadConfig\("models"/);
  // 校验前置：缺 baseUrl/apiKey 或模型 ID 时直接给出可读错误，不发探针
  assert.match(body, /t\("config\.missingBaseUrlApiKey"\)/);
  assert.match(body, /t\("config\.missingTestModel"\)/);
});