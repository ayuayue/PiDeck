import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 模型列表实时性 v2（--list-models 加速 + 缓存刷新策略）：
 * 1) parsePiListModels 解析表格输出（provider/model/thinking）
 * 2) MODEL_LIST_FAST_ARGS 包含加速参数（offline/no-ext/skills/themes）
 * 3) fetchModelList 读缓存、refreshModelList 强制重取
 * 4) 配置保存（models/auth）后触发后台重取
 * 5) 每次 spawn Agent 前刷新缓存（onBeforeAgentSpawn 钩子）
 * 6) setModel needsRestart 重启引导（保留）
 */

const {
  parsePiListModels,
  parseTokenSize,
  modelsFromPiConfig,
  isUnknownCliOption,
  classifyModelListFailure,
  MODEL_LIST_FAST_ARGS,
  MODEL_LIST_EXT_ARGS,
  MODEL_LIST_COMPAT_ARGS,
} = loadTsCommonJs("src/main/pi/modelListCache.ts");
const preload = readFileSync("src/preload/index.ts", "utf8");
const cacheSource = readFileSync("src/main/pi/modelListCache.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const indexSource = readFileSync("src/main/index.ts", "utf8");
const pickerHost = readFileSync(
  "src/renderer/src/components/session/ComposerPickerHost.tsx",
  "utf8",
);

test("parsePiListModels parses table with provider/model/thinking", () => {
  const stdout = [
    "provider  model  context  max-out  thinking  images",
    "openai    gpt-5   200K     64K      yes       yes",
    "deepseek  v4-flash 1M     384K      yes       no",
  ].join("\n");
  const models = parsePiListModels(stdout);
  assert.equal(models.length, 2);
  assert.equal(models[0].provider, "openai");
  assert.equal(models[0].id, "gpt-5");
  assert.equal(models[0].reasoning, true);
  assert.equal(models[1].provider, "deepseek");
  assert.equal(models[1].reasoning, true);
});

test("parsePiListModels keeps provider names containing spaces (regression: grok.weishiair.de copy)", () => {
  // 用户复制 provider 时把名字存成 "grok.weishiair.de copy"（含空格）。旧实现按空格
  // 切分前两列 → provider="grok.weishiair.de"、id="copy"（假模型，真模型 grok-4.6 被吞），
  // 点击假模型报错被分类成「会话已不存在」。修复：从右往左取后 4 列，模型 id 之前的
  // 所有 token 拼回 provider 名。
  const stdout = [
    "provider  model  context  max-out  thinking  images",
    "grok.weishiair.de         grok-4.5                  500K     128K     yes       yes",
    "grok.weishiair.de copy    grok-4.6                  500K     128K     yes       yes",
  ].join("\n");
  const models = parsePiListModels(stdout);
  assert.equal(models.length, 2);
  assert.equal(models[0].provider, "grok.weishiair.de");
  assert.equal(models[0].id, "grok-4.5");
  assert.equal(models[1].provider, "grok.weishiair.de copy");
  assert.equal(models[1].id, "grok-4.6");
  assert.equal(models[1].contextWindow, 500 * 1000);
  assert.equal(models[1].maxTokens, 128 * 1000);
  assert.equal(models[1].reasoning, true);
  assert.equal(models[1].images, true);
});

test("parsePiListModels captures context/maxTokens/images columns", () => {
  const stdout = [
    "provider                  model                         context  max-out  thinking  images",
    "商汤                        deepseek-v4-flash             1M       65.5K    yes       no",
    "智谱                        glm-4v-flash                  128K     4.1K     no        yes",
    "https://open.mwy.asia     gpt-5.6-luna                  272K     128K     yes       yes",
  ].join("\n");
  const models = parsePiListModels(stdout);
  assert.equal(models.length, 3);
  // 中文 provider 与 1M context
  assert.equal(models[0].provider, "商汤");
  assert.equal(models[0].id, "deepseek-v4-flash");
  assert.equal(models[0].contextWindow, 1000 * 1000);
  assert.equal(models[0].maxTokens, Math.round(65.5 * 1000));
  assert.equal(models[0].reasoning, true);
  assert.equal(models[0].images, false);
  // 4.1K max-out 与 images=yes
  assert.equal(models[1].provider, "智谱");
  assert.equal(models[1].id, "glm-4v-flash");
  assert.equal(models[1].contextWindow, 128 * 1000);
  assert.equal(models[1].maxTokens, Math.round(4.1 * 1000));
  assert.equal(models[1].images, true);
  assert.equal(models[1].reasoning, false);
  // URL provider（自定义网关）不受影响
  assert.equal(models[2].provider, "https://open.mwy.asia");
  assert.equal(models[2].id, "gpt-5.6-luna");
  assert.equal(models[2].contextWindow, 272 * 1000);
  assert.equal(models[2].images, true);
});

test("parsePiListModels still works when older pi omits the header row", () => {
  const stdout = "openai    gpt-4o   128K     16K      no        yes\n";
  const models = parsePiListModels(stdout);
  assert.equal(models.length, 1);
  assert.equal(models[0].provider, "openai");
  assert.equal(models[0].id, "gpt-4o");
  assert.equal(models[0].images, true);
});

test("parsePiListModels ignores unknown-option banners mixed into stdout", () => {
  const stdout = [
    "error: unknown option '--offline'",
    "provider  model  thinking",
    "openai    gpt-4o  no",
  ].join("\n");
  const models = parsePiListModels(stdout);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "gpt-4o");
});

