/** Static panel demo: requests are explicit clicks, never background uploads or service startup. */
const pideck = window.pideck;
const copy = {
	"zh-CN": {
		title: "受控网络 API 示例",
		notice: "不会自动请求、读取会话或启动服务。HTTPS 地址是占位符，请先修改清单并重新授权。",
		https: "第三方 HTTPS API",
		httpsHint: "仅允许 manifest.network.httpsOrigins 中声明的 origin；路径可自行调整。",
		local: "已启动的本地服务",
		localHint: "请自行启动可信服务。此示例只访问已授权的 127.0.0.1:4187，不执行 BAT。/api/health 是示例路径，请按你的服务修改。",
		url: "接口 URL",
		run: "发送 GET 请求",
		loading: "请求中…",
		truncated: "（展示已截断）",
	},
	"en-US": {
		title: "Controlled network API demo",
		notice: "No automatic requests, session reads or service startup. The HTTPS address is a placeholder: edit the manifest and grant consent again first.",
		https: "Third-party HTTPS API",
		httpsHint: "Only origins declared in manifest.network.httpsOrigins are allowed; adjust the path for your API.",
		local: "Already running local service",
		localHint: "Start a trusted service yourself. This demo only accesses the approved 127.0.0.1:4187 port and never executes BAT. /api/health is an example path: adjust it for your service.",
		url: "API URL",
		run: "Send GET request",
		loading: "Requesting…",
		truncated: "(display truncated)",
	},
};
let locale = "zh-CN";
const element = (id) => document.getElementById(id);

/** Context updates change labels only; they never send another request. */
function render(context) {
	locale = context.locale === "en-US" ? "en-US" : "zh-CN";
	const text = copy[locale];
	element("title").textContent = text.title;
	element("notice").textContent = text.notice;
	for (const kind of ["https", "local"]) {
		element(`${kind}-heading`).textContent = text[kind];
		element(`${kind}-hint`).textContent = text[`${kind}Hint`];
		element(`${kind}-label`).textContent = text.url;
		element(`${kind}-request`).textContent = text.run;
	}
}

/** Network text is untrusted data: use textContent, never execute it as HTML or JavaScript. */
async function request(kind) {
	const button = element(`${kind}-request`);
	const output = element(`${kind}-response`);
	button.disabled = true;
	output.textContent = copy[locale].loading;
	try {
		if (typeof pideck.network?.request !== "function") throw new Error("network-api-unavailable");
		const response = await pideck.network.request({
			url: element(`${kind}-url`).value.trim(),
			method: "GET",
			headers: { Accept: "application/json, text/plain" },
		});
		// 4xx/5xx are HTTP results, not rejected promises. Plugins decide how to display them.
		output.textContent = `HTTP ${response.status}\n${response.body.slice(0, 8192)}${response.body.length > 8192 ? `\n${copy[locale].truncated}` : ""}`;
	} catch (error) {
		output.textContent = error instanceof Error ? error.message : "network-request-failed";
	} finally {
		button.disabled = false;
	}
}

/** Wire the UI once after desktop context is available, and pair subscriptions with teardown. */
async function start() {
	render(await pideck.context.get());
	for (const kind of ["https", "local"]) element(`${kind}-request`).addEventListener("click", () => request(kind));
	const off = pideck.onEvent((event) => {
		if (event.type === "context.changed") render(event.context);
	});
	window.addEventListener("pagehide", off, { once: true });
}

void start().catch((error) => {
	element("notice").textContent = error instanceof Error ? error.message : "plugin-api-unavailable";
});
