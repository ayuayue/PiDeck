/**
 * Mock pi（#115 U6 / #113 3.2 会话路径 E2E）：
 * 实现桌面端依赖的最小 stdio JSONL RPC 子集，让 E2E 可以在不安装真实 pi、
 * 不访问网络的前提下跑「新建会话 → 发送 → 流式渲染 → 停止」完整链路。
 *
 * 协议（与 src/main/pi/PiRpcClient.ts 对齐）：
 * - 输入：每行一个 JSON 命令，带 { type, id, ... }
 * - 响应：{ type: "response", id, command, success, data?, error? }
 * - 事件：无 id 的 JSON 对象（agent_start / message_start / message_update /
 *   message_end / agent_end / agent_settled ...）
 *
 * 行为：
 * - prompt：立即 success，然后以 ~80ms 间隔流式输出 12 个 text_delta，
 *   文本为 "Mock 回复：「<消息>」"；prompt 含 "SLOW" 时放慢到 220ms×18，
 *   便于稳定地在中途点击「停止」。
 * - abort：立即 success；取消进行中的流，发 agent_end + agent_settled。
 * - 其它命令一律 success（桌面端对未知字段宽容），避免误报错误气泡。
 */
"use strict";

// 健康检查路径：桌面端环境检测会对 customPiPath 执行 `--version`（PiLocator），
// 需要可解析的版本输出，否则检测失败、应用进入安装向导而不是欢迎页。
if (process.argv.includes("--version")) {
	process.stdout.write("0.99.0-mock\n");
	process.exit(0);
}

// 模型列表：桌面端模型选择器通过 `pi --list-models` 文本表格获取候选
//（modelListCache.parsePiListModels，无需启动 agent），列序：
// provider  model  context  max-out  thinking  images
if (process.argv.includes("--list-models")) {
	process.stdout.write(
		"provider  model           context  max-out  thinking  images\n" +
		"mock      mock-model      128000   8192     yes       no\n" +
		"mock      mock-model-pro  256000   8192     yes       no\n",
	);
	process.exit(0);
}

const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

// 调试：记录收到的命令/发出的响应，便于排查 E2E 状态不同步问题
const LOG_PATH = path.join(require("node:os").tmpdir(), `mock-pi-${process.pid}.log`);
function log(direction, payload) {
	try {
		fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
		fs.appendFileSync(LOG_PATH, `${direction} ${JSON.stringify(payload)}\n`);
	} catch { /* 日志失败不影响协议 */ }
}

// sessionId 按 cwd 稳定哈希：重启 Agent（杀进程重 spawn）后桌面端期望
// 同一会话文件被重新接管（#113 3.2-6 续聊语义），不能按时间乱变。
const crypto = require("node:crypto");
const sessionId =
	"mock-" + crypto.createHash("md5").update(process.cwd()).digest("hex").slice(0, 10);
// 桌面端 resume 历史会话时会传 --session <path>（PiProcess.start:305 → finalPiArgs.push("--session", sessionPath)）。
// 真实 pi 会加载该文件续写；mock 必须同样尊重它，否则「未启动会话重发」会在 mock 自己的
// mock-<hash>.jsonl 里另起炉灶，丢掉截断前保留的历史（编辑后的首轮回复从时间线消失）。
const sessionArgIndex = process.argv.indexOf("--session");
const resumeSessionPath =
	sessionArgIndex >= 0 && process.argv[sessionArgIndex + 1] ? process.argv[sessionArgIndex + 1] : null;
