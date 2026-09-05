/**
 * 用量查询配置管理 IPC 契约：配置入口在「模型/认证页」的用量查询弹窗，
 * 渲染层经三条通道读写/测试 usage-probes.json，必须三处同步
 * （通道 / 主进程 handler / preload），previewApi 同步提供 stub。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const previewApi = readFileSync("src/renderer/src/previewApi.ts", "utf8");
const sharedTypes = readFileSync("src/shared/types/providerUsage.ts", "utf8");
const userUsageProbes = readFileSync("src/main/config/userUsageProbes.ts", "utf8");
const configManager = readFileSync("src/main/config/ConfigManager.ts", "utf8");

test("三条探针管理通道集中定义在 shared/ipc.ts", () => {
  assert.match(ipc, /configGetUsageProbes: "config:get-usage-probes"/);
  assert.match(ipc, /configSaveUsageProbes: "config:save-usage-probes"/);
  assert.match(ipc, /configTestUsageProbe: "config:test-usage-probe"/);
  // 轻量内置识别通道（渲染层隐藏「用量查询」按钮用）。
  assert.match(ipc, /configUsageRecognized: "config:usage-recognized"/);
});

test("主进程三个 handler 都注册且先校验后动作", () => {
  for (const channel of [
    "configGetUsageProbes",
    "configSaveUsageProbes",
    "configTestUsageProbe",
    "configUsageRecognized",
  ]) {
    assert.match(systemIpc, new RegExp(`ipcChannels\\.${channel}`));
  }
  // 读取：按 provider 名请求（弹窗作用域），走 ConfigManager 的 per-provider 设置读取。
  const getHandler = systemIpc.match(
    /ipcMain\.handle\(ipcChannels\.configGetUsageProbes,[\s\S]*?\n\t\}\);/,
  )?.[0] ?? "";
  assert.match(getHandler, /getUsageProbeSettings/);
  // 保存：入口 provider 校验 + 主进程校验后按 provider 合并落盘（保留其它条目）。
  const saveHandler = systemIpc.match(
    /ipcMain\.handle\(ipcChannels\.configSaveUsageProbes,[\s\S]*?\n\t\}\);/,
  )?.[0] ?? "";
  assert.match(saveHandler, /saveUsageProbeForProvider/);
  assert.match(saveHandler, /Invalid provider name/);
  // 测试：模板 id 白名单校验（声明式 + 内置），复用 provider 端点解析。
  const testHandler = systemIpc.match(
    /ipcMain\.handle\(ipcChannels\.configTestUsageProbe,[\s\S]*?\n\t\}\);/,
  )?.[0] ?? "";
  assert.match(testHandler, /configManager\.testUsageProbe/);
  assert.match(testHandler, /Unknown template/);
});

test("主进程写入路径固定在 configDir（禁止拼接渲染层传入路径）", () => {
  // 保存以 configManager.getUsageProbeConfigDir(backend) 为根（pi=~/.pi/agent，dsh=$DSH_HOME），
  // 不接受渲染层传目录。
  assert.match(systemIpc, /saveUsageProbeForProvider\(\s*configManager\.getUsageProbeConfigDir\(backend\)/);
  assert.match(systemIpc, /getUsageProbeConfigDir\(backend\)/);
  // 探针载荷（apiKey/accessToken 等）绝不整体落日志：
  // 日志字段只允许 provider/template/success 这类非敏感摘要。
  const saveHandler = systemIpc.match(
    /ipcMain\.handle\(ipcChannels\.configSaveUsageProbes,[\s\S]*?\n\t\}\);/,
  )?.[0] ?? "";
  assert.doesNotMatch(saveHandler, /apiKey\s*:/);
  assert.doesNotMatch(saveHandler, /accessToken\s*:/);
  assert.doesNotMatch(saveHandler, /userId\s*:/);
});

test("shared 契约：per-provider 配置类型 + 识别结果类型齐全", () => {
  assert.match(sharedTypes, /UsageProbeProviderConfig/);
  assert.match(sharedTypes, /UsageProbeRecognition/);
  assert.match(sharedTypes, /UsageProbeSettingsResult/);
  assert.match(sharedTypes, /UsageProbeSaveInput/);
  assert.match(sharedTypes, /UsageProbeTestInput/);
  // 安全边界：声明式模板不含任意代码执行面（无脚本/函数字段）。
  assert.doesNotMatch(sharedTypes, /extractor/);
  assert.doesNotMatch(sharedTypes, /code\s*:/);
  // providers 映射保存保留旧 probes 数组（AI 直接写的能力不丢）。
  assert.match(userUsageProbes, /existing\.probes/);
});

test("preload 暴露与 previewApi stub 三处同步", () => {
  assert.match(preload, /getUsageProbes: \(provider: string, backend\?/);
  assert.match(preload, /fetchUsage: \(provider: string, backend\?/);
  assert.match(preload, /saveUsageProbes: \(payload: UsageProbeSaveInput\)/);
  assert.match(preload, /testUsageProbe: \(payload: UsageProbeTestInput\)/);
  assert.match(preload, /usageRecognized: \(provider: string, backend\?/);
  assert.match(previewApi, /getUsageProbes: async \(\) => \(\{ recognized: null/);
  assert.match(previewApi, /saveUsageProbes: async \(\) => \(\{ ok: false/);
  assert.match(previewApi, /testUsageProbe: async \(\) => \(\{ success: false/);
  assert.match(previewApi, /usageRecognized: async \(\) => \(\{ recognized: false/);
});

test("backend 维度贯通：DSH 链路 = $DSH_HOME/.pideck 配置 + DSH 凭据库", () => {
  const configManager = readFileSync("src/main/config/ConfigManager.ts", "utf8");
  // 配置目录按 backend 分流（pi=configDir；dsh=$DSH_HOME/.pideck —— PiDeck 特有文件统一收拢目录）。
  assert.match(configManager, /usageProbeSettingsDir\(backend: UsageProbeBackend\)/);
  assert.match(configManager, /pideckUsageProbesDir\(dshHome\)/);
  // DSH 凭据：models/auth 无 key 时回退 DSH 凭据库（credentialRefFor 常规 <ROUTE>_API_KEY）。
  assert.match(configManager, /readCredential\(credentialRefFor\(\{\}, provider\)\)/);
  // DSH 端点以 DSH 自身 profile（settings.yaml）为准：baseURL/api/headers 可能被自定义
  // route 改写，只靠 pi/catalog 兜底会「时而查得对、时而判不支持」；凭据 ref 由 profile 给出。
  assert.match(configManager, /loadDshUsageProviderProfile/);
  assert.match(configManager, /profile\.credentialRef/);
  // DSH 未单独配置时回退 Pi 侧同 provider 配置（display parity）：Pi 已配置并显示 →
  // DSH 卡片默认也显示；DSH 一旦显式保存（含 enabled=false）即接管不回退。
  assert.match(configManager, /loadUsageSettingsWithFallback/);
  assert.match(configManager, /effectiveDir/);
  assert.match(configManager, /backend !== "dsh" \|\| settings\.config/);
  // 装配层（index.ts）注入：DSH_HOME 与 DshHost 同一解析 + .credentials.yaml 环境层优先。
  const mainIndex = readFileSync("src/main/index.ts", "utf8");
  assert.match(mainIndex, /new ConfigManager\(undefined, mainCopy, \{/);
  assert.match(mainIndex, /resolveDshHomeDir\(settingsStore\.get\(\)\.dshHomeDir/);
  assert.match(mainIndex, /\.credentials\.yaml/);
  // 渲染层：DSH 卡片用量行走 dsh backend；缓存 key 带 dsh: 前缀防与 pi 同名 provider 串号。
  const dshCards = readFileSync("src/renderer/src/config/DshProviderCards.tsx", "utf8");
  assert.match(dshCards, /backend="dsh"/);
  const inlineSource = readFileSync("src/renderer/src/components/app/ProviderUsageInline.tsx", "utf8");
  assert.match(inlineSource, /useProviderUsageEntry\(props\.provider, props\.backend\)/);
  // 缓存 key 只在渲染层 atom 内使用；**发送给主进程的必须是原始 provider 名**——
  // 曾把 `dsh:deepseek` 整体当 provider 寄回主进程，DSH 卡片永远解析不出、用量为空。
  const usageHook = readFileSync("src/renderer/src/hooks/useProviderUsage.ts", "utf8");
  assert.match(usageHook, /export function usageCacheKey/);
  assert.match(usageHook, /dsh:\$\{normalizeDshDeepseekProvider\(provider\)\}/);
  assert.match(usageHook, /fetchUsage\(provider, backend\)/);
  assert.doesNotMatch(usageHook, /fetchUsage\(cacheKey/);
  assert.doesNotMatch(usageHook, /fetchUsage\(key/);
  // DSH 官方 DeepSeek 名归一：llm.models 组 id（deepseek-official）与配置面规范名
  // （deepseek）不一致——主进程入口与端点解析先归一，模型选择器/圆球（provider=
  // deepseek-official）才能命中 llm-deepseek 命名空间并读回 DSH 卡片保存的探针配置。
  assert.match(configManager, /normalizeDshDeepseekProvider/);
  const dshEndpoint = readFileSync("src/main/config/dshUsageEndpoint.ts", "utf8");
  assert.match(dshEndpoint, /normalizeDshDeepseekProvider/);
  const usageCacheKeySource = usageHook.match(
    /export function usageCacheKey\([\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(usageCacheKeySource, /normalizeDshDeepseekProvider\(provider\)/);
  // shared 契约带 backend 类型。
  assert.match(sharedTypes, /UsageProbeBackend/);
});

test("shared 契约包含旧探针配置类型（AI 直接写的 probes 数组兼容读取）", () => {
  assert.match(sharedTypes, /export type UsageProbeConfig = \{/);
  assert.match(sharedTypes, /export type UsageProbeParseConfig/);
});

test('用户探针明确拒绝 kind:"custom"（专用解析器仅限内置）', () => {
  assert.match(userUsageProbes, /probe\.parse\.kind === "custom"/);
  assert.match(userUsageProbes, /仅限内置，不支持用户配置/);
});

test("ConfigManager 用量查询按 provider 名路由：门控 + 识别 + 测试共用探测层", () => {
  // 统一入口签名（per-provider 路由取代「调用方先解析端点」；backend 分流 pi/dsh 链路）。
  assert.match(configManager, /async fetchProviderUsage\(provider: string, backend: UsageProbeBackend = "pi"\)/);
  assert.match(configManager, /async getUsageProbeSettings\(\s*provider: string,\s*backend: UsageProbeBackend/);
  assert.match(configManager, /async recognizeUsageTemplate\(\s*provider: string,\s*backend: UsageProbeBackend/);
  assert.match(configManager, /async testUsageProbe\(/);
  // 门控：用户显式关闭（enabled=false）快速返回。
  assert.match(configManager, /enabled === false/);
  // 声明式模板构建（general/newapi）在主进程，渲染层不可见密钥。
  assert.match(configManager, /buildDeclarativeUsageProbeTemplate/);
  // 三入口都经由 runUsageProbes（preflight/截断/redirect fail-closed 行为一致）。
  assert.match(configManager, /private async runUsageProbes\(/);
  assert.match(configManager, /await this\.runUsageProbes\(/);
});