test("parseTokenSize handles M/K/plain and rejects garbage", () => {
  // pi 的 formatTokenCount 用 1000 进制（"1M"→1000000，"65.5K"→65500），解析必须对齐。
  assert.equal(parseTokenSize("1M"), 1000 * 1000);
  assert.equal(parseTokenSize("65.5K"), Math.round(65.5 * 1000));
  assert.equal(parseTokenSize("200K"), 200 * 1000);
  assert.equal(parseTokenSize("4096"), 4096);
  assert.equal(parseTokenSize(""), undefined);
  assert.equal(parseTokenSize("abc"), undefined);
  assert.equal(parseTokenSize("-"), undefined);
});

test("MODEL_LIST_EXT_ARGS 走带扩展优先（#181），FAST_ARGS 仅作降级", () => {
  // 第一档（带扩展）必须不带 --no-extensions：扩展 registerProvider 贡献的模型
  // 要能进入选择器（与 CLI 一致）；--no-extensions 只保留在降级档 FAST_ARGS。
  assert.ok(MODEL_LIST_EXT_ARGS.includes("--list-models"));
  assert.ok(MODEL_LIST_EXT_ARGS.includes("--offline"));
  assert.ok(!MODEL_LIST_EXT_ARGS.includes("--no-extensions"));
  assert.ok(MODEL_LIST_EXT_ARGS.includes("--no-skills"));
  assert.ok(MODEL_LIST_EXT_ARGS.includes("--no-themes"));
  // 降级档：第一档因坏扩展失败时的无扩展重试集。
  assert.ok(MODEL_LIST_FAST_ARGS.includes("--no-extensions"));
  assert.ok(MODEL_LIST_FAST_ARGS.includes("--no-skills"));
  assert.ok(MODEL_LIST_FAST_ARGS.includes("--no-themes"));
  assert.equal(MODEL_LIST_COMPAT_ARGS.join(","), "--list-models");
});

test("isUnknownCliOption detects older pi flag rejections", () => {
  assert.equal(isUnknownCliOption("error: unknown option '--offline'"), true);
  assert.equal(isUnknownCliOption("Unknown option: --no-themes"), true);
  assert.equal(isUnknownCliOption("pi: command not found"), false);
});

test("modelsFromPiConfig flattens settings-page models.json", () => {
  const models = modelsFromPiConfig({
    providers: {
      deepseek: {
        models: [
          { id: "v4-flash", name: "Flash", reasoning: true, contextWindow: 1_000_000, input: ["text"] },
          { id: "bad" },
        ],
      },
      openai: {
        models: [{ id: "gpt-4o", input: ["text", "image"] }],
      },
    },
  });
  assert.equal(models.length, 3);
  assert.equal(models[0].provider, "deepseek");
  assert.equal(models[0].name, "Flash");
  assert.equal(models[0].reasoning, true);
  assert.equal(models[2].provider, "openai");
  assert.equal(models[2].images, true);
  assert.equal(modelsFromPiConfig({ providers: {} }).length, 0);
});

