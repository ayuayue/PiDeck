/**
 * pi 配置读写 IPC 域（自 systemIpc.ts 拆出：handler 体、通道、日志与文案逐字未改）。
 * 通道：config:get-models / config:get-raw / config:preview-provider-migration /
 * config:apply-provider-migration / config:get-auth / config:get-settings / config:get-trust /
 * config:get-dir / config:save-models / config:save-auth / config:save-settings / config:save-raw /
 * config:export / config:import / config:discover-external-agents / config:resolve-external-agent-key。
 */
import { app, ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { ModelsVerifyResult } from "../../shared/types";
import { PI_CONFIG_FILE_NAMES, piConfigFileKeyFromName } from "../../shared/piConfig";
import type { ProviderMigrationDirection } from "../../shared/types/providerMigration";
import type { ConfigManager } from "../config/ConfigManager";
import type { RemotePiConfigBackend } from "../config/RemotePiConfigBackend";
import { createPiConfigRouter, type PiConfigRawReadRoute, type PiConfigReadRoute, type PiConfigWriteRoute } from "../config/PiConfigRouter";
import { createWslPiConfigStoreFor } from "../config/WslPiConfigStore";
import { mcpDocsUrl } from "../config/mcpConfig";
import { applyProviderMigration, previewProviderMigration, type ProviderMigrationDeps } from "../config/providerMigrationService";
import { discoverExternalAgentProviders, resolveExternalAgentKey } from "../config/externalAgentDiscovery";
import { invalidateModelListCache, modelsFromPiConfig, resolveModelListReport } from "../pi/modelListCache";
import { resolveSettingsWslIdentity } from "../wsl/WslProjectEnvironment";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";
import type { PiLocator } from "../pi/PiLocator";
import type { PiModelCapabilityCache } from "../pi/PiModelCapabilityCache";

export type SystemConfigIpcDeps = {
	settingsStore: SettingsStore;
	configManager: ConfigManager;
	/** Phase 5 remote config scope (Batch A): absent when the remote experiment switch is off => ssh targets fail closed. */
	remotePiConfig?: RemotePiConfigBackend;
	/** 单供应商 pi↔DSH 互迁（不为此拉起 host）。 */
	providerMigration?: ProviderMigrationDeps;
	modelCapabilityCache: PiModelCapabilityCache;
	piLocator: PiLocator;
	appLogger: AppLogger;
	getMainWindow: () => Electron.BrowserWindow | null;
	/** 模型目录缓存失效重建（systemIpc 内的同一份闭包，不复制第二份定义）。 */
	refreshPiModelCatalogs: () => Promise<void>;
	/** 同一份远端目录缓存的失效入口（远端 models.json 改写后必须显式失效）。 */
	remoteModelCatalog?: { invalidate: (hostId: string) => void };
};

export function registerSystemConfigIpc(deps: SystemConfigIpcDeps): void {
	const { settingsStore, configManager, remotePiConfig, providerMigration, modelCapabilityCache, piLocator, appLogger, getMainWindow, refreshPiModelCatalogs, remoteModelCatalog } = deps;

	/**
	 * Phase 5 remote config routing (Batch A) + WS2 wsl target: local keeps ConfigManager; ssh goes only to the
	 * injected RemotePiConfigBackend; wsl goes only to WslPiConfigStore, which re-resolves the profile's
	 * distribution HOME on every call (never configureWsl, so two targets cannot pollute each other's configDir).
	 * Provider test/fetch/usage stay local-only and refuse any non-local target before any request.
	 */
	/** ConfigFileReadResult → 源文件页要的形状（raw + 可选诊断）。 */
	const pickRaw = <T>(result: { raw: string; diagnostic?: import("../../shared/types").ConfigFileDiagnostic }): { raw: string; diagnostic?: import("../../shared/types").ConfigFileDiagnostic } => ({ raw: result.raw, diagnostic: result.diagnostic });
	const piConfigRouter = createPiConfigRouter({
		local: {
			getModelsConfig: () => configManager.getModelsConfig(),
			getSettingsConfig: () => configManager.getSettingsConfig(),
			saveModelsConfig: (data) => configManager.saveModelsConfig(data),
			saveSettingsConfig: (settings) => configManager.saveSettingsConfig(settings),
			/** 源文件页的统一读取：models/settings/auth/trust 走各自的 ConfigManager 读取器，mcp 取可写层原文。 */
			getRawConfig: async (file) => {
				if (file === "models") return pickRaw(await configManager.getModelsConfig());
				if (file === "settings") return pickRaw(await configManager.getSettingsConfig());
				if (file === "auth") return pickRaw(await configManager.getAuthConfig());
				if (file === "trust") return pickRaw(await configManager.getTrustConfig());
				const snapshot = await configManager.getMcpConfig();
				return { raw: snapshot.writableRaw, diagnostic: snapshot.writableError ? { fileName: "mcp.json", message: snapshot.writableError, docsUrl: mcpDocsUrl() } : undefined };
			},
			saveRawConfig: (file, raw) => configManager.saveRawConfig(PI_CONFIG_FILE_NAMES[file], raw),
		},
		remote: remotePiConfig,
		wsl: createWslPiConfigStoreFor(app.getPath("userData"), {
			warn: (message, details) => void appLogger.warn("wsl", message, details),
			readWslIdentity: async () => resolveSettingsWslIdentity(settingsStore.get()),
		}),
	});
	// 非本机目标的回程 DTO：local 原样返回；wsl 带发行版/用户来源，ssh 带脱敏快照（不含明文密钥）。
	const configReadDto = (routed: PiConfigReadRoute<unknown>) => (routed.kind === "local" ? routed.value : routed.kind === "wsl" ? { raw: routed.raw, parsed: routed.data, wsl: routed } : { raw: JSON.stringify(routed.data, null, 2), parsed: routed.data, remote: routed });
	/** 源文件级读取的回程：本机/wsl 直接给原文（+ 诊断），ssh 给脱敏快照；auth.json 的 ssh 分支只有派生视图（无 raw）。 */
	const configRawReadDto = (routed: PiConfigRawReadRoute) => {
		if (routed.kind === "remote-auth") return { raw: "", remoteAuth: routed };
		if (routed.kind === "remote") return { raw: JSON.stringify(routed.data, null, 2), remote: routed };
		return routed.value;
	};
	/** 非本机写回执：ssh 只带 version，wsl 只带文件名；都只回「写成功」，本机缓存由调用方决定是否失效。 */
	const configWriteDto = (routed: PiConfigWriteRoute, file: string) => {
		if (routed.kind === "local") return routed.value;
		if (routed.kind === "remote") {
			void appLogger.info("config", "Remote config patched", { file, hostId: routed.hostId, version: routed.version });
			return { valid: true, remote: routed };
		}
		void appLogger.info("config", "WSL config written", { file });
		return routed.value.valid ? { valid: true, wsl: routed.value.receipt } : routed.value;
	};

	/**
	 * 保存 models 后的后台完整验证：fork 真实 pi（本机实测 ~17-21s）确认配置能被加载，
	 * 完成后经 config:models-verify-result 推送渲染层——仅失败时提示，成功静默
	 * （保存动作的即时反馈已由 handler 返回，这里补的是「pi 真实可加载」这一层）。
	 * retryOnEmpty:false：刚保存完环境是热的，CLI 空表是真实信号，重试只会多 fork 一次。
	 */
	const verifyModelsAfterSave = async (savedAt: number): Promise<void> => {
		let payload: ModelsVerifyResult;
		try {
			const report = await resolveModelListReport(piLocator, settingsStore, configManager, true, { retryOnEmpty: false });
			// 只有 pi 自己成功列出非空模型列表才算「已加载」。source 为 config-fallback
			// 说明 pi 实际没能列出模型（CLI 空 → 回退读本地 models.json 兑底，且兑底会把空
			// name 自动补成 ${provider}/${id}），此时报“已加载”是假绿灯。
			const ok = report.ok && report.models.length > 0 && report.source !== "config-fallback";
			// config-fallback 时 report.reason 为 null，补充一个可诊断原因，避免日志/UI 拿到空 reason。
			const reason = report.source === "config-fallback" ? "config-fallback" : report.reason;
			payload = {
				ok,
				modelCount: report.models.length,
				reason,
				detail: report.detail ?? "",
				savedAt,
			};
			void appLogger.info("config", "Models config background verify", {
				ok,
				modelCount: payload.modelCount,
				reason,
			});
		} catch (error) {
			payload = {
				ok: false,
				modelCount: 0,
				reason: "cli-failed",
				detail: error instanceof Error ? error.message : String(error),
				savedAt,
			};
			void appLogger.warn("config", "Models config background verify failed", {
				detail: payload.detail,
			});
		}
		// 失败先告知用户，再刷新 capability 快照（模型能力自适应模板依赖，
		// 旧 Pi 无 capability RPC 时回退列表）；刷新失败不影响已推送的验证结果。
		if (!payload.ok) {
			getMainWindow()?.webContents.send(ipcChannels.configModelsVerifyResult, payload);
		}
		void refreshPiModelCatalogs().catch(() => undefined);
	};

	// ── 配置管理 ─────────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.configGetModels, async (_event, options?: unknown) => configReadDto(await piConfigRouter.readModels(options)));
	// 源文件页的统一读取（本机/ WSL 原文 + 诊断；ssh 脱敏快照，auth.json 只回派生视图）：fileName 只认五个 pi 配置文件名。
	ipcMain.handle(ipcChannels.configGetRaw, async (_event, fileName: unknown, options?: unknown) => {
		const file = piConfigFileKeyFromName(fileName);
		if (!file) return { raw: "", diagnostic: undefined, unsupported: true };
		return configRawReadDto(await piConfigRouter.readRaw(file, options));
	});
	// 预览/执行单供应商互迁：方向必须是枚举，供应商名在服务层再校验。
	ipcMain.handle(ipcChannels.configPreviewProviderMigration, async (_event, direction: unknown) => {
		if (direction !== "pi-to-dsh" && direction !== "dsh-to-pi") {
			throw new Error("invalid migration direction");
		}
		if (!providerMigration) throw new Error("provider migration is not available");
		return previewProviderMigration(providerMigration, direction as ProviderMigrationDirection);
	});
	ipcMain.handle(ipcChannels.configApplyProviderMigration, async (_event, direction: unknown, provider: unknown) => {
		if (direction !== "pi-to-dsh" && direction !== "dsh-to-pi") {
			throw new Error("invalid migration direction");
		}
		if (typeof provider !== "string") throw new Error("invalid provider name");
		if (!providerMigration) throw new Error("provider migration is not available");
		const result = await applyProviderMigration(providerMigration, direction as ProviderMigrationDirection, provider);
		if (result.ok) {
			void refreshPiModelCatalogs().catch(() => undefined);
		}
		void appLogger.info("config", "Provider migration applied", {
			direction,
			provider,
			ok: result.ok,
			copiedKey: result.copiedKey,
			wroteViaHost: result.wroteViaHost,
			// 失败时记录具体原因（OAuth 拒绝 / 对面没有 / catalog 缺失 / provider not found），
			// 否则“点迁移报错”只能靠打断点查，日志里看不出是哪条失败分支。
			...(result.error ? { error: result.error } : {}),
		});
		return result;
	});
	ipcMain.handle(ipcChannels.configGetAuth, () => configManager.getAuthConfig());
	ipcMain.handle(ipcChannels.configGetSettings, async (_event, options?: unknown) => configReadDto(await piConfigRouter.readSettings(options)));
	ipcMain.handle(ipcChannels.configGetTrust, () => configManager.getTrustConfig());

	// 只读：pi 全局配置目录，供源文件编辑页标注实际路径（渲染层不感知配置位置）。
	ipcMain.handle(ipcChannels.configGetDir, () => configManager.getConfigDir());

	ipcMain.handle(ipcChannels.configSaveModels, async (_event, data, options?: unknown) => {
		const routed = await piConfigRouter.saveModels(data, options);
		if (routed.kind !== "local") {
			// ssh 写回执必须让那台主机的目录缓存失效（否则新加的 provider/模型要等 TTL 才可见）；wsl 只改发行版配置。
			if (routed.kind === "remote") remoteModelCatalog?.invalidate(routed.hostId);
			return configWriteDto(routed, "models.json");
		}
		const result = routed.value;
		if (!result.valid) return result;
		invalidateModelListCache();
		// 即时验证：直接解析刚写入的配置（modelsFromPiConfig 纯函数，0 fork），保存按钮立即返回。
		// fork 真实 pi 的完整验证（本机实测 ~17-21s）放后台跑完再推送 config:models-verify-result，
		// 不再阻塞保存动作——旧实现同步等 CLI 列表报告，用户盯着保存按钮转圈十几秒。
		const localModels = modelsFromPiConfig(data);
		void appLogger.info("config", "Models config saved", {
			providerCount: Object.keys(data?.providers ?? {}).length,
			modelCount: localModels.length,
		});
		void verifyModelsAfterSave(Date.now());
		return {
			valid: true,
			modelLoadOk: localModels.length > 0,
			modelCount: localModels.length,
			modelLoadReason: localModels.length > 0 ? null : "empty",
			modelLoadDetail: localModels.length > 0 ? "" : "no models in saved models.json",
		};
	});
	ipcMain.handle(ipcChannels.configSaveAuth, async (_event, data) => {
		const result = await configManager.saveAuthConfig(data);
		if (result.valid) {
			void refreshPiModelCatalogs().catch(() => undefined);
		}
		void appLogger.info("config", "Auth config saved", { authCount: Object.keys(data ?? {}).length });
		return result;
	});
	ipcMain.handle(ipcChannels.configSaveSettings, async (_event, settings, options?: unknown) => {
		const routed = await piConfigRouter.saveSettings(settings, options);
		if (routed.kind !== "local") return configWriteDto(routed, "settings.json");
		const result = routed.value;
		void appLogger.info("config", "Pi settings config saved", { keys: Object.keys(settings ?? {}) });
		return result;
	});
	/**
	 * 源文件级保存（本机 / WSL 整文件原文；ssh 只接受 merge-patch 守卫，body 在 ssh 路由被忽略）。
	 * 未知文件名仍走 ConfigManager，保持旧调用的 "fileNotEditable" 文案不变。
	 */
	ipcMain.handle(ipcChannels.configSaveRaw, async (_event, fileName: unknown, rawJson: unknown, options?: unknown) => {
		const file = piConfigFileKeyFromName(fileName);
		if (!file) return await configManager.saveRawConfig(String(fileName), String(rawJson));
		if (typeof rawJson !== "string") return { valid: false, error: "raw content must be a string" };
		const routed = await piConfigRouter.writeRaw(file, rawJson, options);
		if (routed.kind !== "local") {
			const dto = configWriteDto(routed, PI_CONFIG_FILE_NAMES[file]);
			void appLogger.info("config", "Raw config saved", { file, bytes: Buffer.byteLength(rawJson, "utf8"), target: routed.kind });
			return dto;
		}
		const result = routed.value;
		if (result.valid) {
			if (file === "models" || file === "auth") {
				void refreshPiModelCatalogs().catch(() => undefined);
			}
		}
		void appLogger.info("config", "Raw config saved", { file, bytes: Buffer.byteLength(rawJson, "utf8") });
		return result;
	});
	ipcMain.handle(ipcChannels.configExport, () => configManager.exportConfig());
	ipcMain.handle(ipcChannels.configImport, async (_event, packageJson: string) => {
		const result = await configManager.importConfig(packageJson);
		if (result.valid) {
			void refreshPiModelCatalogs().catch(() => undefined);
		}
		void appLogger.info("config", "Config imported", { bytes: Buffer.byteLength(packageJson, "utf8"), valid: result.valid });
		return result;
	});
	// 外部 agent 配置发现：只读扫描，入参无；key 只以掩码返回。
	ipcMain.handle(ipcChannels.configDiscoverExternalAgents, async () => {
		try {
			return await discoverExternalAgentProviders();
		} catch (error) {
			// 单源失败已在模块内吸收；这里只兑底扫描器本身抛错，不影响其他 config 通道。
			void appLogger.warn("config", "External agent discovery failed", { error: error instanceof Error ? error.message : String(error) });
			return { sources: [], providers: [] };
		}
	});
	// 导入确认后取真实 key：sourceId 白名单字符集校验（只允许 a-z0-9-: .），防止拼路径逃逸；
	// 返回的 key 只出现在本次响应里，调用方（渲染层）立即写入未保存草稿。
	ipcMain.handle(ipcChannels.configResolveExternalAgentKey, async (_event, sourceId: unknown) => {
		if (typeof sourceId !== "string" || sourceId.length === 0 || sourceId.length > 80 || !/^[a-z0-9:.-]+$/.test(sourceId)) {
			return { ok: false as const, error: "invalid source id" };
		}
		void appLogger.info("config", "External agent key resolved", { sourceId });
		return resolveExternalAgentKey(sourceId);
	});
}
