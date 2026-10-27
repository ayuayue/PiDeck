// billion-context 宿主插件面板：只做「看状态 / 启停 / 开面板」三件事。
// 服务能力由 PiDeck 主进程实现（命令、参数、端口都是主进程常量），本页面只能点名 service id。
const SERVICE_ID = "billion-context";
const BUSY_TIMEOUT_MS = 60_000;

const COPY = {
	"zh-CN": {
		running: "运行中",
		stopped: "未运行",
		notAvailable: "不可用",
		start: "启动",
		stop: "停止",
		open: "打开面板",
		opening: "打开中…",
		starting: "启动中…",
		stopping: "停止中…",
		refresh: "刷新服务状态",
		installHint: "未检测到可用的 bili 命令，请先全局安装：npm i -g billion-context",
		stoppedHint: "服务未运行。面板是代理进程自带的，不跑就没有面板。",
		noUiHint: "服务已运行但未报告端口，无法确定面板地址。",
		instances: "实例",
		openInstance: "打开",
		modalHint: "面板只监听 127.0.0.1 且无鉴权，只在本机浏览器访问；不要暴露到公网或局域网。",
		reasons: {
			"service-unavailable": "PiDeck 未实现该服务的适配器。",
			"service-not-running": "服务未运行。",
			"permission-denied": "该插件未被授权控制此服务。",
			"plugin-revoked": "插件授权已失效，请重新启用插件。",
			"rate-limited": "操作过于频繁，请稍后再试。",
			"cli-missing": "未找到 bili 命令，请先全局安装 billion-context。",
			"cli-failed": "bili 命令执行失败。",
			"invalid-report": "bili doctor 输出无法解析。",
			"start-failed": "启动命令未能执行。",
			"start-timeout": "已发出启动命令，但 20 秒内未检测到服务进程。",
			"stop-failed": "停止失败：进程可能已退出或权限不足。",
			"stop-restarted": "已终止，但又被自动拉起：这个代理由 pi 持有（pi 的模型请求走它，一掉就重新拉起）。要彻底停掉请先退出 pi。",
			"invalid-request": "请求格式不被接受。",
		},
	},
	"en-US": {
		running: "Running",
		stopped: "Not running",
		notAvailable: "Unavailable",
		start: "Start",
		stop: "Stop",
		open: "Open panel",
		opening: "Opening…",
		starting: "Starting…",
		stopping: "Stopping…",
		refresh: "Refresh status",
		installHint: "No usable bili command was found. Install it globally: npm i -g billion-context",
		stoppedHint: "The service is not running. The panel ships with the proxy process, so there is no panel without it.",
		noUiHint: "The service is running but reported no port, so the panel URL is unknown.",
		instances: "Instances",
		openInstance: "Open",
		modalHint: "The panel listens on 127.0.0.1 only and has no authentication — local browsers only. Never expose the port to a network.",
		reasons: {
			"service-unavailable": "PiDeck has no adapter for this service.",
			"service-not-running": "The service is not running.",
			"permission-denied": "This plugin is not authorized to control that service.",
			"plugin-revoked": "The plugin authorization is no longer valid. Re-enable the plugin.",
			"rate-limited": "Too many requests. Try again shortly.",
			"cli-missing": "The bili command was not found. Install billion-context globally.",
			"cli-failed": "The bili command failed.",
			"invalid-report": "Could not parse the bili doctor output.",
			"start-failed": "The start command could not be executed.",
			"start-timeout": "The start command ran, but no service process appeared within 20 seconds.",
			"stop-failed": "Stop failed: the process may already be gone, or permission was denied.",
			"stop-restarted": "The process was terminated, but it came straight back: pi owns this proxy (pi routes its model requests through it and respawns it when it dies). Quit pi to stop it for good.",
			"invalid-request": "The request shape was rejected.",
		},
	},
};

const el = (id) => document.getElementById(id);
let copy = COPY["zh-CN"];
let busy = false;
let timer;
// 上次已知的服务状态：按钮可用性靠它重算（见 applyControls）。
let lastStatus = { available: true, running: false };

function say(message) {
	const node = el("message");
	node.textContent = message || "";
	node.hidden = !message;
}

/** 原因码只做查表展示：未知码原样显示，方便对着开发指南排查。 */
function reasonText(code) {
	return copy.reasons[code] || code || "";
}

function errorText(error) {
	return reasonText(typeof error?.message === "string" ? error.message : "");
}

/** 多实例服务（如 lane daemon）：只有拿到 ≥2 个活实例时才展开列表，单实例就用主「打开面板」按钮。 */
function paintInstances(status) {
	const box = el("instances");
	const list = Array.isArray(status.instances) ? status.instances : [];
	if (!status.running || list.length < 2) {
		box.replaceChildren();
		box.hidden = true;
		return;
	}
	const title = document.createElement("p");
	title.className = "instances-title";
	title.textContent = copy.instances;
	const rows = list.map((inst) => {
		const row = document.createElement("div");
		row.className = "instances-row";
		const label = document.createElement("span");
		label.className = "mono";
		// 文本节点而非 HTML 标记拼接：URL 是服务报告的数据，不能拼进标记里。
		label.textContent = inst.uiUrl || `pid ${inst.pid}`;
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = copy.openInstance;
		button.disabled = busy;
		button.addEventListener("click", () => void run(copy.opening, () => pideck.services.openUi(SERVICE_ID, inst.pid)));
		row.append(label, button);
		return row;
	});
	box.replaceChildren(title, ...rows);
	box.hidden = false;
}

