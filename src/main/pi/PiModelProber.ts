/**
 * 用真实 pi 进程做一次性模型调用，验证某个 provider/model 是否真的能跑通。
 *
 * 为什么不用 net.fetch 模拟：模拟请求与真实会话的差异（SDK User-Agent、请求体、
 * reasoning 参数、流式、代理）会导致「测试失败、会话正常」或反向的误报。
 * 直接 fork pi --mode json --print 走的是 pi 真实的 provider 解析 + SDK 调用路径，
 * 测试结果与会话结果一致。
 *
 * 最小化启动参数：
 * - --no-session：不落盘会话文件；
 * - --no-skills/--no-tools/--no-context-files/--no-prompt-templates/--no-themes：
 *   跳过技能/工具/上下文文件/模板/主题的发现与加载，纯对话且冷启动更快；
 * - --offline：跳过启动期网络操作（目录刷新等），模型调用本身不受影响。
 *
 * 扩展策略（issue #181）：探测默认【加载扩展】——扩展通过 pi.registerProvider 注册的
 * provider（如 antigravity 插件）必须在「测试连接」里可测，否则扩展模型在会话里选了
 * 却无法预检。代价是坏扩展/慢扩展（异步工厂挂起）可能拖垮探测：此时进程超时（或
 * pi 层异常退出），降级到不带扩展的最小参数集重试一次，保证 catalog 模型探测不受
 * 用户本地扩展影响（与 modelListCache/模型选择器同一套“带扩展优先、失败降级”策略）。
 */

import { execFile } from "node:child_process";
import type { PiLocator } from "./PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";
import type { PiModelProbeResult } from "../../shared/types/fetchedModel";
import {
	applyConfigProxyTarget,
	type ConfigProxyTarget,
} from "../sessions/sessionProxyPolicy";

/**
 * 探测超时：放宽到 120s。
 *
 * 放宽容度的原因（issue #173）：reasoning 模型（如 deepseek-v4-flash）在输出前有
 * thinking 阶段，首包延迟显著高于普通模型；叠加 pi 冷启动与网络抖动后，原 45s 会
 * 在模型实际可用时误报 `pi model probe timed out`（用户会话内调用同一模型正常）。
 *
 * 不复用 settings.rpcTimeout（会话 RPC 超时）的原因：rpcTimeout 语义是「等一整轮
 * agent 交互」（含工具调用、多轮命令，见 AgentManager prompt 分支注释），且
 * SettingsStore.ensureRpcTimeoutMinimum 强制下限 600s。测试连接让用户干等 10 分钟
 * 才看到失败不可接受，故探针保留独立常量，取值兼顾 reasoning 模型上界与等待体感。
 */
export const PROBE_TIMEOUT_MS = 120_000;

// 全集优化参数：关掉一切非必要资源发现/加载，纯对话且冷启动最快（当前 pi 版本）。
// 实测每个 flag 都真实生效，减少首包延迟。
// 注意：本集【不带】--no-extensions——扩展 provider 模型（issue #181）必须可测；
// 只在进程级失败（超时等）时降级到 PROBE_BASE_ARGS_NO_EXTENSIONS。
const PROBE_BASE_ARGS = [
	"--mode", "json",
	"--print",
	"--no-session",
	"--no-skills",
	"--no-tools",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-themes",
	"--offline",
];

// 降级核心集：只保留长期存在的核心 flag，用于老版本 pi。
// --no-context-files（issue #3253）、--no-themes、--no-prompt-templates 等较新，老 pi
// 解析到未知长 flag 会直接 `Error: Unknown option: --xxx` 硬退（实测：任意未知长 flag
// 快速退出 out=0），导致探针误报「测试失败」。删掉这些纯优化的 --no-* 只影响冷启动
// 速度，结果仍与会话一致；仍保留扩展加载（同 PROBE_BASE_ARGS 的 #181 理由）。
const PROBE_BASE_ARGS_MINIMAL = [
	"--mode", "json",
	"--print",
	"--no-session",
	"--offline",
];

// 最终降级（无扩展）：带扩展的两次尝试都超时/pi 层异常时才用——坏扩展工厂挂起时
// pi 启动被卡住（异步 factory 被 await），去掉扩展后探测应立即正常完成。
const PROBE_BASE_ARGS_NO_EXTENSIONS = [
	"--mode", "json",
	"--print",
	"--no-session",
	"--no-extensions",
	"--offline",
];

export type { PiModelProbeResult };

