/**
 * SecurityStore（src/main/security/SecurityStore.ts）
 *
 * 安全管理配置的唯一 owner：
 * - 配置持久化在 AppSettings.securityConfig（settings.json，经 SettingsStore 保存）；
 * - 每次配置/会话等级变更后，把「策略快照」写入 userData/security-policy.json，
 *   pi-deck-security-gate 扩展按快照执行拦截（无 IPC 依赖，运行时随时重读）。
 *
 * 会话级覆盖的键 = 会话文件路径（SessionRecord.id），与运行时 tab.sessionId 一致；
 * 快照 key 用同样的键，扩展通过 PIDECK_SESSION_ID 环境变量拿当前会话身份。
 */

import { app } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameWithRetry } from "../utils/fsRetry";
import {
	createDefaultSecurityConfig,
	type SecurityConfig,
	type SecurityPolicySnapshot,
} from "../../shared/types/security";
import type { SettingsStore } from "../settings/SettingsStore";
import {
	buildSnapshot,
	sanitizeLineList,
	validateSecurityConfig,
} from "./policy";

/** 快照文件名：扩展经 PIDECK_SECURITY_CONFIG 环境变量读取 */
const SNAPSHOT_FILE = "security-policy.json";

/** 由 SettingsStore 提供配置读写（依赖注入，便于测试与替换） */
export type SecurityStoreDeps = {
	settingsStore: SettingsStore;
	/** 日志回调（与 appLogger.info 同签名；不强制，缺省静默） */
	log?: (domain: string, message: string, details?: Record<string, unknown>) => void;
};

export class SecurityStore {
	private readonly settingsStore: SettingsStore;
	private readonly log: (domain: string, message: string, details?: Record<string, unknown>) => void;
	private snapshotPromise: Promise<void> | null = null;

	constructor(deps: SecurityStoreDeps) {
		this.settingsStore = deps.settingsStore;
		this.log = deps.log ?? (() => undefined);
	}

	/** 快照绝对路径（Windows 用户数据目录；WSL 下由 PiProcess 转 Linux 路径后注入） */
	getSnapshotPath(): string {
		return join(app.getPath("userData"), SNAPSHOT_FILE);
	}

	/**
	 * 读取配置并做向后兼容归一化：
	 * - 字段缺失时并入默认值（旧版本设置文件没有 securityConfig 字段）；
	 * - 保证内置等级存在（id 固定，用户编辑过的内置等级保留其内容）；
	 * - defaultLevelId 指向不存在的等级时回退默认等级（off）。
	 */
	getConfig(): SecurityConfig {
		const raw = this.settingsStore.get().securityConfig;
		return this.normalizeConfig(raw);
	}

	/** 归一化（见 getConfig 注释）；纯函数便于单测。 */
	normalizeConfig(raw: SecurityConfig | undefined): SecurityConfig {
		const def = createDefaultSecurityConfig();
		if (!raw || typeof raw !== "object") return def;

		const mergedLevels = [...def.levels];
		if (Array.isArray(raw.levels)) {
			for (const level of raw.levels) {
				if (!level || typeof level.id !== "string") continue;
				const idx = mergedLevels.findIndex((m) => m.id === level.id);
				// 行列表字段（含用户输入框保留的空行/空白）在此收敛：空串进入策略会
				// 误伤（空 denyDirs 匹配一切路径、空 bash 正则匹配一切命令），必须清洗。
				const cleaned = {
					...level,
					denyBashPatterns: sanitizeLineList(level.denyBashPatterns),
					denyDirs: sanitizeLineList(level.denyDirs),
					customAllowDirs: sanitizeLineList(level.customAllowDirs),
				};
				if (idx >= 0) mergedLevels[idx] = cleaned;
				else mergedLevels.push(cleaned);
			}
		}

		const hasDefault = mergedLevels.some((level) => level.id === raw.defaultLevelId);
		return {
			enabled: raw.enabled === true,
			defaultLevelId: hasDefault ? raw.defaultLevelId : def.defaultLevelId,
			levels: mergedLevels,
			sessionOverrides:
				raw.sessionOverrides && typeof raw.sessionOverrides === "object"
					? { ...raw.sessionOverrides }
					: {},
		};
	}

	/**
	 * 更新配置（校验 + 持久化 + 刷新快照）。
	 * 校验失败时抛错，IPC 层转结构化错误返回。
	 */
	async updateConfig(patch: Partial<SecurityConfig>): Promise<SecurityConfig> {
		const current = this.getConfig();
		const next: SecurityConfig = {
			...current,
			...patch,
			// 数组/记录字段需要整表替换，避免浅合并丢字段
			levels: patch.levels ?? current.levels,
			sessionOverrides: patch.sessionOverrides ?? current.sessionOverrides,
		};
		const normalized = this.normalizeConfig(next);
		const errors = validateSecurityConfig(normalized);
		if (errors.length > 0) {
			throw new Error(`安全配置校验失败: ${errors.join("; ")}`);
		}
		await this.settingsStore.update({ securityConfig: normalized });
		await this.writeSnapshot(normalized);
		this.log("security", "Security config updated", {
			enabled: normalized.enabled,
			defaultLevelId: normalized.defaultLevelId,
			levels: normalized.levels.length,
		});
		return normalized;
	}

	/** 设置会话级覆盖：levelId 为空 = 清除覆盖（跟随全局默认）。 */
	async setSessionLevel(sessionId: string, levelId: string | null): Promise<SecurityConfig> {
		const current = this.getConfig();
		const sessionOverrides = { ...current.sessionOverrides };
		const prev = sessionOverrides[sessionId] ?? null;
		if (levelId && current.levels.some((level) => level.id === levelId)) {
			sessionOverrides[sessionId] = levelId;
		} else {
			delete sessionOverrides[sessionId];
		}
		// 会话级安全覆盖变更属敏感操作，单独留痕（updateConfig 的全局日志不含逐会话明细）
		if (prev !== (sessionOverrides[sessionId] ?? null)) {
			this.log("security", "Session security level changed", {
				sessionId,
				from: prev,
				to: sessionOverrides[sessionId] ?? null,
			});
		}
		return this.updateConfig({ sessionOverrides });
	}

	/** 查询会话当前生效等级 id（覆盖优先，否则全局默认）。 */
	getSessionLevelId(sessionId: string | undefined): string {
		const config = this.getConfig();
		const override = sessionId ? config.sessionOverrides[sessionId] : undefined;
		return override ?? config.defaultLevelId;
	}

	/** 确保快照已写入（Agent 启动前调用；内部合并并发写，幂等）。 */
	ensureSnapshotWritten(): Promise<void> {
		if (!this.snapshotPromise) {
			this.snapshotPromise = this.writeSnapshot(this.getConfig()).finally(() => {
				this.snapshotPromise = null;
			});
		}
		return this.snapshotPromise;
	}

	/** 写快照文件（原子写：先写临时文件再 rename，避免扩展读到半截 JSON）。 */
	private async writeSnapshot(config: SecurityConfig): Promise<void> {
		const snapshot: SecurityPolicySnapshot = buildSnapshot(config);
		const target = this.getSnapshotPath();
		const tmp = `${target}.tmp`;
		try {
			await mkdir(app.getPath("userData"), { recursive: true });
			await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
			// 杀软扫描可能瞬时锁住刚写出的 tmp，rename 走退避重试；仍失败则由外层 catch 降级日志
			await renameWithRetry(tmp, target);
		} catch (error) {
			// 快照写失败不阻塞主流程：Agent 以旧快照继续运行（fail-safe 方向由扩展 defaultAction 兜底）
			this.log("security", "Snapshot write failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