// 模型/思考级别有状态跟踪：桌面端 set_model/set_thinking_level 后会重新
// get_state 拉取（AgentManager.getRuntimeState），mock 必须返回更新后的值。
const MODELS = [
	{ provider: "mock", id: "mock-model", name: "Mock Model", contextWindow: 128000, reasoning: true },
	{ provider: "mock", id: "mock-model-pro", name: "Mock Model Pro", contextWindow: 256000, reasoning: true },
];
let currentModel = MODELS[0];
let currentThinking = "medium";
// 上下文占比：初始 45% ≥ 30% 门槛，圆环面板压缩按钮可点；compact 成功后降到 12%，
// 按钮应变为「暂无需压缩」禁用态。
let contextPercent = 45;
// 记录收到的用户 prompt：fork 用例的 get_fork_messages 按文本匹配 entryId。
const userPrompts = [];
// 内存消息列表：get_messages 在 fork/reload 后需要返回真实对话，
// 否则 refreshRuntimeAfterSessionReplacement 会把时间线清空。
const conversationMessages = [];
/** 把 cwd 编码成 pi sessions 目录名（与 SessionScanner.decodeSessionDir 对偶） */
function encodeSessionDir(cwd) {
	const norm = path.resolve(cwd).replace(/\\/g, "/");
	if (/^[A-Za-z]:/.test(norm)) {
		const drive = norm[0].toUpperCase();
		const rest = norm.slice(2).replace(/^\//, "").replace(/\//g, "-");
		return `--${drive}--${rest}--`;
	}
	return `--${norm.replace(/^\//, "").replace(/\//g, "-")}--`;
}

// 会话文件双写：
// 1) tmp 路径作为 get_state.sessionFile（fork/reattach 原语义，不绑项目路径）
// 2) 项目 cwd/.pi/sessions 镜像，SessionScanner 扫历史（#113 3.2-9）
let sessionFile = resumeSessionPath;
let sessionHeaderWritten = false;
const TMP_SESSION_FILE_PATH = path.join(require("node:os").tmpdir(), sessionId + ".jsonl");
const PROJECT_SESSIONS_DIR = path.join(process.cwd(), ".pi", "sessions");
const PROJECT_SESSION_FILE_PATH = path.join(PROJECT_SESSIONS_DIR, sessionId + ".jsonl");
function ensureSessionFile() {
	if (sessionFile) return;
	try {
		fs.writeFileSync(TMP_SESSION_FILE_PATH, "", { flag: "a" });
		fs.mkdirSync(PROJECT_SESSIONS_DIR, { recursive: true });
		const settingsPath = path.join(process.cwd(), ".pi", "settings.json");
		if (!fs.existsSync(settingsPath)) {
			fs.writeFileSync(settingsPath, JSON.stringify({ sessionDir: ".pi/sessions" }, null, 2));
		}
		fs.writeFileSync(PROJECT_SESSION_FILE_PATH, "", { flag: "a" });
	} catch { /* 写失败仅影响 fork/历史恢复类用例 */ }
	sessionFile = TMP_SESSION_FILE_PATH;
}
// 重启后的新进程：tmp 文件已存在则恢复 sessionFile（桌面端 reattach 语义）。
// resume 模式下 sessionFile 已指向 --session 传入的文件，不能被残留的 tmp 文件覆盖。
if (!resumeSessionPath && fs.existsSync(TMP_SESSION_FILE_PATH)) {
	sessionFile = TMP_SESSION_FILE_PATH;
	try { sessionHeaderWritten = fs.statSync(TMP_SESSION_FILE_PATH).size > 0; } catch { /* ignore */ }
}
// 启动即落盘：get_state 必须返回真实 sessionFile，桌面端才会给 catalog 记录 attach
// filePath（canAttachRuntimeMetadata），会话才走「有文件」的编辑/删除/重发路径而非匿名路径。
// 旧实现等首次 prompt 才建文件，spawn 时 get_state 返回 undefined，整个会话被当成匿名。
ensureSessionFile();
let streamTimer = null;
let streamStep = 0;
let streamChunks = [];
let streamIntervalMs = 80;
let streaming = false;
// steer/followUp 中途到达的 prompt 排队串行处理：真实 pi 也是单 run 语义，
// 桌面端排队用例依赖「先到的先答、后到的接着答」的顺序性。
const pendingPrompts = []; // { text, streamingBehavior }
// 真实 pi 的 steer 语义（pi-coding-agent dist/core/agent-session.js + bundle runLoop）：
// 流式中 prompt 带 streamingBehavior=steer → _queueSteer 入 steeringQueue；当前 run 的
// 工具循环结束后 runLoop 在同一 run 内 drain 队列：先 emit message_start(user)+
// message_end(user)，再继续下一次 LLM 调用；整轮 _runAgentPrompt 完成才发一次
// agent_end，其 finally 才发一次 agent_settled。因此 steer 队列非空时，run A 与 run B
// 之间没有 agent_end/agent_settled 间隔（渲染层 isRuntimeBusy 全程 true）。
// mock 旧行为是 pendingPrompts 串行排队（每轮独立 agent_end+settled），与真实语义
// 差异即「steer 打断轮无 settled/无 run 边界」——steer 相关用例需要它。

// ── Ask 模拟（E2E：ask-ui.spec.ts）──
// prompt 含 ASK_* 标记时，先发 extension_ui_request（桌面端渲染提问卡片），
// 挂起等待 extension_ui_response 后再流式回复（回复包含用户答案，供断言结果正确）。
const ASK_MARKERS = {
	ASK_SELECT: { method: "select", title: "请选择操作", options: ["选项A", "选项B"], allowOther: false },
	ASK_SELECT_CUSTOM: { method: "select", title: "请选择或输入", options: ["选项A", "选项B"], allowOther: true },
	ASK_SELECT_NOOPTS: { method: "select", title: "无选项提问（应降级为输入）", options: [] },
	ASK_CONFIRM: { method: "confirm", title: "确认继续吗？" },
	ASK_INPUT: { method: "input", title: "请输入你的名字", placeholder: "例如：张三" },
	ASK_EDITOR: { method: "editor", title: "请写下修改意见", placeholder: "多行内容" },
	ASK_BATCH: { method: "input", title: JSON.stringify({ __piDeckBatchAsk: 1, questions: [
		{ id: "b1", type: "select", question: "选择框架", options: ["React", "Vue"] },
		{ id: "b2", type: "confirm", question: "使用 TypeScript？" },
		{ id: "b3", type: "input", question: "项目名", placeholder: "my-app" },
	] }) },
};
let pendingAsk = null; // { requestId, method, title, marker }
let askAnswerLog = []; // 记录每次 ask 的答案，供 E2E 主进程侧断言

function emitAsk(marker, markerConfig) {
	const requestId = "ask-" + (nextEntrySeq++);
	pendingAsk = { requestId, method: markerConfig.method, marker };
	emit({
		type: "extension_ui_request",
		id: requestId,
		method: markerConfig.method,
		title: markerConfig.title,
		...(markerConfig.options ? { options: markerConfig.options } : {}),
		...(markerConfig.placeholder ? { placeholder: markerConfig.placeholder } : {}),
		...(markerConfig.prefill ? { prefill: markerConfig.prefill } : {}),
		...(markerConfig.allowOther !== undefined ? { allowOther: markerConfig.allowOther } : {}),
	});
}

function handleAskResponse(payload) {
	if (!pendingAsk || payload.id !== pendingAsk.requestId) return;
	const { requestId, marker } = pendingAsk;
	pendingAsk = null;
	const answer = payload.value !== undefined ? String(payload.value) : payload.cancelled ? "[取消]" : "[空]";
	askAnswerLog.push({ requestId, marker, answer, confirmed: payload.confirmed ?? undefined });
	// 答案拼进回复（raw 模式不截断），E2E 通过会话文本断言「点击选项 → 结果正确」
	startStream(`你选择了「${marker}」，答案：${answer}`, { raw: true });
}

function send(payload) {
	log(">", payload);
	process.stdout.write(JSON.stringify(payload) + "\n");
}

function respond(cmd, data) {
	send({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
}

/** compact nothing-to-do 等失败路径：success:false + error 文案，桌面端映射友好 toast */
function respondFail(cmd, error) {
	send({ type: "response", id: cmd.id, command: cmd.type, success: false, error });
}

// SessionHistoryReader 沿 parentId 回溯活动分支；每条 entry 必须有稳定 id。
let nextEntrySeq = 1;
let lastEntryId = null;

// 跨进程续接：重启后的新进程（重发/重启 Agent 会 spawn 新进程）必须从既有文件
// 恢复条目序号与 leaf，否则新写入的 entry 会复用 e1/e2 等旧 id——与文件头/旧消息
// 撞 id，SessionHistoryReader 的 byId 索引错乱，活动分支投影残缺（重发后时间线
// 回退成只有第一轮）。resume（--session）时读的是截断/编辑后的真实文件，同样适用。
if (sessionFile && fs.existsSync(sessionFile)) {
	try {
		const content = fs.readFileSync(sessionFile, "utf8");
		let maxSeq = 0;
		for (const rawLine of content.split("\n")) {
			const trimmed = rawLine.trim();
			if (!trimmed) continue;
			try {
				const entry = JSON.parse(trimmed);
				if (entry.type === "session") sessionHeaderWritten = true;
				if (typeof entry.id === "string") {
					const match = /^e(\d+)$/.exec(entry.id);
					if (match) maxSeq = Math.max(maxSeq, Number(match[1]));
					// 活动分支 leaf = 最后一条「非墓碑」记录；deleted 行（删除/resend 截断）
					// 不在父链上，新写入的 user 消息不能 parent 到它们。
					if (entry.type !== "deleted") lastEntryId = entry.id;
				}
				// 重建内存对话：get_messages 在 fork/reload 后要返回既有历史（对齐真实 pi 的 resume）。
				if (entry.type === "message" && entry.message) {
					const role = entry.message.role;
					if (role === "user" || role === "assistant") {
						const text = Array.isArray(entry.message.content)
							? entry.message.content
								.filter((b) => b && b.type === "text")
								.map((b) => b.text)
								.join("")
							: (entry.message.content ?? "");
						if (text) {
							conversationMessages.push({ role, content: [{ type: "text", text }] });
						}
					}
				}
			} catch { /* 单行损坏跳过 */ }
		}
		if (maxSeq > 0) nextEntrySeq = maxSeq + 1;
	} catch { /* 读失败保持默认序号 */ }
}

/** 把对话写成可被 SessionHistoryReader 分页读取的真实 JSONL（#113 3.2-9） */
function appendSessionMessages(userText, assistantText) {
	ensureSessionFile();
	if (!sessionFile) return;
	const now = Date.now();
	const lines = [];
	if (!sessionHeaderWritten) {
		const headerId = `e${nextEntrySeq++}`;
		lines.push(JSON.stringify({
			// 文件头必须是 type "session"：SessionFileEditor 以此统计 header
			//（type "session_info" 只是追加的改名记录，头用它会报「found 0 headers」）。
			type: "session",
			version: 3,
			id: headerId,
			parentId: null,
			name: userText.slice(0, 40) || "mock session",
			cwd: process.cwd(),
			timestamp: new Date(now).toISOString(),
		}));
		lastEntryId = headerId;
		sessionHeaderWritten = true;
	}
	const userParent = lastEntryId;
	const userId = `e${nextEntrySeq++}`;
	lines.push(JSON.stringify({
		type: "message",
		id: userId,
		parentId: userParent,
		timestamp: new Date(now).toISOString(),
		message: { role: "user", content: [{ type: "text", text: userText }] },
	}));
	const assistantId = `e${nextEntrySeq++}`;
	lines.push(JSON.stringify({
		type: "message",
		id: assistantId,
		parentId: userId,
		timestamp: new Date(now + 1).toISOString(),
		message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
	}));
	lastEntryId = assistantId;
	const payload = lines.join("\n") + "\n";
	// 双写：tmp（runtime sessionFile）+ 项目 sessions（历史扫描）。
	// resume 模式下 sessionFile 已在项目 sessions 目录（--session 指向），
	// 项目镜像就是同一文件，再写一次会把整段对话重复一遍。
	try { fs.appendFileSync(sessionFile, payload); } catch { /* ignore */ }
	if (PROJECT_SESSION_FILE_PATH !== sessionFile) {
		try {
			fs.mkdirSync(PROJECT_SESSIONS_DIR, { recursive: true });
			fs.appendFileSync(PROJECT_SESSION_FILE_PATH, payload);
		} catch { /* ignore */ }
	}
}

function emit(event) {
	send(event);
}

function stopStream(settled) {
	if (streamTimer) {
		clearTimeout(streamTimer);
		streamTimer = null;
	}
	if (settled) {
		emit({ type: "agent_end", messages: [] });
		emit({ type: "agent_settled" });
	}
}

function startStream(userText, options = {}) {
	streaming = true;
	const slow = userText.includes("SLOW");
	streamIntervalMs = slow ? 220 : 80;
	// BURST 模式：模拟真实 LLM 突发输出——前 6 个 chunk 慢速（250ms），
	// 之后 15ms 密集推送（复现「开头吐字、后面蹦字」）。
	const burst = userText.includes("BURST");
	// prompt 含 "MDEMO" 时回复富 markdown，用于截图巡检渲染元素（链接/代码/表格/引用）
	// raw 模式（Ask 回答回显）：不套模板、不截断，保证长 JSON 答案完整回传
	const reply = options.raw
		? userText
		: userText.includes("BURST")
		? "Mock 回复：「BURST」" +
		  "第一段缓慢吐字节奏稳定，然后密集输出段以极快速度连续推送多字符用于复现真实模型突发输出导致的蹦字现象，这段文本会在一两百毫秒内一次性灌入渲染层。"
		: userText.includes("LONG")
		? "Mock 回复：「LONG」" +
		  Array.from({ length: 120 })
			.map((_, i) => `第 ${i + 1} 行：长回答示例文本，用于撑高时间线高度（滚动/贴底类用例需要内容溢出视口）。`)
			.join("\n")
		: userText.includes("MDEMO")
		? [			"以下是渲染元素巡检：",
			"",
			"修改了 src/main/index.ts 和 ./docs/ui-2.0-revamp-plan.md，详见 https://github.com/miaojingang/pi-desktop 。",
			"",
			"> 引用块：重构期间禁止静默吞掉对方改动，每个冲突都要确认能力归属。",
			"",
			"行内代码 `npm run typecheck` 必须通过。",
			"",
			"```ts",
			"const gate = await runTypecheck();",
			"if (!gate.ok) throw new Error(\"typecheck failed\");",
			"```",
			"",
			"| 批次 | 状态 | 说明 |",
			"| --- | --- | --- |",
			"| U2 | ✅ | Streamdown 渲染管线 |",
			"| U5 | ✅ | 组件清扫 |",
			"",
			"```mermaid",
			"graph LR",
			"  A[启动] --> B{校验}",
			"  B -->|通过| C[执行]",
			"  B -->|失败| D[报错]",
			"  C --> E[结束]",
			"```",
			"",
			"行内公式 $x^2 + y^2 = z^2$ 与块级公式：",
			"",
			"$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$",
		].join("\n")
		: `Mock 回复：「${userText.slice(0, 40)}」流式渲染验证完成。`;
	const chunkCount = slow ? 18 : burst ? 24 : 12;
	const per = Math.max(1, Math.ceil(reply.length / chunkCount));
	streamChunks = [];
	for (let i = 0; i < reply.length; i += per) streamChunks.push(reply.slice(i, i + per));
	streamStep = 0;

	emit({ type: "agent_start" });
	emit({
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "" }] },
	});

	// 思考/工具帧模拟（E2E：web-service.spec.ts 断言 reasoning/tool 卡片渲染）：
	// - 含 "THINK" 的 prompt 先推 thinking_delta，WebEventStream 翻译为 reasoning 帧
	// - 含 "TOOL" 的 prompt 推 tool_execution_start/end，翻译为 tool-input/output 帧
	if (userText.includes("THINK")) {
		const thoughts = ["推理：先分析文件结构...", "推理：再定位目标函数。"];
		for (const delta of thoughts) {
			emit({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "" }] },
				assistantMessageEvent: { type: "thinking_delta", delta },
			});
		}
	}
	if (userText.includes("TOOL")) {
		emit({
			type: "tool_execution_start",
			toolName: "bash",
			toolCallId: "tool-e2e-1",
			args: { command: "ls" },
		});
		emit({ type: "tool_execution_end", toolCallId: "tool-e2e-1" });
	}

	// BURST 模式：模拟真实 LLM 突发输出——前 6 个 chunk 慢速（250ms），
	// 之后 15ms 密集推送（复现「开头吐字、后面蹦字」）。
	const chunkDelay = (step) => (burst ? (step < 6 ? 250 : 15) : streamIntervalMs);
	// 真实 pi runLoop（bundle）：一轮 turn 结束后在**同一 run 内**检查 steeringQueue：
	// 有 steer 则先 emit message_start(user)+message_end(user)，再继续下一轮 LLM 调用；
	// 整轮 runPromptMessages 全部结束才发一次 agent_end，_runAgentPrompt 的 finally 才发
	// agent_settled。因此 steer 插入时 run A 与 run B 之间**没有** agent_end/agent_settled。
	const drainSteerMessagesIntoRun = () => {
		const steerIndex = pendingPrompts.findIndex((p) => p.streamingBehavior === "steer");
		if (steerIndex < 0) return false;
		const [queued] = pendingPrompts.splice(steerIndex, 1);
		const userContent = [{ type: "text", text: queued.text }];
		emit({ type: "message_start", message: { role: "user", content: userContent } });
		emit({ type: "message_end", message: { role: "user", content: userContent } });
		conversationMessages.push({ role: "user", content: userContent });
		// run B 继续流式（agent_start 是 mock 简化：真实 pi 同 run 内无 agent_start；
		// 桌面端把 agent_start 当 running，此时已 running，无行为差异）
		streaming = false;
		startStream(queued.text);
		return true;
	};
	const emitChunk = () => {
		if (streamStep >= streamChunks.length) {
			streamTimer = null;
			const full = {
				role: "assistant",
				content: [{ type: "text", text: reply }],
				stopReason: "stop",
			};
			appendSessionMessages(userText, reply);
			conversationMessages.push(
				{ role: "user", content: [{ type: "text", text: userText }] },
				{ role: "assistant", content: [{ type: "text", text: reply }] },
			);
			emit({ type: "message_end", message: full });
			// steer 队列非空：同 run 继续（无 agent_end/agent_settled 间隔）
			if (drainSteerMessagesIntoRun()) return;
			streaming = false;
			emit({ type: "agent_end", messages: [full] });
			emit({ type: "agent_settled" });
			// followUp/剩余排队：settled 之后的独立新 run（真实 followUp 语义）
			const next = pendingPrompts.shift();
			if (next !== undefined) startStream(next.text);
			return;
		}
		const accumulated = streamChunks.slice(0, streamStep + 1).join("");
		emit({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: accumulated }] },
			assistantMessageEvent: { type: "text_delta", delta: streamChunks[streamStep] },
		});
		streamStep += 1;
		streamTimer = setTimeout(emitChunk, chunkDelay(streamStep));
	};
	streamTimer = setTimeout(emitChunk, chunkDelay(0));
}

