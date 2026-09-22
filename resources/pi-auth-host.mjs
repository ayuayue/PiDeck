#!/usr/bin/env node
/**
 * PiDeck 认证助手（pi-auth-host）
 * ============================================================================
 * 为什么存在：pi 把供应商登录放在 CLI 的交互层（`pi` 的 `/login`），RPC 方法表里
 * 没有任何 auth 入口，扩展 API 也不提供登录。PiDeck 需要用自己的弹框完成登录，
 * 因此这里直接调用 pi 官方的 `ModelRuntime` 认证 API，只做「宿主弹框 ⇄ pi 登录
 * 流程」的转发与序列化，不实现任何一家的 OAuth/设备码/回调逻辑。
 *
 * 它是 PiDeck 访问 pi 内部能力的一条显式例外通道，边界见仓库根 AGENTS.md
 * 「认证例外通道」一节：只允许 auth（list/login/logout）用途，禁止扩展成
 * 通用 pi API 桥。
 *
 * 进程模型：由主进程 `PiAuthService` spawn，stdin 收 NDJSON 指令，stdout 发
 * NDJSON 消息（stdout 只放协议数据，日志一律走 stderr）。一个进程服务一次
 * 登录/登出，宿主用完即杀；进程退出时 pi 自己的回调服务器/设备码轮询随之停止。
 *
 * 环境变量：
 *   PIDECK_PI_SDK_ENTRY  pi 包内 dist/index.js 的绝对路径（必需，缺失即 fatal）
 *
 * 协议（v1）
 *   宿主 → 助手: {cmd:"list"} | {cmd:"login",providerId,type} |
 *                {cmd:"answer",id,value} | {cmd:"cancel"} | {cmd:"logout",providerId}
 *   助手 → 宿主: {type:"ready",protocolVersion,piVersion}
 *                {type:"providers",providers:[...]}（含已登录状态与 builtIn 来源标记）
 *                {type:"event",event}            pi 的 AuthEvent 原样透传
 *                {type:"prompt",id,prompt}       需要宿主回答
 *                {type:"prompt-cancelled",id}     pi 侧自行解决了该提问
 *                {type:"result",ok,cancelled,error}
 *                {type:"fatal",stage,message}
 */

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = 1;

const sdkEntry = process.env.PIDECK_PI_SDK_ENTRY;

/** pi 版本：随 ready / providers 上报，便于宿主在 pi 过旧时给出可读提示。 */
let sdkVersion = null;

/** 仅写 stderr：stdout 是协议通道，混进日志会让宿主解析失败。 */
function log(message) {
	process.stderr.write(`[pi-auth-host] ${message}\n`);
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * 以 fatal 结束会话。fatal 同时终止当前操作（宿主侧只保留连接，不会重试）。
 * 缺 SDK 入口连 ready 都不发，让宿主能区分「没装上 pi」和「装上但加载失败」。
 */
function fatal(stage, message) {
	send({ type: "fatal", stage, message: String(message) });
	process.exitCode = 1;
	process.exit();
}

// ---------------------------------------------------------------------------
// NDJSON 指令流
// ---------------------------------------------------------------------------

let queuedCommands = [];
const pendingResolvers = [];

/**
 * 取指令。宿主不会中途断流，所以 stdin end 视作「宿主放弃」：投入一个 null
 * 唤醒等待者，让调用方走退出路径，避免事件循环空掉后 Node 以 13 号退出。
 */
function nextCommand() {
	if (queuedCommands.length > 0) return Promise.resolve(queuedCommands.shift());
	return new Promise((resolve) => pendingResolvers.push(resolve));
}

function pushCommand(command) {
	const resolve = pendingResolvers.shift();
	if (resolve) resolve(command);
	else queuedCommands.push(command);
}

function dispatch(command) {
	pushCommand(command);
}

/**
 * 等待某个提问的答案，同时监听 pi 给的 `prompt.signal`。
 *
 * 官方流程会用这个 signal 取消提问：比如设备码先被回调服务器拿到授权码，
 * 此时回调胜出、提问作废；或整个流程被中止。两种都要能打断等待，否则
 * 进程会挂在无人回答的提问上。返回值 `"__aborted__"` 表示提问已作废。
 */
const PROMPT_ABORTED = "__pideck_prompt_aborted__";

function isPromptAborted(value) {
	return value === PROMPT_ABORTED;
}

function answerPrompt(id, prompt) {
	const signal = prompt.signal;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			resolve(PROMPT_ABORTED);
			return;
		}
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			log(`prompt ${id} aborted by pi (out-of-band resolution)`);
			send({ type: "prompt-cancelled", id });
			resolve(PROMPT_ABORTED);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		// 用事件驱动而不是轮询：answer/cancel 指令都会唤醒 nextCommand。
		void (async () => {
			try {
				for (;;) {
					const command = await nextCommand();
					if (!command) {
						// 宿主断开：按取消处理，交给上层走取消收尾。
						reject(new Error("PiDeck auth host: host closed the connection"));
						return;
					}
					if (command.cmd === "cancel") {
						// 既要中止提问，也要中止整个流程：pi 侧的回调服务器/设备码轮询
						// 都挂在本流程的 signal 上，只 reject 提问会留下后台网络活动。
						abortActive("host cancelled while prompting");
						reject(new Error("Login cancelled"));
						return;
					}
					if (command.cmd !== "answer") {
						log(`ignoring unexpected command while prompting: ${command.cmd}`);
						continue;
					}
					// 旧提问的迟到答案直接丢弃：弹框重开后 id 会变。
					if (command.id !== undefined && command.id !== id) {
						log(`ignoring stale answer for prompt ${command.id} (waiting for ${id})`);
						continue;
					}
					if (settled) return;
					settled = true;
					resolve(command.value === undefined ? "" : String(command.value));
					return;
				}
			} catch (error) {
				reject(error);
			}
		})();
	}).finally(() => signal?.removeEventListener("abort", onAbort));
}

