import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";

const {
  setI18nLocale,
  translateI18nDescriptor,
} = loadTsCommonJs("src/renderer/src/i18n.ts");
const {
  mainProcessT,
  normalizeMainProcessLocale,
} = loadTsCommonJs("src/shared/i18n/mainProcessCopy.ts");

test("main-process copy resolves locale and interpolates stable product text", () => {
  assert.equal(normalizeMainProcessLocale("en-GB"), "en-US");
  assert.equal(normalizeMainProcessLocale("de-DE"), "zh-CN");
  assert.equal(mainProcessT("en-US", "tray.showWindow"), "Show window");
  assert.equal(mainProcessT("en-US", "pet.switch"), "Switch pet");
  assert.equal(
    mainProcessT("en-US", "session.historyTitle", { project: "PiDeck" }),
    "PiDeck history",
  );
  assert.equal(mainProcessT("en-US", "session.imagePlaceholder"), "[Image]");
  assert.equal(
    mainProcessT("zh-CN", "session.importedPreview", { source: "Codex" }),
    "已导入的 Codex 会话",
  );
  assert.equal(
    mainProcessT("en-US", "session.inUseDeleteBlocked", { title: "Review" }),
    'Session "Review" is in use. Close its Agent before deleting it.',
  );
  assert.equal(
    mainProcessT("zh-CN", "wsl.connectionFailed"),
    "无法连接到所选 WSL 发行版和用户，请检查配置后重试。",
  );
  assert.match(
    mainProcessT("en-US", "wsl.piNotInstalled"),
    /@earendil-works\/pi-coding-agent/,
  );
});