test("fetchModelList uses cache; refreshModelList forces reload", () => {
  // 缓存命中短路
  assert.match(cacheSource, /if \(cachedListModels\) return Promise\.resolve/);
  // 强制刷新绕过缓存
  assert.match(cacheSource, /export function refreshModelList/);
  // 加速参数传入 execFile
  assert.match(cacheSource, /MODEL_LIST_FAST_ARGS/);
  // 空结果不写缓存（避免永久「没有匹配的模型」）+ 自动重试
  assert.match(cacheSource, /if \(models\.length > 0 && !configInvalidated\) cachedListModels/);
  assert.match(cacheSource, /重试一次|setTimeout\(resolve, 500\)/);
});

test("config save must not let stale in-flight list overwrite new cache", () => {
  // 保存 models.json 时若存在旧的在途 fork（启动预取/此前打开过选择器），
  // 旧结果会覆盖新配置缓存 → 「新模型有时候没有」。修复：
  // 1) invalidate 置 configInvalidated，在途结果不再写缓存
  assert.match(cacheSource, /configInvalidated = true/);
  assert.match(cacheSource, /if \(models\.length > 0 && !configInvalidated\) cachedListModels/);
  // 2) refreshModelList 不直接复用旧在途请求：链式等它结束后重新 fork
  assert.match(cacheSource, /const pending = cachedListModelsPending/);
  assert.match(cacheSource, /pending[\s\S]*?\.catch\(\(\) => undefined\)/);
  assert.match(cacheSource, /configInvalidated = false/);
});

test("config save (models/auth) refreshes capability and CLI fallback caches", () => {
  assert.match(systemIpc, /const refreshPiModelCatalogs = async/);
  assert.match(systemIpc, /modelCapabilityCache\.refresh\(\)/);
  assert.match(systemIpc, /invalidateModelListCache\(\)/);
  assert.match(systemIpc, /refreshModelList\(piLocator, settingsStore, configManager\)/);
  // auth 保存同样触发（auth 决定可用模型过滤）
  assert.match(systemIpc, /configSaveAuth/);
});

test("agent spawn ensures the shared capability snapshot instead of reforking per picker", () => {
  // AgentManager 构造注入 onBeforeAgentSpawn
  assert.match(agentManager, /onBeforeAgentSpawn/);
  // createUnlocked spawn 前调用
  assert.match(agentManager, /this\.onBeforeAgentSpawn\?\.\(\)/);
  // index.ts 装配时只 ensure；旧 Pi 才回退 CLI refresh。
  assert.match(indexSource, /piModelCapabilityCache\?\.ensure\(\)/);
  assert.match(indexSource, /snapshot \? undefined : refreshModelList/);
});