function paint(status) {
	lastStatus = status;
	const available = status.available !== false;
	const running = status.running === true;
	el("dot").dataset.state = !available ? "missing" : running ? "running" : "stopped";
	el("status").textContent = !available ? copy.notAvailable : running ? copy.running : copy.stopped;
	el("pid").textContent = running && status.pid ? String(status.pid) : "—";
	el("version").textContent = status.version || "—";
	el("ui").textContent = status.uiUrl || "—";
	el("note").textContent = !available ? copy.installHint : running ? (status.uiUrl ? copy.modalHint : copy.noUiHint) : copy.stoppedHint;
	// 原因码优先：既包括「服务不可用」，也包括「停了又被拉起来」这类带状态的成功响应。
	say(status.reason ? reasonText(status.reason) : "");
	paintInstances(status);
	applyControls();
}

/**
 * 按钮可用性只跟「上次已知状态 + 是否忙碌」有关，所以单独抽出来。
 * 关键：paint() 经常是在忙碌期间被调用的，setBusy(false) 必须重新应用一次，
 * 否则 disabled 会停在忙碌时的 true——面板显示「运行中」但三个按钮全是灰的（用户报过）。
 */
function applyControls() {
	const available = lastStatus.available !== false;
	const running = lastStatus.running === true;
	el("start").disabled = busy || !available || running;
	el("stop").disabled = busy || !running;
	el("open").disabled = busy || !running || !lastStatus.uiUrl;
	// 实例行里的「打开」按钮跟着忙态走：忙碌时全部锁住，避免和顶层按钮状态不同步。
	for (const button of document.querySelectorAll("#instances button")) button.disabled = busy || !running;
}

function setBusy(next, label) {
	busy = next;
	// 转圈动画和按钮锁定都挂在这个属性上：刷新一次 bili doctor 要一两秒，没有反馈就像点不动。
	document.body.dataset.busy = next ? "1" : "";
	el("refresh").disabled = next;
	applyControls();
	if (label) el("status").textContent = label;
}

/** 启停要等进程真的起来/落下，比普通请求慢得多；超时后自己解锁，避免按钮永久卡住。 */
function armBusyTimeout() {
	window.clearTimeout(timer);
	timer = window.setTimeout(() => {
		setBusy(false);
		// 先重画再报原因：refresh() 自己会清提示，顺序反了就什么都看不见。
		void refresh().then(() => say(reasonText("start-timeout")));
	}, BUSY_TIMEOUT_MS);
}

async function refresh() {
	if (busy) return;
	setBusy(true);
	try {
		paint(await pideck.services.status(SERVICE_ID));
	} catch (error) {
		paint({ available: true, running: false });
		say(errorText(error));
	} finally {
		window.clearTimeout(timer);
		setBusy(false);
	}
}

async function run(label, action) {
	if (busy) return;
	setBusy(true, label);
	armBusyTimeout();
	let notice = "";
	try {
		const next = await action();
		// start/stop 会回填新的服务状态；openUi 只负责把面板交给内置浏览器，没有返回值可画。
		if (next) {
			paint(next);
			notice = next.reason || "";
		}
	} catch (error) {
		notice = typeof error?.message === "string" ? error.message : "";
	} finally {
		window.clearTimeout(timer);
		setBusy(false);
		// refresh() 会把状态重画一遍并清掉提示，所以动作自己留下的提示要在这里补回去。
		await refresh();
		say(reasonText(notice));
	}
}

async function main() {
	try {
		const context = await pideck.context.get();
		copy = context?.locale === "en-US" ? COPY["en-US"] : COPY["zh-CN"];
	} catch {
		// context 拿不到就用默认语言，不影响服务操作。
	}
	document.documentElement.lang = copy === COPY["en-US"] ? "en-US" : "zh-CN";
	el("refresh").title = copy.refresh;
	el("refresh").setAttribute("aria-label", copy.refresh);
	el("start").textContent = copy.start;
	el("stop").textContent = copy.stop;
	el("open").textContent = copy.open;

	el("refresh").addEventListener("click", () => void refresh());
	el("start").addEventListener("click", () => void run(copy.starting, () => pideck.services.start(SERVICE_ID)));
	el("stop").addEventListener("click", () => void run(copy.stopping, () => pideck.services.stop(SERVICE_ID)));
	el("open").addEventListener("click", () => void run(copy.opening, () => pideck.services.openUi(SERVICE_ID)));

	await refresh();
}

if (typeof globalThis.pideck?.services?.status !== "function") {
	// 旧宿主或未授权：明确说出来，而不是留一个永远转圈的按钮。
	paint({ available: true, running: false });
	say(reasonText("service-unavailable"));
} else {
	void main();
}
