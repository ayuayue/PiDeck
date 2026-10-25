/**
 * A1 vanilla 兜底页模板（从 WebServiceManager.renderPage 迁出）。
 *
 * 这条路径服务于「前端静态产物不可用」时的降级体验（首次打开 Web 服务、
 * dev 代理未起、bundle 缺失）。模板是纯字符串拼接，不依赖 manager 状态，
 * 迁出后仍由 serveRenderer 在 ?view=legacy 与静态产物缺失时调用。
 */
import { serializeWebClientDictionaries } from "./WebI18n";

export function renderLegacyWebPage(): string {
	return `<!doctype html>
<html lang="en-US">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
	<link rel="manifest" href="/manifest.webmanifest" />
	<meta name="theme-color" content="#18181b" />
	<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
	<title>PiDeck Web Service</title>
	<style>
		:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		body { margin: 0; background: #f4f6f8; color: #252a31; }
		.app { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 100vh; }
		aside { border-right: 1px solid #dfe5ee; background: #fff; padding: 16px; overflow: auto; }
		main { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
		header { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 18px; border-bottom: 1px solid #dfe5ee; background: #fff; }
		h1 { margin: 0; font-size: 16px; }
		.status { font-size: 12px; color: #687280; }
		.list { display: grid; gap: 8px; }
		button { border: 1px solid #d7dce4; background: #fff; border-radius: 8px; padding: 8px 10px; color: #252a31; cursor: pointer; transition: transform .12s ease, border-color .12s ease, background .12s ease, opacity .12s ease; }
		button:hover:not(:disabled) { transform: translateY(-1px); border-color: #b8c2d0; }
		button.primary { border-color: #14a514; background: #14a514; color: #fff; min-width: 88px; font-weight: 700; }
		button.primary:hover:not(:disabled) { background: #129212; border-color: #129212; }
		button.danger { color: #d93025; border-color: #f1b9b9; background: #fff7f7; }
		button.ghost { color: #687280; background: #f8fafc; }
		.header-actions { display: flex; align-items: center; gap: 8px; }
		.header-actions button { height: 34px; padding: 0 12px; }
		button:disabled { opacity: .6; cursor: not-allowed; }
		.item { text-align: left; display: grid; gap: 3px; min-width: 0; }
		.item.loading { border-color: #14a514; background: #f0fdf4; }
		.item.active { border-color: #14a514; box-shadow: 0 0 0 2px rgba(20,165,20,.12); }
		.item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.item small { color: #687280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.section-title { margin: 18px 0 8px; color: #687280; font-size: 12px; font-weight: 700; }
		.session-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: stretch; }
		.close-session { padding: 0 10px; font-size: 12px; }
		.messages { overflow: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
		.message { max-width: min(820px, 88%); border: 1px solid #dfe5ee; background: #fff; border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; line-height: 1.55; }
		.message.user { align-self: flex-end; background: #eaf8ee; border-color: #bee8c6; }
		.message.error { border-color: #ffd0d0; background: #fff4f4; color: #b42318; }
		.message.streaming { border-color: #c3d5f0; background: #f7fafd; }
		.role { display: block; margin-bottom: 4px; font-size: 11px; font-weight: 700; color: #687280; }
		.streaming-thinking { margin: 6px 0; padding: 6px 10px; border-left: 3px solid #b8c2d0; background: #f1f4f8; color: #687280; font-size: 12px; white-space: pre-wrap; line-height: 1.5; }
		.streaming-tool { margin: 6px 0; padding: 6px 10px; border: 1px solid #dfe5ee; border-radius: 6px; background: #fbfcfe; font-size: 12px; color: #46505e; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
		.streaming-tool .tool-name { font-weight: 700; color: #14a514; }
		.streaming-tool.error .tool-name { color: #d93025; }
		.caret { display: inline-block; width: 7px; height: 14px; margin-left: 2px; vertical-align: -2px; background: #14a514; animation: blink 1s steps(2) infinite; }
		@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
		.composer { display: grid; gap: 8px; padding: 12px; border-top: 1px solid #dfe5ee; background: #fff; }
		.composer-box { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; border: 1px solid #d7dce4; border-radius: 10px; padding: 8px; background: #fff; }
		textarea { width: 100%; min-height: 44px; max-height: 160px; resize: vertical; border: 0; outline: 0; padding: 6px 8px; font: inherit; line-height: 1.5; }
		.composer-actions { display: flex; align-items: center; gap: 8px; }
		.composer-hint { color: #8a94a6; font-size: 12px; padding-left: 4px; }
		.empty { margin: auto; color: #687280; text-align: center; }
		.pulse { display: inline-flex; width: 8px; height: 8px; border-radius: 999px; background: #14a514; animation: pulse 1s infinite ease-in-out; margin-right: 6px; }
		@keyframes pulse { 0%, 100% { opacity: .35; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
		@media (max-width: 760px) { .app { grid-template-columns: 1fr; } aside { max-height: 42vh; border-right: 0; border-bottom: 1px solid #dfe5ee; } }
	</style>
</head>
<body>
	<div class="app">
		<aside>
			<h1>PiDeck</h1>
			<div id="projects-title" class="section-title"></div>
			<div id="projects" class="list"></div>
			<div id="sessions-title" class="section-title"></div>
			<div id="sessions" class="list"></div>
		</aside>
		<main>
			<header>
				<h1 id="title"></h1>
				<div class="header-actions">
					<span id="status" class="status"></span>
					<button class="danger" type="button" id="stop"></button>
				</div>
			</header>
			<div id="messages" class="messages"></div>
			<form id="composer" class="composer">
				<div class="composer-box">
					<textarea id="prompt"></textarea>
					<div class="composer-actions">
						<button class="primary" type="submit" id="submit"></button>
					</div>
				</div>
				<div id="composer-hint" class="composer-hint"></div>
			</form>
		</main>
	</div>
	<script>
		const dictionaries = ${serializeWebClientDictionaries()};
		const clientTag = (navigator.languages?.[0] || navigator.language || "").replace(/_/g, "-").toLowerCase();
		const locale = clientTag.startsWith("zh") ? (/hant|zh-(tw|hk|mo)/.test(clientTag) ? "zh-TW" : "zh-CN") : "en-US";
		const copy = dictionaries[locale] || dictionaries["en-US"];
		// messagesBySession 现在是纯客户端缓存：/api/state 不再携带全量消息（P0 轮询瘦身），
		// 切会话/轮询时按需拉 /messages/page。
		let state = { projects: [], sessions: [], runtimes: [], messagesBySession: {} };
		let activeSessionId = "";
		let creatingProjectId = "";
		let refreshing = false;
		const el = (id) => document.getElementById(id);
		function tr(key, params) {
			let text = copy[key] || dictionaries["en-US"][key] || key;
			if (!params) return text;
			return text.replace(/\\{(\\w+)\\}/g, (match, name) => params[name] == null ? match : String(params[name]));
		}
		function trOr(key, fallback) {
			return copy[key] || dictionaries["en-US"][key] || fallback;
		}
		function localizeDescriptor(value, fallback) {
			if (!value?.i18nKey || !copy[value.i18nKey]) return fallback;
			return tr(value.i18nKey, value.i18nParams);
		}
		function localizeMessage(message) {
			// Web 端消息是纯文本出口：折叠自包含引用块，避免把 <quoted_context> 等 XML 原文发给浏览器。
			const localized = replaceExpandedRefBlocksWithLabels(
				localizeDescriptor(message.meta, message.text || ""),
			);
			const debug = typeof message.meta?.debugDetails === "string" ? message.meta.debugDetails.trim() : "";
			if (debug) console.error(debug);
			return localized;
		}
		function runtimeFor(sessionId) {
			return state.runtimes.find(runtime => runtime.sessionId === sessionId);
		}
		function runtimeTarget(runtime) {
			return runtime ? {
				sessionId: runtime.sessionId,
				agentId: runtime.agentId,
				runtimeGeneration: runtime.runtimeGeneration,
			} : undefined;
		}
		function displayStatus(session, runtime) {
			return trOr("web.status." + (runtime?.status || session?.status || "unknown"), tr("web.status.unknown"));
		}
		function mergeRejectedDraft(rejected, current) {
			return [rejected, current].filter(value => value && value.trim()).join("\n\n");
		}
		function applyStaticCopy() {
			document.documentElement.lang = locale;
			el("projects-title").textContent = tr("web.projects");
			el("sessions-title").textContent = tr("web.sessions");
			el("title").textContent = tr("web.chooseSession");
			el("status").textContent = tr("web.connecting");
			el("stop").textContent = tr("web.closeSession");
			el("messages").innerHTML = '<div class="empty">' + escapeHtml(tr("web.emptySelection")) + '</div>';
			el("prompt").placeholder = tr("web.promptPlaceholder");
			el("submit").textContent = tr("web.send");
			el("composer-hint").textContent = tr("web.composerHint");
		}
		async function api(path, options) {
			const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
			if (!res.ok) {
				const payload = await res.json().catch(() => ({}));
				if (payload.debugDetails) console.error(payload.debugDetails);
				throw new Error(payload.code ? tr(payload.code, payload.params) : (payload.error || res.statusText));
			}
			return res.json();
		}
		async function loadSessionMessages(sessionId) {
			const response = await api(\`/api/sessions/\${encodeURIComponent(sessionId)}/messages/page\`);
			state.messagesBySession = { ...state.messagesBySession, [sessionId]: response.messages || [] };
		}
		async function refresh() {
			if (refreshing) return;
			refreshing = true;
			try {
				const next = await api("/api/state");
				// 保留客户端已加载的消息，清理已删除会话的残留项
				const liveSessionIds = new Set(next.sessions.map(session => session.id));
				for (const key of Object.keys(state.messagesBySession)) {
					if (!liveSessionIds.has(key)) delete state.messagesBySession[key];
				}
				state = { ...next, messagesBySession: state.messagesBySession };
				if (!state.sessions.some(session => session.id === activeSessionId)) {
					activeSessionId = state.sessions[0]?.id || "";
				}
				el("status").textContent = tr("web.connected");
				// 流式期间保留 #messages 的实时打字机内容；仅刷新侧栏/状态，
				// 避免 600ms 轮询的全量 innerHTML 重绘清掉正在流式的块。
				if (streamingSessionId) {
					render();
				} else {
					// 非流式时刷新活跃会话消息（与旧的 /api/state 内嵌行为对齐）
					if (activeSessionId) await loadSessionMessages(activeSessionId);
					render();
					renderMessages();
				}
			} catch (error) {
				el("status").textContent = error.message || String(error);
			} finally {
				refreshing = false;
			}
		}
		function render() {
			el("projects").innerHTML = state.projects.map(project => \`
				<button class="item \${project.id === creatingProjectId ? "loading" : ""}" data-project="\${escapeHtml(project.id)}" \${creatingProjectId ? "disabled" : ""}>
					<strong>\${escapeHtml(project.name)}</strong>
					<small>\${project.id === creatingProjectId ? '<span class="pulse"></span>' + escapeHtml(tr("web.opening")) : escapeHtml(project.path)}</small>
				</button>\`).join("");
			el("sessions").innerHTML = state.sessions.map(session => {
				const runtime = runtimeFor(session.id);
				const project = state.projects.find(item => item.id === session.projectId);
				return \`<div class="session-row">
					<button class="item \${session.id === activeSessionId ? "active" : ""}" data-session="\${escapeHtml(session.id)}">
						<strong>\${escapeHtml(session.title)}</strong>
						<small>\${runtime?.status === "running" ? '<span class="pulse"></span>' : ""}\${escapeHtml(displayStatus(session, runtime))} · \${escapeHtml(runtime?.cwd || session.projectPath || project?.path || "")}</small>
					</button>
					<button class="close-session ghost" data-close-session="\${escapeHtml(session.id)}" title="\${escapeHtml(tr("web.closeSession"))}" \${runtime ? "" : "disabled"}>\${escapeHtml(tr("web.closeSession"))}</button>
				</div>\`;
			}).join("");
			const session = state.sessions.find(item => item.id === activeSessionId);
			const runtime = session ? runtimeFor(session.id) : undefined;
			el("title").textContent = session ? session.title : tr("web.chooseSession");
			el("status").innerHTML = runtime?.status === "running"
				? '<span class="pulse"></span>' + escapeHtml(tr("web.responding"))
				: (session ? escapeHtml(displayStatus(session, runtime)) : escapeHtml(tr("web.connected")));
			el("prompt").disabled = !session;
			el("composer").querySelector("button[type=submit]").disabled = !session;
			el("stop").disabled = !runtime || runtime.status === "closed";
			el("stop").textContent = runtime?.status === "running" ? tr("web.stopResponse") : tr("web.closeSession");
		}
		function renderMessages() {
			const messages = activeSessionId ? state.messagesBySession[activeSessionId] || [] : [];
			el("messages").innerHTML = messages.length
				? messages.map(message => \`<div class="message \${message.role}"><span class="role">\${escapeHtml(trOr("web.role." + message.role, message.role))}</span>\${escapeHtml(localizeMessage(message))}</div>\`).join("")
				: '<div class="empty">' + escapeHtml(tr("web.noMessages")) + '</div>';
		}
		document.addEventListener("click", async (event) => {
			const closeButton = event.target.closest("[data-close-session]");
			if (closeButton) {
				const sessionId = closeButton.dataset.closeSession;
				const runtime = runtimeFor(sessionId);
				if (!runtime) return;
				closeButton.disabled = true;
				closeButton.textContent = tr("web.closing");
				try {
					const action = runtime.status === "running" ? "abort" : "stop";
					await api(\`/api/sessions/\${encodeURIComponent(sessionId)}/runtime/\${action}\`, {
						method: "POST",
						body: JSON.stringify({ target: runtimeTarget(runtime) }),
					});
					await refresh();
				} finally {
					closeButton.disabled = false;
					closeButton.textContent = tr("web.closeSession");
				}
				return;
			}
			const projectButton = event.target.closest("[data-project]");
			if (projectButton) {
				creatingProjectId = projectButton.dataset.project;
				render();
				try {
					const result = await api("/api/sessions", { method: "POST", body: JSON.stringify({ projectId: projectButton.dataset.project }) });
					activeSessionId = result.session.id;
					await refresh();
				} finally {
					creatingProjectId = "";
					render();
				}
				return;
			}
			const sessionButton = event.target.closest("[data-session]");
			if (sessionButton) {
				// 切换会话：终止上一个 SSE 流，避免流式块串到别的会话；
				// 每次切换都重拉消息（客户端缓存可能已过期）
				stopStream();
				activeSessionId = sessionButton.dataset.session;
				try {
					await loadSessionMessages(activeSessionId);
				} catch {}
				render();
				renderMessages();
				return;
			}
		});
		// ── SSE 流式渲染：提交 prompt 后订阅 /stream，实时展示思考/工具/文本（A1） ──
		let streamingSessionId = "";
		let streamAbortController = null;
		let streamBlocks = { message: null, thinking: null, text: null, tools: [] };

		function ensureStreamingMessage() {
			if (streamBlocks.message) return streamBlocks.message;
			const messages = el("messages");
			// 清空空态占位（"请选择会话/暂无消息"）后再追加流式块
			const empty = messages.querySelector(".empty");
			if (empty) empty.remove();
			const div = document.createElement("div");
			div.className = "message streaming";
			div.innerHTML = '<span class="role">' + escapeHtml(tr("web.role.assistant")) + '</span>';
			messages.appendChild(div);
			streamBlocks.message = div;
			return div;
		}
		function ensureStreamingThinking() {
			if (streamBlocks.thinking) return streamBlocks.thinking;
			const block = document.createElement("div");
			block.className = "streaming-thinking";
			ensureStreamingMessage().appendChild(block);
			streamBlocks.thinking = block;
			return block;
		}
		function ensureStreamingText() {
			if (streamBlocks.text) return streamBlocks.text;
			const block = document.createElement("div");
			block.className = "streaming-text";
			ensureStreamingMessage().appendChild(block);
			streamBlocks.text = block;
			return block;
		}
		function addToolBlock(name, isError) {
			const block = document.createElement("div");
			block.className = "streaming-tool" + (isError ? " error" : "");
			block.innerHTML = '<span class="tool-name">' + escapeHtml(name) + '</span>' + escapeHtml(tr("web.toolRunning"));
			ensureStreamingMessage().appendChild(block);
			streamBlocks.tools.push(block);
			return block;
		}
		function scrollStreamToBottom() {
			const messages = el("messages");
			messages.scrollTop = messages.scrollHeight;
		}
		function applyStreamFrame(frame) {
			const type = frame && frame.type;
			if (!type) return;
			if (type === "reasoning-start") {
				ensureStreamingThinking();
				scrollStreamToBottom();
				return;
			}
			if (type === "reasoning-delta") {
				const block = ensureStreamingThinking();
				block.textContent += (frame.delta || "");
				scrollStreamToBottom();
				return;
			}
			if (type === "reasoning-end") {
				scrollStreamToBottom();
				return;
			}
			if (type === "text-start") {
				ensureStreamingText();
				scrollStreamToBottom();
				return;
			}
			if (type === "text-delta") {
				const block = ensureStreamingText();
				block.textContent += (frame.delta || "");
				scrollStreamToBottom();
				return;
			}
			if (type === "text-end") {
				scrollStreamToBottom();
				return;
			}
			if (type === "tool-input-available") {
				const tool = addToolBlock(frame.toolName || "tool", false);
				// 记录工具名供 output 阶段回写（dataset 无法存 JSON 外的富文本，这里直接存）
				tool.dataset.toolName = String(frame.toolName || "tool");
				scrollStreamToBottom();
				return;
			}
			if (type === "tool-output-available") {
				const tool = streamBlocks.tools.pop();
				if (tool) {
					tool.className = "streaming-tool" + (frame.output && frame.output.error ? " error" : "");
					tool.innerHTML = '<span class="tool-name">' + escapeHtml(tool.dataset.toolName || "tool") + '</span>' + escapeHtml(tr("web.toolComplete"));
				}
				scrollStreamToBottom();
				return;
			}
			if (type === "error") {
				const block = ensureStreamingText();
				block.textContent += "\n[错误] " + (frame.errorText || "");
				scrollStreamToBottom();
				return;
			}
			// finish / start 等由外部统一处理
		}
		async function startStream(sessionId) {
			stopStream();
			streamingSessionId = sessionId;
			streamBlocks = { message: null, thinking: null, text: null, tools: [] };
			streamAbortController = new AbortController();
			try {
				const res = await fetch(
					\`/api/sessions/\${encodeURIComponent(sessionId)}/stream\`,
					{ signal: streamAbortController.signal, headers: { accept: "text/event-stream" } },
				);
				if (!res.ok || !res.body) {
					el("status").textContent = tr("web.streamFailed");
					return;
				}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					// SSE 帧以空行分隔；逐帧解析 data: 行
					let sep;
					while ((sep = buffer.indexOf("\n\n")) !== -1) {
						const rawEvent = buffer.slice(0, sep);
						buffer = buffer.slice(sep + 2);
						const dataLine = rawEvent.split("\n").find(line => line.startsWith("data:"));
						if (!dataLine) continue;
						const payload = dataLine.slice(5).trim();
						if (payload === "[DONE]") {
							// 流结束：先停流（保留已渲染的打字机内容），再拉权威消息列表整体替换，
							// 保证最终展示的是 pi 落盘的完整回复（含被流式块拆分的边界）。
							setTimeout(() => { finishStream(sessionId); }, 0);
							return;
						}
						if (!payload) continue;
						try {
							applyStreamFrame(JSON.parse(payload));
						} catch { /* 忽略无法解析的帧 */ }
					}
				}
				// 流正常结束（无 [DONE]）也同步一次
				if (streamingSessionId === sessionId) { finishStream(sessionId); }
			} catch (error) {
				if (error && error.name === "AbortError") return;
				el("status").textContent = tr("web.streamFailed");
			} finally {
				if (streamingSessionId === sessionId) streamingSessionId = "";
			}
		}
		function stopStream() {
			if (streamAbortController) {
				try { streamAbortController.abort(); } catch {}
				streamAbortController = null;
			}
			streamingSessionId = "";
			streamBlocks = { message: null, thinking: null, text: null, tools: [] };
		}
		async function finishStream(sessionId) {
			stopStream();
			// 拉取权威消息列表（pi 已落盘完整回复）并整体重绘，替换流式时的增量块。
			try {
				await loadSessionMessages(sessionId);
			} catch { /* 历史加载失败则保留流式内容 */ }
			render();
			renderMessages();
		}
		// 切换会话时终止上一个流，避免串台（在 click 委托中调用 stopStream）
		el("composer").addEventListener("submit", async (event) => {
			event.preventDefault();
			const prompt = el("prompt");
			const message = prompt.value.trim();
			if (!message || !activeSessionId) return;
			const targetSessionId = activeSessionId;
			prompt.value = "";
			try {
				const response = await api(\`/api/sessions/\${encodeURIComponent(targetSessionId)}/prompt\`, {
					method: "POST",
					body: JSON.stringify({ requestId: crypto.randomUUID(), message }),
				});
				if (!response.result.accepted) {
					if (response.result.delivery !== "unknown" && activeSessionId === targetSessionId) {
						prompt.value = mergeRejectedDraft(message, prompt.value);
					}
					el("status").textContent = localizeDescriptor(response.result, response.result.error);
					return;
				}
				// 已接受：立刻打开 SSE 订阅该会话的流式事件；
				// 流结束后（agent_end → [DONE]）再 refresh() 同步权威消息列表。
				if (activeSessionId === targetSessionId) {
					void startStream(targetSessionId);
				} else {
					// 提交后切走了会话，仍要拉一次最新消息
					await refresh();
				}
			} catch (error) {
				// Transport errors are indeterminate after the request leaves the browser.
				// Never restore automatically because the Session may already have accepted it.
				el("status").textContent = error.message || String(error);
				console.error(error);
			}
		});
		el("prompt").addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
			event.preventDefault();
			el("composer").requestSubmit();
		});
		el("stop").addEventListener("click", async () => {
			if (!activeSessionId) return;
			const runtime = runtimeFor(activeSessionId);
			if (!runtime) return;
			el("stop").disabled = true;
			el("stop").textContent = tr("web.processing");
			try {
				const action = runtime.status === "running" ? "abort" : "stop";
				await api(\`/api/sessions/\${encodeURIComponent(activeSessionId)}/runtime/\${action}\`, {
					method: "POST",
					body: JSON.stringify({ target: runtimeTarget(runtime) }),
				});
				await refresh();
			} finally {
				el("stop").textContent = tr("web.closeSession");
			}
		});
		// 属性值注入统一走 escapeHtml（含引号转义）：data-project/data-session 等 id 插值
		// 也必须转义——导入/DSH 会话的 id 不受本应用控制，含引号时可造成属性逃逸。
		function escapeHtml(value) {
			return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
		}
		applyStaticCopy();
		refresh();
		setInterval(refresh, 600);
	</script>
</body>
</html>`;
}
