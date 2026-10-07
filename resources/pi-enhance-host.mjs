#!/usr/bin/env node
/**
 * PiDeck 提示词增强助手（pi-enhance-host）
 * ============================================================================
 * 为什么存在：输入框的「提示词增强」要用当前会话选中的模型做一次一次性改写。
 * 这条调用不该走活跃的 agent 会话（会污染时间线），也不能由 PiDeck 自己拼 HTTP
 * （模型调用是 pi 的职责，且各 provider 协议不一）。因此复用认证助手验证过的
 * 形态：在用户自己那套 pi 上 in-process 调 pi 官方 `ModelRuntime` 的
 * `streamSimple`，凭据与模型目录跟会话进程读同一份（auth.json / models.json）。
 *
 * 它是 PiDeck 访问 pi 内部能力的一条显式例外通道，边界见仓库根 AGENTS.md
 * 「提示词增强例外通道」一节：只允许「一次性文本补全」用途，禁止扩展成
 * 通用 pi API 桥，禁止接触会话文件与工具调用。
 *
 * 进程模型：由主进程 `EnhancePromptService` spawn 常驻（首次用时拉起，随宿主
 * 退出停止）。stdin 收 NDJSON 指令，stdout 发 NDJSON 消息（stdout 只放协议
 * 数据，日志一律走 stderr）。多个 run 可先后进行，每个记录都带 id，宿主按 id
 * 路由；同 id 的旧 run 被 abort 时补发 error(aborted)，不会静默悬死。
 *
 * 环境变量：
 *   PIDECK_PI_SDK_ENTRY  pi 包内 dist/index.js 的绝对路径（必需，缺失即 fatal）
 *
 * 协议（v1）
 *   宿主 → 助手: {cmd:"complete",id,provider,modelId,systemPrompt,userText}
 *                {cmd:"cancel",id?}   （缺 id = 取消当前全部 run）
 *   助手 → 宿主: {type:"ready",protocolVersion,piVersion}
 *                {type:"started",id}
 *                {type:"delta",id,text}
 *                {type:"done",id,text}
 *                {type:"error",id,errorKind,message}
 *                {type:"fatal",stage,message}
 */

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = 1;

const sdkEntry = process.env.PIDECK_PI_SDK_ENTRY;

/** pi 版本：随 ready 上报，便于宿主日志定位。 */
let sdkVersion = null;

