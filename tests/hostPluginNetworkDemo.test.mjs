/** Static demo/guide acceptance uses fake window.pideck; no service, BAT or external network is started. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = "docs/examples/host-plugins/example.network";
const { readHostPluginPackage } = loadTsCommonJs("src/main/plugins/hostPluginFiles.ts");
const policy = loadTsCommonJs("src/main/plugins/hostPluginNetworkPolicy.ts");

/** Minimal DOM keeps real demo handlers while replacing only the desktop/network boundary. */
async function demo(request = async () => ({ status: 200, ok: true, headers: {}, body: "<untrusted>" })) {
	const calls = [];
	const elements = new Map();
	const element = (id) => {
		if (!elements.has(id))
			elements.set(id, {
				value: "",
				disabled: false,
				textContent: "",
				handlers: new Map(),
				addEventListener(event, handler) {
					this.handlers.set(event, handler);
				},
			});
		return elements.get(id);
	};
	element("https-url").value = "https://api.example.com/v1/items";
	element("local-url").value = "http://127.0.0.1:4187/api/health";
	let onEvent;
	let onClose;
	let unsubscribed = false;
	const window = {
		pideck: {
			context: { get: async () => ({ locale: "en-US", theme: "dark" }) },
			network: {
				request: async (input) => {
					calls.push(input);
					return request(input);
				},
			},
			onEvent: (listener) => {
				onEvent = listener;
				return () => {
					unsubscribed = true;
				};
			},
		},
		addEventListener: (event, listener) => {
			if (event === "pagehide") onClose = listener;
		},
	};
	new Function("window", "document", readFileSync(`${ROOT}/app.js`, "utf8"))(window, { getElementById: element });
	await setImmediate();
	return { calls, element, emit: (event) => onEvent(event), close: () => onClose(), isUnsubscribed: () => unsubscribed };
}

test("network demo is an installable static package with exact opt-in grants and no session access", async () => {
	const plugin = await readHostPluginPackage(resolve(ROOT));
	assert.equal(plugin.manifest.id, "example.network");
	assert.deepEqual(Array.from(plugin.manifest.permissions), ["network.https", "network.local"]);
	assert.deepEqual(Array.from(plugin.manifest.network.httpsOrigins), ["https://api.example.com"]);
	assert.deepEqual(Array.from(plugin.manifest.network.localPorts), [4187]);
	assert.equal(plugin.manifest.contributes.panels[0].entry, "app.html");
	const app = readFileSync(`${ROOT}/app.js`, "utf8");
	assert.doesNotThrow(() => new Function(app));
	assert.doesNotMatch(app, /\bfetch\(|XMLHttpRequest|innerHTML|pideck\.sessions\./);
});

test("network demo sends nothing on load/context changes; each click sends only its explicit URL", async () => {
	const value = await demo();
	assert.equal(value.calls.length, 0);
	value.emit({ type: "context.changed", context: { locale: "zh-CN", theme: "light" } });
	assert.equal(value.calls.length, 0);
	for (const kind of ["https", "local"]) {
		await value.element(`${kind}-request`).handlers.get("click")();
		const input = value.calls.at(-1);
		assert.equal(input.url, value.element(`${kind}-url`).value);
		assert.equal(input.method, "GET");
		assert.equal(input.body, undefined);
		assert.equal(value.element(`${kind}-response`).textContent, "HTTP 200\n<untrusted>");
		assert.equal(value.element(`${kind}-request`).disabled, false);
	}
	value.close();
	assert.equal(value.isUnsubscribed(), true);
});

test("network demo displays HTTP errors and stable rejection codes and re-enables its button", async () => {
	for (const [request, expected] of [
		[async () => ({ status: 503, ok: false, headers: {}, body: "Unavailable" }), "HTTP 503\nUnavailable"],
		[
			async () => {
				throw new Error("network-timeout");
			},
			"network-timeout",
		],
	]) {
		const value = await demo(request);
		await value.element("local-request").handlers.get("click")();
		assert.equal(value.element("local-response").textContent, expected);
		assert.equal(value.element("local-request").disabled, false);
	}
});

test("network guide describes the enforced budgets, consent and runnable static demo", () => {
	const guide = readFileSync("docs/host-plugin-dev-guide.md", "utf8");
	for (const term of ["network.https", "network.local", "httpsOrigins", "localPorts", "network.request", ROOT, "Cookie", "Authorization", "network-address-denied", "network-response-too-large"]) assert.ok(guide.includes(term), term);
	assert.ok(guide.includes(`${policy.HOST_PLUGIN_NETWORK_BODY_BYTES / 1024} KiB`));
	assert.ok(guide.includes(`${policy.HOST_PLUGIN_NETWORK_RESPONSE_BYTES / 1024 / 1024} MiB`));
	assert.ok(guide.includes(`${policy.HOST_PLUGIN_NETWORK_TIMEOUT_MS / 1000} 秒`));
	assert.ok(guide.includes(`${policy.HOST_PLUGIN_NETWORK_MAX_TIMEOUT_MS / 1000} 秒`));
	assert.ok(guide.includes(`最多 ${policy.HOST_PLUGIN_NETWORK_REDIRECTS} 次`));
});