// ---------------------------------------------------------------------------
// 供应商列表
// ---------------------------------------------------------------------------

/**
 * 把 pi 的供应商描述折成宿主可渲染的形状。
 *
 * - `oauth` / `apiKey` 只暴露给用户看的名字，`login` 实现（函数）不跨进程传。
 * - OAuth 优先用 `loginLabel`（如 "Sign in with Kimi Code"），退回 `name`。
 * - apiKey 无 `login` 说明只能用环境变量/AWS profile 之类的外部凭据，
 *   标记 `ambientOnly`，宿主不给它「录入密钥」入口。
 * - 完全没有认证方式的供应商（云端网关类）无法登录，直接过滤掉。
 * - `builtIn` 标记这条来自 pi 内置目录（而非 `models.json` 里用户自定义的供应商），
 *   由宿主决定要不要展示——助手只报告事实，不做产品取舍。
 */
function describeProvider(runtime, provider, builtinIds) {
	const oauth = provider.auth?.oauth;
	const apiKey = provider.auth?.apiKey;
	if (!oauth && !apiKey) return null;
	const status = runtime.getProviderAuthStatus(provider.id);
	const credential = status?.configured ? { type: runtime.isUsingOAuth(provider.id) ? "oauth" : "api_key" } : undefined;
	return {
		id: provider.id,
		name: provider.name,
		oauth: oauth ? { label: oauth.loginLabel ?? oauth.name, isSubscription: oauth.isSubscription === true } : undefined,
		apiKey: apiKey ? { name: apiKey.name, canLogin: typeof apiKey.login === "function" } : undefined,
		ambientOnly: Boolean(apiKey) && typeof apiKey.login !== "function",
		credential,
		// 判定不出来时不写该字段（JSON 会丢掉 undefined），宿主按「未知=保留」处理。
		builtIn: builtinIds ? builtinIds.has(provider.id) : undefined,
	};
}

/**
 * pi 内置支持的供应商 id 集合。
 *
 * 为什么需要：`runtime.getProviders()` 是「pi 内置目录 + `models.json` 自定义供应商」
 * 的合并结果，自定义项的认证描述由 pi 兜底合成（`apiKey.name` 恒为 "API key"），
 * 混在登录列表里既没有信息量（密钥早在模型设置里填过），又会淹掉真正可登录的项。
 *
 * `defaultBuiltins` 是 pi 运行时上的普通字段（不是 #private），但毕竟属于内部结构，
 * 因此取不到时返回 null 让宿主保持旧行为（多显示）而不是把列表清空；
 * `getRegisteredProviderIds()` 是公开方法，扩展注册的认证供应商同样算 pi 支持。
 */
function collectBuiltinProviderIds(runtime) {
	const ids = new Set();
	const defaults = runtime.defaultBuiltins;
	if (defaults && typeof defaults.keys === "function") {
		for (const id of defaults.keys()) ids.add(id);
	}
	if (typeof runtime.getRegisteredProviderIds === "function") {
		for (const id of runtime.getRegisteredProviderIds()) ids.add(id);
	}
	return ids.size > 0 ? ids : null;
}

async function handleList(runtime) {
	const builtinIds = collectBuiltinProviderIds(runtime);
	const providers = runtime
		.getProviders()
		.map((provider) => describeProvider(runtime, provider, builtinIds))
		.filter(Boolean)
		.sort((a, b) => a.name.localeCompare(b.name));
	send({ type: "providers", providers, piVersion: sdkVersion });
}

// ---------------------------------------------------------------------------
// 登录 / 登出
// ---------------------------------------------------------------------------

/** 当次操作的取消开关；宿主发 cancel 或进程收到退出信号时触发。 */
let activeAbort = null;

