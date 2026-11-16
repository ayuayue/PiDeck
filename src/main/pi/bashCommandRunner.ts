import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { AgentTab, ChatMessage, I18nParams, ImageContent, SendPromptResult } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import { formatBashToolMessage } from "./bashResult";
import type { PiProcess } from "./PiProcess";

/** 本域只读到的运行时切片（宿主 agents map 的值类型 `AgentRuntime`）。 */
type BashRuntime = { tab: AgentTab; process: PiProcess };

/**
 * 本地 bash 命令域的窄接口：只列 `!`/`!!` 执行用到的运行时读取器与消息写入入口，不新增状态。
 *
 * 进程存活读取（`isRunning`/`getDiagnostics`）与 RPC 请求都走 runtime.process，本类不持有进程；
 * 会话状态（tab.status）仍归宿主持有，这里只按既有顺序改写并广播。
 */
export interface BashCommandRunnerHost {
	readonly appLogger?: AppLogger;
	readonly translate: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	requireRuntime(agentId: string): BashRuntime;
	addLocalizedMessage(agentId: string, role: ChatMessage["role"], i18nKey: string, fallbackText: string, options?: { params?: I18nParams; debugDetails?: string; meta?: Record<string, unknown> }): void;
	addMessage(agentId: string, role: ChatMessage["role"], text: string, meta?: Record<string, unknown>, images?: ImageContent[]): void;
	emitState(): void;
}

/**
 * 本地 bash 命令域（拆分第十一刀）：prompt 前缀 `!` / `!!` 的执行与 tool 消息展示。
 *
 * 状态机仍与 pi 终端一致：进程不在 → error 拒绝；请求失败 → 局部错误消息；异常 → 交付未知；
 * finally 按执行前状态回填（error 不覆盖）。宿主保留 `executeBashCommand` 同名薄包装。
 */
export class BashCommandRunner {
	constructor(private readonly host: BashCommandRunnerHost) {}

	/** 宿主字段别名：搬出的实现保持 `this.<字段>` 原样（契约测试按此形态断言）。 */
	private get appLogger() {
		return this.host.appLogger;
	}

	private get translate() {
		return this.host.translate;
	}

	private get requireRuntime() {
		return this.host.requireRuntime;
	}

	private get addLocalizedMessage() {
		return this.host.addLocalizedMessage;
	}

	private get addMessage() {
		return this.host.addMessage;
	}

	private get emitState() {
		return this.host.emitState;
	}

	/**
	 * 执行 bash 命令并通过 tool 消息展示输出，行为与 pi 终端的 !/!! 前缀一致。
	 * excludeFromContext 控制输出是否作为上下文发送给 LLM。
	 */
	async executeBashCommand(agentId: string, command: string, excludeFromContext: boolean): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(agentId);
		const statusBeforeCommand = runtime.tab.status;

		// 检查进程是否还活着
		if (!runtime.process.isRunning()) {
			const errorMessage = "Agent 进程已停止，请重启 Agent 后重试";
			runtime.tab.status = "error";
			this.addLocalizedMessage(agentId, "error", "diagnostic.agentStopped", errorMessage);
			// 与 sendPrompt 同款留痕：!/!! 命令被拒时记下进程诊断快照，
			// 避免「终端命令无效」在 applog 里无迹可寻。
			const diag = runtime.process.getDiagnostics() ?? null;
			void this.appLogger?.warn("agent", "Command rejected: process not running", {
				agentId,
				command,
				statusBeforeReject: runtime.tab.status,
				exitCode: diag?.exitCode ?? null,
				exitSignal: diag?.exitSignal ?? null,
			});
			this.emitState();
			return { accepted: false, error: errorMessage, i18nKey: "diagnostic.agentStopped" };
		}

		runtime.tab.status = "running";
		this.emitState();

		try {
			const response = await runtime.process.client.request(
				{
					type: "bash",
					command,
					excludeFromContext,
				},
				60_000,
			);

			if (!response.success) {
				const errorMessage = response.error ?? "命令执行失败";
				this.addLocalizedMessage(agentId, "error", "diagnostic.commandFailed", "命令执行失败。", { debugDetails: errorMessage });
				return {
					accepted: false,
					error: errorMessage,
					i18nKey: "diagnostic.commandFailed",
					debugDetails: errorMessage,
				};
			}

			this.addMessage(agentId, "user", `${excludeFromContext ? "!!" : "!"}${command}`);
			const data = response.data as
				| {
						output?: string;
						exitCode?: number;
						cancelled?: boolean;
						truncated?: boolean;
				  }
				| undefined;

			const output = data?.output ?? "";
			const exitCode = data?.exitCode ?? 0;
			const cancelled = data?.cancelled ?? false;

			if (cancelled) {
				this.addLocalizedMessage(agentId, "system", "diagnostic.commandCancelled", "命令已取消");
			} else {
				// 以 tool 消息展示命令输出，与 pi 终端的 bash 结果展示保持一致
				const toolMessage = formatBashToolMessage({
					command,
					output,
					exitCode,
					excludeFromContext,
					translate: (key, params) => this.translate(key, params),
				});
				this.addMessage(agentId, "tool", toolMessage.text, toolMessage.meta);
			}
			return { accepted: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// bash 请求也在计时前写入 stdin；异常只能判定响应未知。对于可能有副作用的命令，
			// 把它标成可重试失败会比保守阻止重试更危险。
			runtime.tab.status = statusBeforeCommand === "running" ? "running" : "error";
			this.addLocalizedMessage(agentId, "error", "diagnostic.commandDeliveryUnknown", "命令接收结果未知。请先检查命令输出或工作区状态，避免重复执行。", { debugDetails: errorMessage });
			return {
				accepted: false,
				error: errorMessage,
				delivery: "unknown",
				i18nKey: "diagnostic.commandDeliveryUnknown",
				debugDetails: errorMessage,
			};
		} finally {
			if (runtime.tab.status !== "error") {
				runtime.tab.status = statusBeforeCommand === "running" ? "running" : "idle";
			}
			this.emitState();
		}
	}
}