test("startup prefetch hydrates capabilities after WSL configuration", () => {
  assert.match(indexSource, /syncWslConfig\(\)\.then\(async \(\) =>/);
  assert.match(indexSource, /piModelCapabilityCache\?\.watchConfigDirectory\(\)/);
  assert.match(indexSource, /await piModelCapabilityCache\?\.ensure\(\)/);
  assert.doesNotMatch(indexSource, /getCachedModelList\(\)/);
});

test("older pi unknown-option and empty CLI fall back to local models.json", () => {
  assert.match(cacheSource, /MODEL_LIST_COMPAT_ARGS/);
  assert.match(cacheSource, /isUnknownCliOption/);
  assert.match(cacheSource, /loadModelsFromLocalConfig/);
  assert.match(systemIpc, /fetchModelList\(piLocator, settingsStore, configManager\)/);
});

test("AgentManager.setModel detects Model not found with local model present", () => {
  assert.match(agentManager, /model not found/i);
  assert.match(agentManager, /needsRestart = true/);
  assert.match(agentManager, /localModelsContains/);
  assert.match(agentManager, /getModelsConfig\(\)/);
});

test("renderer ComposerPickerHost shows restart confirm on needsRestart", () => {
  assert.match(pickerHost, /needsRestart/);
  assert.match(pickerHost, /ConfirmDialog/);
  // 确认后必须走统一重启入口（restartActiveAgent），才能点亮 SessionView overlay；
  // 禁止选择器自己调 restartRuntime（那条路径不置 restartingAgentId）。
  assert.match(pickerHost, /restartActiveAgent/);
  assert.doesNotMatch(pickerHost, /desktopApi\.sessions\.restartRuntime/);
  // 确认时先写会话记录再重启：setRuntimeModel 失败路径不再写 catalog。
  assert.match(pickerHost, /updateRecord\(sessionId, \{[\s\S]*?model: \{ provider: intent\.provider, modelId: intent\.modelId \}/);
  assert.match(pickerHost, /modelRestartTitle/);
  assert.match(pickerHost, /modelRestartBody/);
});

test("ComposerPickerHost loads models on welcome page (no record)", () => {
  // 欢迎页/未启动 Agent 时 record 为 undefined，模型列表也必须加载：
  // 加载逻辑收敛到 useBackendModelCatalog（listModels 是全量的，不依赖 projectId），
  // enabled 由 pickerNeedsModels 驱动；Pi/DSH 思考选择器都要加载，以便 Pi 欢迎页
  // 读取 startup capability snapshot、DSH 按 reasoningEfforts 过滤。
  const hook = readFileSync(
    "src/renderer/src/hooks/useBackendModelCatalog.ts",
    "utf8",
  );
  assert.match(pickerHost, /const pickerNeedsModels = props\.picker === "model" \|\| props\.picker === "thinking"/);
  assert.match(pickerHost, /useBackendModelCatalog\(\{[\s\S]*?enabled: pickerNeedsModels/);
  // 后端分支收敛在 hook 内：DSH 走 host 目录，pi 走诊断报告通道（含失败原因分类）
  assert.match(hook, /listModelsReport\(options\.projectId, force\)/);
  assert.match(hook, /desktopApi\.sessions\.listDshModels\(\)/);
  assert.match(hook, /options\.backend === "dsh"/);
});

test("welcome page model/thinking selection persists; draft defaults come from pi config auto-fill", () => {
  const picker = readFileSync(
    "src/renderer/src/components/session/ComposerPickerHost.tsx",
    "utf8",
  );
  const actions = readFileSync(
    "src/renderer/src/hooks/useSessionActions.ts",
    "utf8",
  );
  const bootstrap = readFileSync(
    "src/renderer/src/utils/chatSessionBootstrap.ts",
    "utf8",
  );
  // 欢迎页（无 record）选模型：仍持久化到 localStorage（显式选择保留为「偏好」）。
  assert.match(picker, /localStorage\.setItem\(WELCOME_MODEL_KEY/);
  // 用户规则（2026-10）：思考级别一律走默认档位（settings.defaultThinkingLevel），
  // 欢迎页偏好级别不再参与——无 record 时选择器不写偏好、直接关闭。
  assert.doesNotMatch(picker, /setItem\(WELCOME_THINKING_KEY/);
  // createDraft 不再无条件 spread 欢迎页 localStorage 偏好：主进程已按 pi 配置
  // （defaultProvider/defaultModel/defaultThinkingLevel）自动填充默认模型/思考级别。
  assert.doesNotMatch(actions, /readWelcomeModelPreference\(\)|readWelcomeThinkingPreference\(\)/);
  // 共享偏好读取器仅供偏好展示/校验使用，不影响 pi 默认值。
  assert.match(bootstrap, /readWelcomeModelPreference/);
});

test("classifyModelListFailure: pi not installed is the most actionable reason", () => {
  const { reason, detail } = classifyModelListFailure({
    cliError: new Error("spawn pi ENOENT"),
    configDiagnostic: null,
    piInstalled: false,
    version: null,
  });
  assert.equal(reason, "pi-not-found");
  assert.match(detail, /pi/i);
});

test("classifyModelListFailure: malformed models.json reports config-invalid with position", () => {
  const { reason, detail } = classifyModelListFailure({
    cliError: null,
    configDiagnostic: {
      fileName: "models.json",
      message: "Unexpected token }",
      line: 4,
      column: 2,
    },
    piInstalled: true,
    version: "1.2.3",
  });
  assert.equal(reason, "config-invalid");
  assert.match(detail, /models\.json parse failed at line 4:2/);
});

test("classifyModelListFailure: unknown option on --list-models means pi too old", () => {
  const { reason, detail } = classifyModelListFailure({
    cliError: new Error("error: unknown option '--list-models'"),
    configDiagnostic: null,
    piInstalled: true,
    version: "0.5.0",
  });
  assert.equal(reason, "version-too-old");
  assert.match(detail, /pi 0\.5\.0 rejects --list-models/);
});

test("classifyModelListFailure: auth/json keywords in CLI stderr classify as config-invalid", () => {
  const { reason } = classifyModelListFailure({
    cliError: new Error("failed to parse auth.json"),
    configDiagnostic: null,
    piInstalled: true,
    version: "1.2.3",
  });
  assert.equal(reason, "config-invalid");
});

test("classifyModelListFailure: other CLI errors stay cli-failed", () => {
  const { reason } = classifyModelListFailure({
    cliError: new Error("exit code 1"),
    configDiagnostic: null,
    piInstalled: true,
    version: "1.2.3",
  });
  assert.equal(reason, "cli-failed");
});

test("classifyModelListFailure: healthy pi + valid config with no models is empty", () => {
  const { reason, detail } = classifyModelListFailure({
    cliError: null,
    configDiagnostic: null,
    piInstalled: true,
    version: "1.2.3",
  });
  assert.equal(reason, "empty");
  assert.match(detail, /no models/);
});

test("model list report channel: manual refresh reruns list models with failure classification", () => {
  // 主进程：新通道走 resolveModelListReport（force 绕过缓存；空列表分类失败原因）
  assert.match(systemIpc, /projectsListModelsReport/);
  assert.match(systemIpc, /resolveModelListReport\(/);
  assert.match(systemIpc, /Model list report resolved/);
  assert.match(cacheSource, /export async function resolveModelListReport/);
  assert.match(cacheSource, /export function classifyModelListFailure/);
  assert.match(cacheSource, /piLocator\.check\(/);
  // 共享通道集中定义
  assert.match(
    readFileSync("src/shared/ipc.ts", "utf8"),
    /projectsListModelsReport: "projects:list-models-report"/,
  );
  // preload 暴露最小 API（不带业务逻辑）
  assert.match(preload, /listModelsReport: \(projectId\?: string, force\?: boolean\)/);
  // 旧通道（数组）保持不动：其他消费方（vision bridge/git models/代理测试）不受影响
  const plainSection = systemIpc.slice(
    systemIpc.indexOf("projectsListModels,"),
    systemIpc.indexOf("projectsListModelsReport"),
  );
  assert.doesNotMatch(plainSection, /force/);
});

test("save models verification excludes config-fallback (empty name proven via local read)", () => {
	// 保存后验证不能把 config-fallback 当成“pi 已加载模型”：CLI 空时回退本地 models.json
	// 会把空 name 自动补成 `${provider}/${id}`，看似列表非空实则是假绿灯。
	assert.match(systemIpc, /report\.source !== "config-fallback"/);
	assert.match(systemIpc, /modelLoadReason = "config-fallback"/);
	// 归一化侧同步根治：空 name 在写盘前被剥离，不再产出非法 models.json。
	assert.match(
		readFileSync("src/main/config/ConfigManager.ts", "utf8"),
		/normalized\.name\.length === 0/,
	);
});

test("model picker wires manual refresh + failure guide", () => {
  const hook = readFileSync(
    "src/renderer/src/hooks/useBackendModelCatalog.ts",
    "utf8",
  );
  const pickerHost = readFileSync(
    "src/renderer/src/components/session/ComposerPickerHost.tsx",
    "utf8",
  );
  const components = readFileSync(
    "src/renderer/src/components/session/ComposerComponents.tsx",
    "utf8",
  );
  // 数据源切到报告通道；reload(true) = 手动刷新（绕过缓存重新 fork）
  assert.match(hook, /listModelsReport\(options\.projectId, force\)/);
  assert.match(hook, /reload: load/);
  assert.match(hook, /refreshing/);
  // 选择器把报告/刷新状态传给 ModelPicker
  assert.match(pickerHost, /report=\{report\}/);
  assert.match(pickerHost, /refreshing=\{refreshing\}/);
  assert.match(pickerHost, /onRefresh=\{\(\) => reload\(true\)\}/);
  // 标题栏刷新按钮 + 空列表原因引导（版本过低/配置损坏/pi 未安装等）
  assert.match(components, /app\.modelPickerRefresh/);
  assert.match(components, /ModelListStatusGuide/);
  assert.match(components, /app\.modelListFailVersionTooOld/);
  assert.match(components, /app\.modelListFailConfigInvalid/);
  assert.match(components, /app\.modelListFailPiNotFound/);
});