test("ConfigManager localizes product errors and does not return unknown provider exceptions", async () => {
  const { ConfigManager } = loadTsCommonJs("src/main/config/ConfigManager.ts", {
    stubs: {
      electron: {
        net: {
          fetch: async () => {
            throw new Error("SECRET_PROVIDER_STACK");
          },
        },
      },
    },
    globals: {
      console: { ...console, error() {}, warn() {} },
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "pideck-main-i18n-"));
  try {
    const manager = new ConfigManager(
      dir,
      (key, params) => mainProcessT("en-US", key, params),
    );
    const invalid = await manager.saveRawConfig("models.json", "{");
    assert.equal(invalid.error, "The JSON is invalid.");
    assert.equal(typeof invalid.debugDetails, "string");

    const provider = await manager.fetchProviderModels(
      "https://provider.example",
      "secret-key",
      "openai-completions",
    );
    assert.equal(
      provider.error,
      "Failed to load the model list. Check the provider configuration and try again.",
    );
    assert.equal("debugDetails" in provider, false);
    assert.doesNotMatch(JSON.stringify(provider), /SECRET_PROVIDER_STACK|secret-key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main-process managers use the injected locale for user-visible validation", async () => {
  const en = (key, params) => mainProcessT("en-US", key, params);
  const electronStub = { shell: { openPath: async () => "" }, app: { getPath: () => tmpdir() } };
  const { SkillManager } = loadTsCommonJs("src/main/skills/SkillManager.ts", {
    stubs: { electron: electronStub },
  });
  const { PromptManager } = loadTsCommonJs("src/main/prompts/PromptManager.ts", {
    stubs: { electron: electronStub },
  });
  const { ProjectResourceManager } = loadTsCommonJs("src/main/projects/ProjectResourceManager.ts");
  const { PiLocator } = loadTsCommonJs("src/main/pi/PiLocator.ts", {
    stubs: { electron: electronStub },
  });
  const { testPiProxy } = loadTsCommonJs("src/main/pi/PiProxyTester.ts");

  await assert.rejects(
    new SkillManager(tmpdir(), en).create({
      name: "",
      description: "description",
      locationId: "pi-global",
    }),
    /skill name is required/i,
  );
  await assert.rejects(
    new PromptManager(tmpdir(), en).create({ name: "", description: "description" }),
    /template name is required/i,
  );
  await assert.rejects(
    new ProjectResourceManager(
      () => ({ id: "project", name: "Project", path: tmpdir(), lastOpenedAt: 1 }),
      en,
    ).createSkill({ projectId: "project", name: "", description: "description" }),
    /lowercase letters, numbers, and hyphens/i,
  );
  assert.equal(
    (await new PiLocator(en).validateCustomPath("")).error,
    "Enter the path to pi.cmd or pi.",
  );
  assert.equal(
    (await testPiProxy({
      piProxyEnabled: false,
      piProxyUrl: "",
      piProxyBypass: "",
    }, undefined, en)).error,
    "The proxy address is empty.",
  );
});

test("structured main-process copy translates parameters and preserves fallback behavior", () => {
  setI18nLocale("en-US");
  assert.equal(
    translateI18nDescriptor({
      i18nKey: "diagnostic.commandFailed",
      debugDetails: "stderr payload",
    }, "fallback"),
    "The command failed.",
  );
  assert.equal(
    translateI18nDescriptor({ i18nKey: "missing.key" }, "fallback"),
    "fallback",
  );

  setI18nLocale("zh-CN");
  assert.equal(
    translateI18nDescriptor({
      i18nKey: "diagnostic.requestFailedAfterRetries",
      i18nParams: { attempt: 2, maxAttempts: 3 },
    }, "fallback"),
    "请求失败。\n\n已自动重试：2/3 次",
  );
});

test("diagnostic renderer localizes copy while keeping raw details separate", () => {
  const diagnosticCard = readFileSync(
    "src/renderer/src/components/session/TimelineEventCards.tsx",
    "utf8",
  );
  assert.match(diagnosticCard, /translateI18nDescriptor\(props\.message\.meta, props\.message\.text\)/);
  assert.match(diagnosticCard, /typeof props\.message\.meta\?\.debugDetails === "string"/);
  assert.match(diagnosticCard, /<StackTrace trace=\{stripAnsi\(debugDetails\)\}/);
});

test("AgentManager user-visible runtime diagnostics carry i18n descriptors", () => {
  const manager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
  for (const key of [
    "diagnostic.historyLoadFailed",
    "diagnostic.compactReconnected",
    "diagnostic.processReconnectFailed",
    "diagnostic.runtimeError",
    "diagnostic.agentStartFailed",
    "diagnostic.extensionsDisabledFallback",
    "diagnostic.agentStopped",
    "diagnostic.promptRejected",
    "diagnostic.promptDeliveryUnknown",
    "diagnostic.commandFailed",
    "diagnostic.commandCancelled",
    "diagnostic.commandDeliveryUnknown",
    "diagnostic.compactDone",
    "diagnostic.extensionError",
    "diagnostic.requestFailed",
    "diagnostic.retryScheduled",
    "diagnostic.retryScheduledAfterDelay",
    "diagnostic.retrySucceeded",
    "diagnostic.retryFailed",
  ]) {
    assert.match(manager, new RegExp(`"${key.replaceAll(".", "\\.")}"`));
  }
  assert.doesNotMatch(manager, /addMessage\([^\n]*"会话压缩完成/);
  assert.doesNotMatch(manager, /addMessage\([^\n]*"Agent 进程意外退出/);
  assert.doesNotMatch(manager, /addMessage\([^\n]*"命令已取消/);
  assert.doesNotMatch(manager, /message\.text = `正在自动重试[^`]*原因：/);
  assert.doesNotMatch(manager, /message\.text = `自动重试失败[^`]*原因：/);
  assert.match(manager, /private addLocalizedMessage\(/);
  assert.match(manager, /this\.translate\("session\.summaryPlaceholder"\)/);
  assert.match(manager, /this\.translate\("session\.imagePlaceholder"\)/);
  assert.match(manager, /this\.translate\("session\.historyTitle"/);
  assert.doesNotMatch(manager, /summary:\s*[^\n]*\|\| "\[摘要\]"/);
  assert.doesNotMatch(manager, /trimmed \|\| "\[图片\]"/);
});

test("Session command failures map stable codes to localized renderer keys", () => {
  const source = readFileSync("src/renderer/src/utils/sessionCommands.ts", "utf8");
  const expected = {
    SESSION_NOT_FOUND: "sessionCommand.sessionNotFound",
    SESSION_RUNTIME_UNAVAILABLE: "sessionCommand.runtimeUnavailable",
    SESSION_RUNTIME_CHANGED: "sessionCommand.runtimeChanged",
    SESSION_RUNTIME_BUSY: "sessionCommand.runtimeBusy",
    SESSION_COMMAND_FAILED: "sessionCommand.commandFailed",
  };
  for (const [code, key] of Object.entries(expected)) {
    assert.match(source, new RegExp(`${code}: "${key.replaceAll(".", "\\.")}"`));
  }
  assert.match(source, /this\.debugDetails = error\.debugDetails/);
  assert.doesNotMatch(source, /super\(error\.debugDetails \|\| error\.code\)/);
  assert.match(source, /export function sessionCommandFailureToast/);
});

test("delete/edit/resend IPC logs SessionCommandResult failures", () => {
  const source = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
  // 这些通道直接返回 SessionCommandResult，不走 sessionCommandIpcError 抛错。
  assert.match(source, /function logSessionCommandFailure/);
  assert.match(source, /function handleSessionCommandResult/);
  assert.match(source, /sessionsRuntimeDeleteMessage/);
  assert.match(source, /sessionsRuntimeEditMessage/);
  assert.match(source, /sessionsRuntimePrepareResend/);
  assert.match(source, /deleteRuntimeMessage/);
  assert.match(source, /handleSessionCommandResult\(\s*appLogger,\s*"deleteRuntimeMessage"/);
  assert.match(source, /handleSessionCommandResult\(\s*appLogger,\s*"editRuntimeMessage"/);
  assert.match(source, /handleSessionCommandResult\(\s*appLogger,\s*"prepareRuntimeResend"/);
});

test("main-process Session IPC errors expose stable copy and retain diagnostics separately", () => {
  const { SessionCommandIpcError } = loadTsCommonJs(
    "src/main/sessions/SessionCommandIpcError.ts",
  );
  const error = new SessionCommandIpcError({
    code: "SESSION_RUNTIME_CHANGED",
    debugDetails: "SECRET_RUNTIME_BINDING",
  }, (key, params) => mainProcessT("en-US", key, params));

  assert.equal(error.message, "The session runtime changed. Retry the operation.");
  assert.equal(error.code, "SESSION_RUNTIME_CHANGED");
  assert.equal(error.debugDetails, "SECRET_RUNTIME_BINDING");
  assert.doesNotMatch(error.message, /SECRET_RUNTIME_BINDING/);
});

test("main-process user surfaces use stable copy and keep caught details in logs", () => {
  const source = mainIpcSource;
  for (const key of [
    "tray.showWindow",
    "tray.restart",
    "tray.quit",
    "dialog.chooseChatHistoryFolder",
    "dialog.chooseProjectFolder",
    // 应用更新由 UpdateService 将底层错误映射为状态快照，设置页用 renderer copy 呈现。
    "wsl.windowsOnly",
    "wsl.piNotInstalled",
    "wsl.connectionFailed",
    "session.stopBeforeDelete",
    "store.promptSearchFailed",
    "store.promptDetailFailed",
    "store.promptImportFailed",
    "store.skillSearchFailed",
    "store.skillImportFailed",
    // 注：store.skillsShInstallFailed 已不再被引用——安装失败改为返回真实错误（npx 输出/网络/权限），
    // 渲染层 toast 直接展示，不用通用文案；key 定义保留在 mainProcessCopy.ts 以兼容旧调用
    "store.yaoListFailed",
    "store.yaoDetailFailed",
    "store.yaoImportFailed",
  ]) {
    assert.match(source, new RegExp(`mainCopy\\("${key.replaceAll(".", "\\.")}"`));
  }
  assert.doesNotMatch(source, /label:\s*"(?:显示窗口|退出 PiDeck)"/);
  assert.doesNotMatch(source, /title:\s*"选择聊天记录目录"/);
  assert.doesNotMatch(source, /error:\s*`无法连接到 WSL[^`]*\$\{err/);
  assert.doesNotMatch(source, /throw new Error\(`(?:搜索|获取|导入|读取)[^`]*\$\{message\}`\)/);
  assert.doesNotMatch(source, /state:\s*"failed",\s*error:\s*error\.message/);
  assert.match(source, /appLogger\.warn\("wsl", "WSL connection validation failed"/);
  assert.match(source, /appLogger\.warn\("skill-hub", "Install failed"/);
  assert.match(source, /"webService\.invalidPort"/);
  assert.match(source, /"webService\.startFailed"/);
  assert.match(source, /throw sessionCommandIpcError\(/);
  assert.doesNotMatch(source, /throw new Error\([^\n]*debugDetails \|\|[^\n]*code/);

  // electron-updater 的失败不通过旧的 mainCopy/URL 下载链路泄露到 IPC；
  // UpdateService 推送 error 快照，设置页使用受控本地化文案并保留 Release 兜底入口。
  const updateService = readFileSync("src/main/update/UpdateService.ts", "utf8");
  const appUpdateCard = readFileSync(
    "src/renderer/src/components/app/settings/AppUpdateCard.tsx",
    "utf8",
  );
  assert.match(updateService, /private setDownloadError/);
  assert.match(updateService, /this\.download = \{ \.\.\.this\.download, phase: "error", error \}/);
  assert.match(updateService, /"App update check failed"/);
  assert.match(appUpdateCard, /t\("settings\.updateErrorDetail"/);
  assert.match(appUpdateCard, /desktopApi\.app\.openExternal\(releaseUrl, true\)/);

  const projectStore = readFileSync("src/main/projects/ProjectStore.ts", "utf8");
  assert.match(projectStore, /title: this\.chooseProjectTitle\(\)/);
  assert.doesNotMatch(projectStore, /title:\s*"选择项目目录"/);

  const petSystem = readFileSync("src/main/pet/index.ts", "utf8");
  const petBridge = readFileSync("src/main/pet/PetStateBridge.ts", "utf8");
  assert.doesNotMatch(petSystem, /text:\s*"(?:Agent 出错了|任务完成，记得 Review)"/);
  assert.doesNotMatch(petSystem, /label:\s*"(?:切换宠物|关闭宠物)"/);
  assert.doesNotMatch(petBridge, /text:\s*`?\$\{errored\.title\} 出错了/);

  const feishuConfig = readFileSync("src/main/feishu/FeishuConfig.ts", "utf8");
  assert.match(feishuConfig, /name: parsed\.name \|\| defaultBotName/);
  assert.doesNotMatch(feishuConfig, /parsed\.name \|\| "默认机器人"/);
});
