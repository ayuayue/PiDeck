/** Permission-selected network demo fragments; generated pages never contact an endpoint on mount. */
import type { HostPluginScaffoldInput } from "../../shared/types/hostPlugin";

/** The scaffold passes an already validated policy; example URLs are derived from those same grants. */
export function scaffoldNetworkDemo(input: HostPluginScaffoldInput): { html: string; code: string; wiring: string; render: string; readme: string[] } {
	const urls = [...(input.network?.httpsOrigins ?? []).map((origin) => `${origin}/`), ...(input.network?.localPorts ?? []).map((port) => `http://127.0.0.1:${port}/api/health`)];
	if (urls.length === 0) return { html: "", code: "", wiring: "", render: "", readme: [] };
	return {
		html: `      <section class="detail" aria-label="Network demo">
        <label for="network-url" id="network-label"></label>
        <input id="network-url" type="url" autocomplete="off" spellcheck="false" />
        <button id="network-request" type="button"></button>
        <pre id="network-response" role="status"></pre>
      </section>
`,
		code: `// 只填入 manifest 授权的地址；不会自动发请求，点击按钮才调用宿主。
const NETWORK_EXAMPLE_URLS = ${JSON.stringify(urls)};
const networkCopy = {
  "zh-CN": { label: "接口 URL（只允许清单中的域名/端口；不会自动启动服务）", run: "发送 GET 请求", loading: "请求中…", truncated: "（展示已截断）" },
  "en-US": { label: "API URL (declared origins/ports only; never starts a service)", run: "Send GET request", loading: "Requesting…", truncated: "(display truncated)" },
};
let networkLocale = "zh-CN";

function renderNetworkDemo(locale) {
  networkLocale = locale;
  const text = networkCopy[locale] || networkCopy["zh-CN"];
  document.getElementById("network-label").textContent = text.label;
  document.getElementById("network-request").textContent = text.run;
}

/** 网络返回文本不是可信 HTML：只展示，不执行，不自动发送会话内容。 */
async function requestNetworkDemo() {
  const button = document.getElementById("network-request");
  const output = document.getElementById("network-response");
  const text = networkCopy[networkLocale] || networkCopy["zh-CN"];
  button.disabled = true;
  output.textContent = text.loading;
  try {
    if (typeof pideck.network?.request !== "function") throw new Error("network-api-unavailable");
    const response = await pideck.network.request({
      url: document.getElementById("network-url").value.trim(),
      method: "GET",
      headers: { Accept: "application/json, text/plain" },
    });
    // 4xx/5xx 也是正常 HTTP 响应：由插件按 status/ok 决定怎么提示。
    output.textContent = "HTTP " + response.status + "\\n" + response.body.slice(0, 8192) + (response.body.length > 8192 ? "\\n" + text.truncated : "");
  } catch (error) {
    output.textContent = String(error && error.message ? error.message : error);
  } finally {
    button.disabled = false;
  }
}

function wireNetworkDemo() {
  // 可将输入框改成下面任一示例 URL 的接口路径；换域名/端口需先改清单并重新授权。
  document.getElementById("network-url").value = NETWORK_EXAMPLE_URLS[0];
  document.getElementById("network-request").addEventListener("click", () => void requestNetworkDemo().catch(report));
}

`,
		wiring: "  wireNetworkDemo();\n",
		render: "  renderNetworkDemo(context.locale);\n",
		readme: [
			"",
			"## 网络示例（只在点击按钮后请求）",
			"",
			'- `pideck.network.request({ url, method: "GET" })`：宿主代发请求，页面的 `fetch` 仍被禁用。',
			...urls.map((url) => `- 可修改输入框访问：\`${url}\`（路径按你的接口调整，域名/端口不能超出清单）。`),
			"- HTTPS origin 必须是公网地址；本地只允许已授权的 `http://127.0.0.1:<端口>`。本地服务由你自行启动，PiDeck 不执行 BAT。",
			'- POST 示例：`await pideck.network.request({ url, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ example: true }) })`。',
			"- 不默认上传会话；同时授权会话读取与联网意味着插件可以发送会话内容，启用前请核对代码与目标地址。",
			"- 无浏览器 Cookie/宿主凭据；JSON/text 响应上限 1 MiB，POST 正文上限 256 KiB，默认超时 15 秒、最多 30 秒。",
		],
	};
}