function makeInteraction() {
	let promptId = 0;
	return {
		get signal() {
			return activeAbort?.signal;
		},
		notify(event) {
			// AuthEvent 已经是纯数据，原样透传；宿主只负责渲染。
			send({ type: "event", event });
		},
		async prompt(prompt) {
			const id = `p${++promptId}`;
			send({
				type: "prompt",
				id,
				prompt: {
					kind: prompt.type,
					message: prompt.message,
					placeholder: prompt.placeholder,
					options: prompt.type === "select" ? prompt.options : undefined,
				},
			});
			const answer = await answerPrompt(id, prompt);
			if (isPromptAborted(answer)) {
				// pi 期望 prompt() 在被取消时 reject；这里的调用方会把这个
				// 错误连同「流程已结束」一起处理，不再向上抛。
				throw new Error("Login prompt cancelled");
			}
			return answer;
		},
	};
}

async function handleLogin(runtime, command) {
	const providerId = command.providerId;
	const type = command.type === "api_key" ? "api_key" : "oauth";
	const provider = runtime.getProvider(providerId);
	if (!provider) {
		send({ type: "result", ok: false, cancelled: false, command: "login", providerId, error: { message: `Unknown provider: ${providerId}`, kind: "unknown-provider" } });
		return;
	}
	if (type === "oauth" && !provider.auth?.oauth) {
		send({ type: "result", ok: false, cancelled: false, command: "login", providerId, error: { message: `Provider ${providerId} has no subscription login`, kind: "unsupported" } });
		return;
	}
	if (type === "api_key" && !provider.auth?.apiKey?.login) {
		send({ type: "result", ok: false, cancelled: false, command: "login", providerId, error: { message: `Provider ${providerId} can only use ambient credentials`, kind: "unsupported" } });
		return;
	}

	activeAbort = new AbortController();
	const interaction = makeInteraction();
	try {
		await runtime.login(providerId, type, interaction);
		send({ type: "result", ok: true, cancelled: false, command: "login", providerId });
	} catch (error) {
		const cancelled = activeAbort.signal.aborted;
		send({
			type: "result",
			ok: false,
			cancelled,
			command: "login",
			providerId,
			error: cancelled ? undefined : { message: error instanceof Error ? error.message : String(error), kind: "login-failed" },
		});
	} finally {
		activeAbort = null;
	}
}

async function handleLogout(runtime, command) {
	try {
		await runtime.logout(command.providerId);
		send({ type: "result", ok: true, cancelled: false, command: "logout", providerId: command.providerId });
	} catch (error) {
		send({
			type: "result",
			ok: false,
			cancelled: false,
			command: "logout",
			providerId: command.providerId,
			error: { message: error instanceof Error ? error.message : String(error), kind: "logout-failed" },
		});
	}
}

/** 宿主取消：中止当前登录并把结果交回宿主，保持一次操作一个 result。 */
function abortActive(reason) {
	if (!activeAbort) return false;
	log(`aborting active operation: ${reason}`);
	activeAbort.abort();
	return true;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
	let ModelRuntime;
	let VERSION;
	try {
		({ ModelRuntime, VERSION } = await import(`file:///${sdkEntry.replace(/\\/g, "/")}`));
		sdkVersion = typeof VERSION === "string" ? VERSION : null;
	} catch (error) {
		fatal("sdk-load", error instanceof Error ? error.message : String(error));
		return;
	}

	let runtime;
	try {
		// 不传任何覆盖项：让 pi 自己按它的配置目录解析 auth.json，保证登录结果
		// 与后续 pi 进程读到的是同一份凭据（宿主只负责传入同一套环境变量）。
		runtime = await ModelRuntime.create({});
	} catch (error) {
		fatal("runtime-create", error instanceof Error ? error.message : String(error));
		return;
	}

	send({ type: "ready", protocolVersion: PROTOCOL_VERSION, piVersion: sdkVersion });

	for (;;) {
		const command = await nextCommand();
		if (!command) {
			log("stdin closed, exiting");
			return;
		}
		switch (command.cmd) {
			case "list":
				await handleList(runtime);
				break;
			case "login":
				await handleLogin(runtime, command);
				break;
			case "logout":
				await handleLogout(runtime, command);
				break;
			case "cancel":
				// 没有进行中的操作时，取消等于「这次会话不需要了」。
				if (!abortActive("host requested cancel")) return;
				break;
			default:
				fatal("protocol", `unknown command: ${command.cmd}`);
				return;
		}
	}
}

process.on("SIGTERM", () => {
	abortActive("SIGTERM");
	process.exit(0);
});
process.on("SIGINT", () => {
	abortActive("SIGINT");
	process.exit(0);
});

if (!sdkEntry) {
	fatal("startup", "PIDECK_PI_SDK_ENTRY is not set");
} else {
	createInterface({ input: process.stdin })
		.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				dispatch(JSON.parse(trimmed));
			} catch (error) {
				log(`ignoring unparseable line: ${error instanceof Error ? error.message : String(error)}`);
			}
		})
		.on("close", () => {
			log("stdin closed");
			dispatch(null);
		});
	await main();
}