/** 从 assistant 消息 content 中提取纯文本（content 可能是 string 或分段数组）。 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && (part as { type?: string }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

/**
 * 解析 `pi --mode json --print` 的 stdout（每行一个 JSON 事件）。
 * 找到 `agent_end` 事件的最后一条 assistant 消息：
 * - stopReason === "error" → 失败，取 errorMessage；
 * - 否则 → 成功，取 model / usage / 文本片段。
 */
export function parsePiProbeOutput(stdout: string): Omit<PiModelProbeResult, "latencyMs"> {
	let agentEnd: unknown = null;
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (obj && typeof obj === "object" && (obj as { type?: string }).type === "agent_end") {
			agentEnd = obj;
		}
	}

	const messages = (agentEnd as { messages?: unknown[] } | null)?.messages;
	if (!Array.isArray(messages)) {
		return { success: false, error: "pi returned no result" };
	}

	// 取最后一条 assistant 消息作为最终结果（agent_end.messages 里可能含 user 消息）。
	let lastAssistant: Record<string, unknown> | null = null;
	for (const message of messages) {
		if (message && typeof message === "object" && (message as { role?: string }).role === "assistant") {
			lastAssistant = message as Record<string, unknown>;
		}
	}
	if (!lastAssistant) {
		return { success: false, error: "pi returned no assistant message" };
	}

	const model = typeof lastAssistant.model === "string" ? lastAssistant.model : undefined;
	const snippet = extractText(lastAssistant.content);

	if (lastAssistant.stopReason === "error") {
		return {
			success: false,
			error:
				typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage
					? lastAssistant.errorMessage
					: "model call failed",
			model,
			snippet,
		};
	}

	const usage = lastAssistant.usage as Record<string, unknown> | undefined;
	const tokens =
		usage && typeof usage.input === "number"
			? { input: usage.input, output: typeof usage.output === "number" ? usage.output : undefined }
			: undefined;

	return { success: true, model, snippet, tokens };
}

/** stdout 是否含 agent_end 事件：区分「pi 层失败」（启动/参数/扩展问题）与「模型级结果」。 */
function hasAgentEndEvent(stdout: string): boolean {
	return /"type"\s*:\s*"agent_end"/.test(stdout);
}

/**
 * 单次探针运行（不走降级）。成功返回 stdout；失败返回 errorMessage（超时/模型报错/进程
 * 错误）、unknownOption 标记（stderr/stdout/error.message 含 "Unknown option"）与
 * timedOut 标记（被 kill / ETIMEDOUT）。
 *
 * unknownOption 仅用于触发降级重试：pi 对未注册的长 flag 是硬报错（实测 `--bogus-flag`
 * → 407ms 退出 out=0），而老版本 pi 又缺少 --no-context-files/--no-themes 等新 flag，
 * 此时必须降级为最小核心集重试；真正的模型报错（401/权限）不含该字样，不会误触发降级。
 * timedOut 用于触发【无扩展】降级：坏扩展的异步工厂被 await 时会让 pi 启动挂起，
 * 与模型本身超时同形（#181），重试一次无扩展可把两者区分开。
 */
function runProbeOnce(
	piLocator: PiLocator,
	settings: ReturnType<SettingsStore["get"]>,
	invocation: ReturnType<PiLocator["createInvocation"]>,
): Promise<
	| { ok: true; stdout: string }
	| { ok: false; errorMessage: string; unknownOption: boolean; timedOut: boolean }
> {
	return new Promise((resolve) => {
		const child = execFile(
			invocation.command,
			invocation.args,
			{
				env: piLocator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
				shell: invocation.shell,
				windowsHide: true,
				timeout: PROBE_TIMEOUT_MS,
				encoding: "utf8",
				windowsVerbatimArguments: invocation.windowsVerbatimArguments,
			},
			(error, stdout, stderr) => {
				if (error) {
					const errObj = error as NodeJS.ErrnoException & { killed?: boolean };
					const timedOut = errObj.killed || errObj.code === "ETIMEDOUT";
					// 超时信息带上秒数：便于一眼区分「探针超时」与「模型报错」，
					// 也方便后续回收用户反馈时判断是否真到了 thinking 阶段的上界。
					const message = timedOut
						? `pi model probe timed out after ${Math.round(PROBE_TIMEOUT_MS / 1000)}s`
						: (stderr?.trim() || error.message).slice(0, 500);
					resolve({
						ok: false,
						errorMessage: message,
						unknownOption: /unknown option/i.test(
							`${stderr ?? ""}\n${stdout ?? ""}\n${error.message}`,
						),
						timedOut,
					});
					return;
				}
				resolve({ ok: true, stdout });
			},
		);
		// 关键：主动给子进程 stdin 发送 EOF。
		// pi 在 `--mode json --print` 下若 stdin 保持打开且未收到 EOF，会阻塞等待
		// 键盘输入，导致探针永远超时（实测：cmd.exe /s /c 包装调用下 stdin 未结束
		// ➜ 120s 超时 out=0；stdin 显式 end() 后才正常返回）。直接运行 pi.cmd 能成功
		// 是因为外层 shell 已把 stdin 连到 EOF；桌面端 execFile 默认保持管道打开，必须
		// 手动关闭，避免进程一直被判定为超时。
		child?.stdin?.end();
	});
}

