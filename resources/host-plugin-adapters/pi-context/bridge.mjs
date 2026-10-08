/** Runs the original viewer against PiDeck capabilities; all analysis stays in an isolated Worker. */
import { PiContextData, HISTORY_LIMITS } from "./data.mjs";

export async function createPiContextHost() {
	const api = window.pideck;
	if (!api || api.apiVersion !== 1) throw new Error("plugin-host-unavailable");
	const worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
	const pending = new Map();
	let sequence = 0;
	let closed = false;
	let changed;
	let refreshTimer;
	const rejectAll = () => {
		for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("analysis-unavailable")); }
		pending.clear();
	};
	worker.addEventListener("message", ({ data }) => {
		const request = pending.get(data?.id);
		if (!request) return;
		pending.delete(data.id);
		clearTimeout(request.timer);
		if (data.ok) request.resolve(data.snapshot);
		else request.reject(new Error("analysis-failed"));
	});
	worker.addEventListener("error", () => { closed = true; worker.terminate(); rejectAll(); });
	const analyze = (entries) => new Promise((resolve, reject) => {
		if (closed) { reject(new Error("analysis-unavailable")); return; }
		const id = ++sequence;
		const timer = setTimeout(() => { closed = true; worker.terminate(); rejectAll(); }, 8000);
		pending.set(id, { resolve, reject, timer });
		worker.postMessage({ id, entries });
	});
	let context;
	try { context = await api.context.get(); } catch (error) { closed = true; worker.terminate(); throw error; }
	const data = new PiContextData(api, analyze, context);
	const note = document.getElementById("host-note");
	const report = (code) => {
		if (!note) return;
		const zh = data.context.locale.startsWith("zh");
		const messages = zh
			? ["PiDeck 历史日志估算（非真实模型请求快照）", `概览最多 ${HISTORY_LIMITS.sessions} 个会话 / 每会话 ${HISTORY_LIMITS.overviewEntries} 条，详情最多 ${HISTORY_LIMITS.detailEntries} 条 / 8 MiB`, "图片数据已省略"]
			: ["PiDeck historical-log estimate (not actual model request input)", `Overview: up to ${HISTORY_LIMITS.sessions} sessions / ${HISTORY_LIMITS.overviewEntries} entries each; detail: ${HISTORY_LIMITS.detailEntries} entries / 8 MiB`, "Image data omitted"];
		if (!data.context.projectId) messages.push(zh ? "请先选择项目" : "Select a project first");
		if (data.status.partial) messages.push(zh ? "已达到读取上限或存在过大条目，当前统计不完整" : "Read limits or oversized entries: statistics are incomplete");
		if (data.status.missingPrompt) messages.push(zh ? "日志缺少系统提示词或工具定义，空白不代表实际没有" : "Prompt/tool definitions missing from logs; empty does not mean absent in the real request");
		if (data.status.unavailable) messages.push(zh ? `${data.status.unavailable} 个会话历史不可读（DSH 暂不支持）` : `${data.status.unavailable} histories unavailable (DSH not supported yet)`);
		if (code) messages.push(`${zh ? "加载失败" : "Load failed"}: ${/^[a-z-]{1,80}$/.test(code) ? code : "history-unavailable"}`);
		note.textContent = messages.join(" · ");
	};
	const appearance = () => {
		document.documentElement.dataset.hostTheme = data.context.theme;
		document.documentElement.lang = data.context.locale;
		for (const [key, value] of Object.entries(data.context.tokens ?? {})) document.documentElement.style.setProperty(key, value);
	};
	appearance();
	report();
	let contextPending = false;
	const unsubscribe = api.onEvent((event) => {
		if (event.type === "context.changed") { contextPending = data.updateContext(event.context) || contextPending; appearance(); }
		else if (event.type === "sessions.changed") data.invalidate();
		else return;
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => { const scopeChanged = contextPending; contextPending = false; void changed?.(scopeChanged); }, 350);
	});
	window.addEventListener("pagehide", () => { unsubscribe(); clearTimeout(refreshTimer); closed = true; worker.terminate(); rejectAll(); }, { once: true });
	return {
		get context() { return data.context; },
		get revision() { return data.epoch; },
		onChange(listener) { changed = listener; },
		report,
		async render(operation) {
			const epoch = data.epoch;
			try { await operation(epoch); if (epoch === data.epoch) report(); } catch (error) { if (epoch === data.epoch) report(error.message); }
		},
		api(path) {
			const url = new URL(path, "https://local.invalid");
			if (url.pathname === "/api/sessions") return data.list();
			if (url.pathname === "/api/snapshot") return data.snapshot(url.searchParams.get("file"));
			throw new Error("unsupported-method");
		},
	};
}
