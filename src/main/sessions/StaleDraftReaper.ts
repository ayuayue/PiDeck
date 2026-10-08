import type { SessionCatalogEntry } from "./SessionCatalog";
import type { SessionRuntimeLogger } from "./SessionRuntimeCoordinator";

/**
 * 零内容草稿自动清理器。
 *
 * 背景：小窗/主窗「新建会话」会立即把 draft 写进 catalog（侧栏可见），
 * 但用户可能从不输入——每点一次新建就留下一条永久空白的会话记录，
 * 只有重启（SessionCatalog.load 的 staleDrafts 清理）才消掉。本清理器把
 * 同一清理语义搬到运行期间：定期剔除「零内容 + 闲置超时」的 pi 草稿。
 *
 * 「零内容」判定比 load() 的启动清理更保守——任何用户投入信号都豁免：
 * 命名过（titleOrigin manual/legacy）、选过模型、预选过 DSH 权限/agent/代理、
 * 导入来源、已落盘或激活过（filePath/piSessionId）。聚焦中的会话与有
 * 活绑定的会话同样豁免（用户正在用/首条消息在途）。
 * DSH 草稿整体不动（对齐 load() 例外：host 侧数据在 $DSH_HOME，删映射即孤儿）。
 */

/** 草稿闲置多久后可清理（updatedAt 距今）；期间任何 catalog 写操作都会刷新 updatedAt 重新计时。 */
export const STALE_DRAFT_REAP_MS = 30 * 60_000;

/** 纯策略判定：单条 entry 是否为可清理的零内容闲置草稿。 */
export function isReapableStaleDraft(entry: SessionCatalogEntry, now: number, options: { staleMs?: number; focusedSessionId?: string; hasLiveRuntime?: boolean }): boolean {
	if (entry.status !== "draft") return false;
	// 对齐 SessionCatalog.load 的启动清理范围：DSH 草稿（含 dshSessionId 中间态）与
	// ACP 草稿（无本地文件，删除即丢失预选配置）保留
	if (entry.backend === "dsh" || entry.dshSessionId) return false;
	if (entry.backend === "acp" || entry.acpSessionId) return false;
	// 匿名/引导页会话（transientEntries）本来就是进程内临时面，不归本清理器
	if (entry.noSession) return false;
	// 已落盘或激活过 = 发送过消息（mergeScanned 会把有文件的条目抬成 active，双保险）
	if (entry.filePath || entry.piSessionId) return false;
	// 用户投入信号：命名过的（manual/legacy）不删
	if (entry.titleOrigin === "manual" || entry.titleOrigin === "legacy") return false;
	// 用户投入信号：显式选过模型 / DSH 权限预设 / agent 预设 / 会话级代理
	if (entry.model || entry.permissionPreset || entry.agentPreset || entry.proxy) return false;
	// 导入来源的会话（理论上不会停在零内容 draft，保险豁免）
	if (entry.importedSourceId) return false;
	// 闲置超时：updatedAt 在 staleMs 内有任何 catalog 写入都会续命
	if (now - entry.updatedAt < (options.staleMs ?? STALE_DRAFT_REAP_MS)) return false;
	// 正聚焦 / 有活绑定（首条消息在途）的会话不动
	if (entry.id === options.focusedSessionId) return false;
	if (options.hasLiveRuntime) return false;
	return true;
}

/** catalog 侧最小接口（SessionCatalog 满足；测试可注入 stub）。 */
export interface StaleDraftCatalogGateway {
	listEntries(): SessionCatalogEntry[];
	removeWithDescendants(id: string): Promise<string[]>;
}

/** runtime 侧最小接口（SessionRuntimeCoordinator 满足；测试可注入 stub）。 */
export interface StaleDraftRuntimeGateway {
	getFocusedSession(): string | undefined;
	hasLiveRuntime(sessionId: string): boolean;
}

/**
 * 轮询式清理器：默认 5 分钟扫一轮。start/stop 生命周期配对，quit 时必须 stop。
 * 删除走 removeWithDescendants（草稿无子树，等价单条删除），删除后经
 * onReaped 把受影响 projectId 交给装配层广播 sessionsCatalogRefreshed，
 * 侧栏静默重拉后空白条目即消失。
 * 注意：本文件会被 node --test 直接 import，只能用可擦除语法
 * （不用 constructor 参数属性，字段显式声明 + 构造器赋值）。
 */
export class StaleDraftReaper {
	private readonly catalog: StaleDraftCatalogGateway;
	private readonly runtime: StaleDraftRuntimeGateway;
	private readonly onReaped?: (projectIds: string[]) => void;
	private readonly logger?: SessionRuntimeLogger;
	private readonly sweepIntervalMs: number;
	private readonly now: () => number;
	private timer: NodeJS.Timeout | undefined;

	constructor(catalog: StaleDraftCatalogGateway, runtime: StaleDraftRuntimeGateway, onReaped?: (projectIds: string[]) => void, logger?: SessionRuntimeLogger, sweepIntervalMs = 5 * 60_000, now: () => number = Date.now) {
		this.catalog = catalog;
		this.runtime = runtime;
		this.onReaped = onReaped;
		this.logger = logger;
		this.sweepIntervalMs = sweepIntervalMs;
		this.now = now;
	}

	/** 启动轮询；幂等。 */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.sweep();
		}, this.sweepIntervalMs);
		// 不阻止进程退出：清理只是记录回收，下一轮启动时 load() 的清理仍兜底
		this.timer.unref?.();
	}

	/** 停止轮询；幂等。 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** 立即执行一轮（测试入口）。 */
	async sweep(): Promise<string[]> {
		const now = this.now();
		const stale = this.catalog.listEntries().filter((entry) =>
			isReapableStaleDraft(entry, now, {
				focusedSessionId: this.runtime.getFocusedSession(),
				hasLiveRuntime: this.runtime.hasLiveRuntime(entry.id),
			}),
		);
		if (stale.length === 0) return [];
		const removedIds: string[] = [];
		const projectIds = new Set<string>();
		for (const entry of stale) {
			try {
				const removed = await this.catalog.removeWithDescendants(entry.id);
				if (removed.length === 0) continue;
				removedIds.push(...removed);
				projectIds.add(entry.projectId);
				void this.logger?.info("stale-draft-reaper", "Reaped empty stale draft", { sessionId: entry.id, projectId: entry.projectId });
			} catch (error) {
				// 单条失败不阻塞本轮其余清理；留 warn 供事后追踪
				void this.logger?.warn("stale-draft-reaper", "Failed to reap stale draft", {
					sessionId: entry.id,
					projectId: entry.projectId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (projectIds.size > 0) this.onReaped?.([...projectIds]);
		return removedIds;
	}
}