/** 仅写 stderr：stdout 是协议通道，混进日志会让宿主解析失败。 */
function log(message) {
	process.stderr.write(`[pi-enhance-host] ${message}\n`);
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** 协议级致命错误：SDK 加载失败等，宿主收到后应重启进程而非复用。 */
function fatal(stage, message) {
	send({ type: "fatal", stage, message: String(message) });
	process.exitCode = 1;
	process.exit();
}

/** runId → AbortController。run 结束时移除；cancel 按 id（或全部）abort。 */
const activeRuns = new Map();

// ---------------------------------------------------------------------------
// 模型调用
// ---------------------------------------------------------------------------

/** 从 pi 的 AssistantMessage 里抽出纯文本（done/	error 都可能带 partial 内容）。 */
function extractText(message) {
	if (!message || typeof message !== "object" || !Array.isArray(message.content)) return "";
	let out = "";
	for (const block of message.content) {
		if (block && block.type === "text" && typeof block.content === "string") out += block.content;
	}
	return out;
}

/**
 * 跑一次补全。delta 事件把 text_delta 累积后逐条转发；终止事件只发一条。
 * streamOptions.signal 驱动取消；reason=aborted 归为 errorKind "aborted"。
 */
async function runComplete(runtime, command) {
	const { id, provider, modelId, systemPrompt, userText } = command;
	const controller = new AbortController();
	activeRuns.set(id, controller);
	const finish = () => activeRuns.delete(id);

	try {
		const model = runtime.getModel(provider, modelId);
		if (!model) {
			send({ type: "error", id, errorKind: "model-not-found", message: `${provider}/${modelId}` });
			return;
		}

		// pi-ai 的 normalizeContext（compat 导出）在部分安装形态下不可达（报
		// "normalizeContext is not a function"），这里按其实现内联展开：systemPrompt →
		// 首条 system 消息（无 tools 时不带 toolsAdded），user 消息随其后。
		const context = {
			messages: [
				...(systemPrompt ? [{ role: "system", content: systemPrompt, timestamp: 0 }] : []),
				{ role: "user", content: userText, timestamp: Date.now() },
			],
		};

		const stream = runtime.streamSimple(model, context, { signal: controller.signal });
		let accumulated = "";
		let settled = false;

		for await (const ev of stream) {
			if (ev.type === "text_delta" && typeof ev.delta === "string") {
				accumulated += ev.delta;
				send({ type: "delta", id, text: ev.delta });
			} else if (ev.type === "done") {
				// done.message 是权威快照；正常与累积一致，取并集防个别 provider 分块怪异。
				const finalText = extractText(ev.message) || accumulated;
				settled = true;
				send({ type: "done", id, text: finalText });
				break;
			} else if (ev.type === "error") {
				settled = true;
				const aborted = ev.reason === "aborted";
				send({
					type: "error",
					id,
					errorKind: aborted ? "aborted" : "model-error",
					message: aborted ? "aborted" : String(ev.error?.errorMessage || ev.reason || "model error"),
				});
				break;
			}
		}
		// 流没发终止事件就结束了：按协议错误处理，避免宿主悬等。
		if (!settled) send({ type: "error", id, errorKind: "protocol", message: "stream ended without done/error" });
	} catch (error) {
		if (controller.signal.aborted) {
			send({ type: "error", id, errorKind: "aborted", message: "aborted" });
		} else {
			send({ type: "error", id, errorKind: "model-error", message: error instanceof Error ? error.message : String(error) });
		}
	} finally {
		finish();
	}
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
	let sdk;
	try {
		sdk = await import(`file:///${sdkEntry.replace(/\\/g, "/")}`);
	} catch (error) {
		fatal("sdk-load", error instanceof Error ? error.message : String(error));
		return;
	}
	sdkVersion = typeof sdk.VERSION === "string" ? sdk.VERSION : null;

	let runtime;
	try {
		// 不传覆盖项：让 pi 按自己的配置目录解析 auth.json / models.json，
		// 与会话进程读到的凭据和模型目录保持同一份（同认证助手的决策）。
		runtime = await sdk.ModelRuntime.create({});
	} catch (error) {
		fatal("runtime-create", error instanceof Error ? error.message : String(error));
		return;
	}

	send({ type: "ready", protocolVersion: PROTOCOL_VERSION });

	createInterface({ input: process.stdin })
		.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let command;
			try {
				command = JSON.parse(trimmed);
			} catch {
				log(`ignoring unparseable line: ${trimmed.slice(0, 200)}`);
				return;
			}
			if (command?.cmd === "complete") {
				if (typeof command.id !== "string" || !command.id) return;
				// 单飞语义由宿主保证；这里同 id 重复直接忽略，防止双跑。
				if (activeRuns.has(command.id)) return;
				// started 必须先于 runComplete 内部的同步 send（getModel 同步可能立刻报错）。
				send({ type: "started", id: command.id });
				void runComplete(runtime, command);
			} else if (command?.cmd === "cancel") {
				if (typeof command.id === "string" && command.id) {
					activeRuns.get(command.id)?.abort();
				} else {
					for (const controller of activeRuns.values()) controller.abort();
				}
			}
		})
		.on("close", () => {
			log("stdin closed, aborting active runs and exiting");
			for (const controller of activeRuns.values()) controller.abort();
			process.exit(0);
		});
}

process.on("SIGTERM", () => {
	for (const controller of activeRuns.values()) controller.abort();
	process.exit(0);
});
process.on("SIGINT", () => {
	for (const controller of activeRuns.values()) controller.abort();
	process.exit(0);
});

if (!sdkEntry) {
	fatal("startup", "PIDECK_PI_SDK_ENTRY is not set");
} else {
	main().catch((error) => fatal("main", error instanceof Error ? error.message : String(error)));
}