/**
 * fork pi 做一次性模型调用。成功后由 parsePiProbeOutput 解析结果；
 * pi 进程级失败（未安装/unknown option/超时/崩溃）时返回失败而非抛出。
 *
 * proxyTarget：配置页显式选择的代理目标（follow/on/off），覆盖探针子进程的代理环境——
 * 部分供应商（海外网关）需要代理才能访问，而全局 pi 代理开关通常只服务于会话白名单，
 * 探针按用户选择强制注入或剥离代理环境变量，与会话侧 applyPiProxyEnv 共用同一套键。
 *
 * 降级链：带扩展全集 → 带扩展最小集（仅 unknown option）→ 无扩展最小集（进程超时/
 * pi 层无 agent_end 结果时）。模型级结果（agent_end 成功或 stopReason=error）
 * 一律直接返回，不降级——降级只针对“pi 没跑起来”的情形（#181 坏扩展场景）。
 */
export async function probePiModel(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	providerName: string,
	modelId: string,
	proxyTarget?: ConfigProxyTarget,
): Promise<PiModelProbeResult> {
	const startedAt = Date.now();
	const settings = settingsStore.get();
	// 测试代理显式选择时覆盖探针设置（follow 原样返回，不产生新对象）。
	const probeSettings = applyConfigProxyTarget(settings, proxyTarget);
	// 拉测试可以等 WSL which；不能在 resolveCommand 里同步卡住主进程。
	if (settings.wslEnabled && settings.wslDistro && settings.wslUser) {
		await piLocator.warmWslCommand(settings.wslDistro, settings.wslUser);
	}
	const command = piLocator.resolveCommand(
		settings.customPiPath,
		settings.wslEnabled,
		settings.wslDistro,
		settings.wslUser,
	);

	// 老 pi 优雅降级：先用全集优化参数跑，命中 "Unknown option" 再退到最小核心集重试一次。
	// 全集参数跑通即返回；模型真正的报错/超时不命中 unknown-option，直接返回不降级。
	let lastErrorMessage = "pi model probe failed";
	let retryWithoutExtensions = false;
	for (const baseArgs of [PROBE_BASE_ARGS, PROBE_BASE_ARGS_MINIMAL]) {
		const invocation = piLocator.createInvocation(command, [
			...baseArgs,
			"--provider", providerName,
			"--model", modelId,
			"Hi",
		]);
		const outcome = await runProbeOnce(piLocator, probeSettings, invocation);
		if (outcome.ok) {
			const parsed = parsePiProbeOutput(outcome.stdout);
			// 有 agent_end（无论成功/模型报错）都是模型级结果，直接返回；
			// 无 agent_end 说明 pi 层就没跑起来（扩展加载失败等），继续降级。
			if (hasAgentEndEvent(outcome.stdout)) {
				return { ...parsed, latencyMs: Date.now() - startedAt };
			}
			lastErrorMessage = parsed.error ?? "pi returned no result";
			// 两个带扩展集都无结果 → 换无扩展集再试一次。
			retryWithoutExtensions = true;
			break;
		}
		lastErrorMessage = outcome.errorMessage;
		if (outcome.unknownOption) continue;
		// 超时可能由坏扩展的异步工厂挂起引起（与模型 slow-thinking 同形），
		// 值得换无扩展集区分一次；其他进程级错误（ENOENT/配置/真实报错）不重试。
		if (outcome.timedOut) retryWithoutExtensions = true;
		break;
	}

	if (retryWithoutExtensions) {
		const invocation = piLocator.createInvocation(command, [
			...PROBE_BASE_ARGS_NO_EXTENSIONS,
			"--provider", providerName,
			"--model", modelId,
			"Hi",
		]);
		const outcome = await runProbeOnce(piLocator, probeSettings, invocation);
		if (outcome.ok) {
			const parsed = parsePiProbeOutput(outcome.stdout);
			return { ...parsed, latencyMs: Date.now() - startedAt };
		}
		lastErrorMessage = outcome.errorMessage;
	}
	return { success: false, error: lastErrorMessage, latencyMs: Date.now() - startedAt };
}
