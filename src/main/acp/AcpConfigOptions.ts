/**
 * ACP 会话级配置写入：session/set_config_option 的串行化下发 + 工具级记忆重放。
 *
 * 从 AcpAgentManager 抽出：配置写入是「串行链 + 迟到校验 + 记忆只落 agent 实际接受值」
 * 一整套约束（乱序响应、boolean 帧形状 #451、启动参数已定档时记忆让路），散在 manager
 * 里最容易在补一条记忆来源时破坏串行性。runtime 归属/通道发布仍经 host 回到 manager，
 * 会话成败判定不在此模块（失败只记日志，不能让记忆阻断开会话）。
 */
import type { AgentTab } from "../../shared/types/agent";
import type { AcpConfigOption } from "./acpProtocol";
import type { AcpAgentRuntime } from "./acpAgentRuntime";
import { findAcpBypassModeValue, findAcpModeOption, isAcpBypassModeValue, isRememberedAcpConfigOption, planAcpConfigReplay } from "./acpToolConfig";

export type AcpConfigOptionsHost = {
	/** 取 runtime（缺失时抛 "No ACP runtime: <id>"，与 manager 的公共契约一致）。 */
	requireRuntime(agentId: string): AcpAgentRuntime;
	/** runtime 归属校验：stop/重建/重连后的迟到配置写入不得作用于新 runtime。 */
	ownsRuntime(runtime: AcpAgentRuntime): boolean;
	onConfigOptionsChanged?: (tab: AgentTab, options: AcpConfigOption[]) => void;
	rememberConfigOption?: (toolId: string, optionId: string, value: string | boolean) => void;
	getToolConfigDefaults?: (toolId: string) => Record<string, string | boolean> | undefined;
	logger?: { info(channel: string, message: string, meta?: Record<string, unknown>): void; warn(channel: string, message: string, meta?: Record<string, unknown>): void };
};

export class AcpConfigOptions {
	constructor(private readonly host: AcpConfigOptionsHost) {}

	/** 下发配置选择并返回 agent 回传的完整 configOptions(规范:响应必带整表)。 */
	async applyConfigOption(agentId: string, optionId: string, value: string | boolean): Promise<AcpConfigOption[]> {
		return this.enqueueConfigOption(agentId, optionId, value, true);
	}