function handleCommand(cmd) {
	switch (cmd.type) {
		case "get_state":
			respond(cmd, {
				sessionId,
				sessionName: "Mock Agent",
				sessionFile: sessionFile ?? undefined,
				model: currentModel,
				thinkingLevel: currentThinking,
			});
			return;
		case "get_messages":
			respond(cmd, { messages: conversationMessages.slice() });
			return;
		case "get_entries":
			respond(cmd, { entries: [] });
			return;
		case "get_session_stats":
			respond(cmd, { tokens: { input: 100, output: 50 }, contextUsage: { percent: contextPercent } });
			return;
		case "get_available_models":
			respond(cmd, { models: MODELS });
			return;
		case "set_model": {
			const found = MODELS.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);
			if (found) currentModel = found;
			respond(cmd, { model: currentModel });
			return;
		}
		case "set_thinking_level":
			currentThinking = typeof cmd.level === "string" ? cmd.level : currentThinking;
			respond(cmd, {});
			return;
		case "cycle_thinking_level": {
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
			const idx = levels.indexOf(currentThinking);
			currentThinking = levels[(idx + 1) % levels.length];
			respond(cmd, {});
			return;
		}
		case "prompt": {
			// 先回 success（桌面端据此认为已受理），再异步推流
			respond(cmd, {});
			const text = typeof cmd.message === "string" ? cmd.message : "";
			ensureSessionFile();
			if (text) userPrompts.push(text);
			// Ask 模拟：命中 ASK_* 标记 → 发提问卡片并挂起，等用户回答后再流式。
			// 最长标记优先匹配（ASK_SELECT_NOOPTS 不能先命中前缀 ASK_SELECT）
			const askMarker = Object.keys(ASK_MARKERS)
				.filter((key) => text.includes(key))
				.sort((left, right) => right.length - left.length)[0];
			if (askMarker) {
				emitAsk(askMarker, ASK_MARKERS[askMarker]);
				return;
			}
			// CRASH 模拟（E2E：崩溃后消息编辑/删除场景）：先推一个 chunk 再异常退出，
			// 不发送 agent_end/agent_settled（真实异常中断语义）；桌面端应识别进程退出
			// 并清理 runtime，后续历史操作走「无 runtime 直接改文件」路径。
			if (text.includes("CRASH")) {
				streaming = true;
				emit({ type: "agent_start" });
				emit({
					type: "message_start",
					message: { role: "assistant", content: [{ type: "text", text: "" }] },
				});
				setTimeout(() => {
					emit({
						type: "message_update",
						message: { role: "assistant", content: [{ type: "text", text: "崩溃前最后输出" }] },
						assistantMessageEvent: { type: "text_delta", delta: "崩溃前最后输出" },
					});
					setTimeout(() => process.exit(1), 80);
				}, 80);
				return;
			}
			if (streaming) {
				// 真实 pi：流式中 prompt 带 streamingBehavior=steer 时入 steeringQueue，
				// 由当前 run 的工具循环结束后 drain 并同 run 内投递；不带时按旧顺序排队。
				pendingPrompts.push({ text, streamingBehavior: cmd.streamingBehavior });
			} else {
				startStream(text);
			}
			return;
		}
		case "compact":
			// prompt 含 NOTHING 时走失败路径：success:false + "nothing to compact"，
			// 桌面端映射 app.compactNothingToDo 友好 toast（#113 3.2-7）。
			if (typeof cmd.prompt === "string" && cmd.prompt.includes("NOTHING")) {
				respondFail(cmd, "nothing to compact");
				return;
			}
			// 模拟 pi 压缩事件序列：compaction_start → RPC success → compaction_end
			// → agent_settled。桌面端据此 running → 重载消息 → idle；
			// compaction_end 触发 emitRuntimeState，占比下降后压缩按钮禁用。
			emit({ type: "compaction_start", reason: "manual" });
			setTimeout(() => {
				respond(cmd, {});
				contextPercent = 12;
				setTimeout(() => {
					emit({ type: "compaction_end", reason: "manual" });
					emit({ type: "agent_settled" });
				}, 150);
			}, 100);
			return;
		case "get_fork_messages":
			respond(cmd, {
				messages: userPrompts.map((text, i) => ({ entryId: `entry-${i + 1}`, text })),
			});
			return;
		case "fork": {
			const found = userPrompts.find((_, i) => `entry-${i + 1}` === cmd.entryId);
			// 桌面端读取 result.text 预填回输入框；cancelled 为空对象语义
			respond(cmd, { text: found ?? "" });
			return;
		}
		case "abort":
			respond(cmd, {});
			pendingPrompts.length = 0;
			streaming = false;
			stopStream(true);
			return;
		default:
			// set_model / set_thinking_level / cycle_* / set_session_name /
			// compact / bash / export_html / clone / fork / switch_session ...
			respond(cmd, {});
	}
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let cmd;
	try {
		cmd = JSON.parse(trimmed);
	} catch {
		return; // 非 JSON 输入直接忽略（桌面端也只记录 protocol-error）
	}
	try {
		const parsed = JSON.parse(trimmed);
		// 桌面端发送的 Ask 回答（extension_ui_response 协议）
		if (parsed && parsed.type === "extension_ui_response") {
			handleAskResponse(parsed);
			return;
		}
		log("<", cmd);
		handleCommand(parsed);
	} catch (error) {
		// 命令处理异常不能击穿进程：桌面端依赖进程存活性判断
		send({
			type: "response",
			id: cmd.id,
			command: cmd.type,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
});

// 保持进程存活；父进程杀死时自然退出
process.stdin.on("end", () => process.exit(0));