	/**
	 * 配置写入入队:串行化同一 runtime 的配置写入(乱序响应下迟到的旧整表会回退
	 * runtime.configOptions 并推过期通知;排队后通知顺序=请求顺序)。
	 * remember=false 用于新建会话重放,避免把记忆值再写回设置。
	 */
	private enqueueConfigOption(agentId: string, optionId: string, value: string | boolean, remember: boolean): Promise<AcpConfigOption[]> {
		const runtime = this.host.requireRuntime(agentId);
		const previous = (runtime.configChain ?? Promise.resolve()).catch(() => undefined);
		const operation = previous.then(() => this.performConfigOptionRequest(runtime, optionId, value, remember));
		runtime.configChain = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** 真正发出 session/set_config_option;在串行链上迟到执行,需重新校验 runtime 归属与连接。 */
	private async performConfigOptionRequest(runtime: AcpAgentRuntime, optionId: string, value: string | boolean, remember: boolean): Promise<AcpConfigOption[]> {
		if (!this.host.ownsRuntime(runtime)) throw new Error("ACP agent is not running");
		const conn = runtime.conn;
		if (!conn || conn.isClosed()) throw new Error("ACP agent is not running");
		let result: { configOptions?: AcpConfigOption[] } | null;
		try {
			// boolean 项必须带上 agent 声明的 type：CodeBuddy 2.178.1 的 set_config_option
			// 对 {configId, value} 按 string 分支校验，boolean 值直接 -32602 Invalid params；
			// 带 type:"boolean" 才走 boolean 分支（issue #451）。select 项保持旧帧形状，
			// 部分实现（opencode 等）对多余字段更敏感，没必要多带。
			const declaredType = (runtime.configOptions ?? []).find((candidate) => candidate.id === optionId)?.type;
			const params = declaredType === "boolean" ? { sessionId: runtime.acpSessionId, configId: optionId, type: declaredType, value } : { sessionId: runtime.acpSessionId, configId: optionId, value };
			result = (await conn.request("session/set_config_option", params, 15_000)) as { configOptions?: AcpConfigOption[] } | null;
		} catch (error) {
			// 拒绝原因常只写在 error.data.details 里（如 Qoder 的 "unknown permission_mode: yolo"），
			// 而 IPC 只透传 message：不拼进去渲染层就只剩 "Internal error"，用户无从判断为什么没生效。
			const details = (error as { data?: { details?: unknown } } | null)?.data?.details;
			if (typeof details === "string" && details.trim() && !(error instanceof Error && error.message.includes(details))) {
				throw new Error(`${error instanceof Error ? error.message : String(error)}: ${details.trim()}`);
			}
			throw error;
		}
		if (!result || !Array.isArray(result.configOptions)) throw new Error("session/set_config_option returned no configOptions");
		runtime.configOptions = result.configOptions;
		this.host.onConfigOptionsChanged?.(runtime.tab, result.configOptions);
		if (remember) this.rememberAppliedConfigOption(runtime, optionId, value, result.configOptions);
		return result.configOptions;
	}

	/** 只记忆 agent 实际接受的值;模型类选项(用户口径)不落盘。 */
	private rememberAppliedConfigOption(runtime: AcpAgentRuntime, optionId: string, requested: string | boolean, options: AcpConfigOption[]): void {
		const option = options.find((candidate) => candidate.id === optionId);
		if (!option || !isRememberedAcpConfigOption(option)) return;
		const applied = option.currentValue ?? requested;
		if (typeof applied !== "string" && typeof applied !== "boolean") return;
		this.host.rememberConfigOption?.(runtime.tool.id, optionId, applied);
	}

	/**
	 * 工具级 bypass 权限：握手后在 agent 自己的 mode 枚举里挑 bypass 档下发。
	 *
	 * 只能用运行期下发：Claude 适配器不读启动参数（初始模式只取 settings.json 的
	 * permissions.defaultMode），Qoder 适配器则直接拒绝 set_config_option（见 #444 同类问题）。
	 * 所以失败只记日志——某些 CLI 版本压根没有 bypass 档，不该因此开不了会话。
	 * 启动参数已经定档（Qoder `--permission-mode`）时记忆重放会让路，见 pinnedBypassModeOptionId。
	 *
	 * session/load 恢复的会话也必须下发：agent 不持久化权限模式，load 回来的是新进程的默认档
	 * （CodeBuddy/Claude 实测都是 auto），跳过这一步历史会话就从 full/bypass 掉回 auto。
	 * 已处于 bypass 档时 currentValue 与目标值相等，自然不会重复下发。
	 */
	async applyBypassPermissionDefault(runtime: AcpAgentRuntime): Promise<void> {
		if (runtime.tool.bypassPermissions !== true) return;
		const mode = findAcpModeOption(runtime.configOptions);
		if (!mode) return;
		const bypass = findAcpBypassModeValue(mode);
		if (!bypass || mode.currentValue === bypass) return;
		try {
			await this.enqueueConfigOption(runtime.tab.id, mode.id, bypass, false);
		} catch (error) {
			// 记忆里不落这条：用户没主动选过，写进去会污染后续会话的默认值
			this.host.logger?.warn("acp", `[${runtime.tool.name}] bypass permission mode rejected: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * 模式档已由启动参数定在 bypass 时的选项 id（记忆重放必须让路）。
	 *
	 * Qoder 只能靠 `--permission-mode` 定档（运行期 set_config_option 回
	 * -32603 unknown permission_mode: yolo），若这里不拦，重放记忆里的旧档位（如 auto）会把
	 * 会话降回非 bypass，随后补设 bypass 又必然失败——新会话显示 Auto、重开（session/load
	 * 不重放）反而正常，正是这条链。
	 */
	private pinnedBypassModeOptionId(runtime: AcpAgentRuntime): string | undefined {
		if (runtime.tool.bypassPermissions !== true) return undefined;
		const mode = findAcpModeOption(runtime.configOptions);
		if (!mode) return undefined;
		const bypass = findAcpBypassModeValue(mode);
		return bypass && mode.currentValue === bypass ? mode.id : undefined;
	}

	/**
	 * 握手后重放工具级记忆：新建会话全量重放；session/load 恢复的会话只补回 bypass 档。
	 *
	 * 恢复会话全量重放会覆盖 agent 自己恢复的会话状态（思考档等），所以保持不重放；
	 * 权限模式是唯一例外——agent 不持久化它，load 回来只是进程默认档（如 auto），不补的话
	 * 用户上次在历史会话里选的 full/bypass 重开后就没了。只补 bypass 值而非记忆里的任意模式，
	 * 是为了不把 agent 恢复出的会话模式降级成一条更早的记忆。
	 */
	async replayToolConfigDefaults(runtime: AcpAgentRuntime): Promise<void> {
		const defaults = this.host.getToolConfigDefaults?.(runtime.tool.id);
		// 工具级 bypass 开关是「明确配置」：模式已是 bypass 时保住它，不让学来的上次选择覆盖。
		const pinnedModeId = this.pinnedBypassModeOptionId(runtime);
		const mode = findAcpModeOption(runtime.configOptions);
		// 恢复会话只补「当前还不是 bypass」的模式：agent 恢复出的已是 bypass（可能更强，如
		// fullAccess）就保持不动——跨档重放会把它降成记忆里的弱档；非 bypass 记忆则一律不覆盖。
		const restoreBypass = runtime.loadedSession && mode !== undefined && !isAcpBypassModeValue(mode.currentValue ?? false);
		for (const item of planAcpConfigReplay(runtime.configOptions, defaults)) {
			if (item.id === pinnedModeId) continue;
			if (runtime.loadedSession && !(restoreBypass && item.id === mode?.id && isAcpBypassModeValue(item.value))) continue;
			try {
				await this.enqueueConfigOption(runtime.tab.id, item.id, item.value, false);
			} catch (error) {
				// 选项在当前 CLI 版本已移除/值被拒:跳过,不能让记忆阻断开会话。
				this.host.logger?.warn("acp", `[${runtime.tool.name}] remembered config skipped: ${item.id}`, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}
