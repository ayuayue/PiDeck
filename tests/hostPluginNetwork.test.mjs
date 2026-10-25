/** Network capability tests use injected DNS/transport only; no external API or real service is contacted. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseHostPluginManifest } = loadTsCommonJs("src/main/plugins/hostPluginManifest.ts");
const { parsePluginRequest, HOST_PLUGIN_CSP } = loadTsCommonJs("src/main/plugins/hostPluginPolicy.ts");
const { isPublicPluginAddress } = loadTsCommonJs("src/main/plugins/hostPluginNetworkPolicy.ts");
const { HostPluginNetwork } = loadTsCommonJs("src/main/plugins/HostPluginNetwork.ts");
const { HostPluginBroker } = loadTsCommonJs("src/main/plugins/HostPluginBroker.ts");
const ORIGIN = "https://api.example.com";
const manifest = (over = {}) => ({
	schemaVersion: 1,
	apiVersion: 1,
	id: "network.demo",
	name: "Network demo",
	version: "0.1.0",
	permissions: ["network.https"],
	network: { httpsOrigins: [ORIGIN] },
	contributes: { panels: [{ id: "main", title: "Network", entry: "app.html" }], commands: [] },
	...over,
});
const result = (over = {}) => ({ status: 200, headers: { "content-type": "application/json" }, body: '{"value":1}', ...over });
const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];
const noop = () => true;

function fixture(transport = async () => result(), resolve = publicDns) {
	return new HostPluginNetwork(transport, resolve);
}
function call(network, input = {}, value = manifest(), signal = new AbortController().signal, authorized = noop) {
	return network.request(parseHostPluginManifest(value), { url: `${ORIGIN}/v1/items`, ...input }, signal, authorized);
}

// Adding a network declaration never changes grants for existing offline packages.
test("host plugin manifest requires separate exact HTTPS origins and local ports", () => {
	assert.equal(parseHostPluginManifest(manifest({ permissions: [], network: undefined })).network, undefined);
	const parsed = parseHostPluginManifest(manifest({ permissions: ["network.https", "network.local"], network: { httpsOrigins: [`${ORIGIN}/`], localPorts: [4187] } }));
	assert.equal(parsed.network.httpsOrigins[0], ORIGIN);
	assert.equal(parsed.network.localPorts[0], 4187);
	for (const over of [
		{ network: undefined },
		{ permissions: [], network: { httpsOrigins: [ORIGIN] } },
		{ network: { httpsOrigins: [] } },
		{ network: { httpsOrigins: [ORIGIN, `${ORIGIN}/`] } },
		{ network: { httpsOrigins: [`${ORIGIN}/v1`] } },
		{ network: { httpsOrigins: [`${ORIGIN}?x=1`] } },
		{ network: { httpsOrigins: [`${ORIGIN}#a`] } },
		{ network: { httpsOrigins: ["https://*.example.com"] } },
		{ network: { httpsOrigins: ["https://user:pass@api.example.com"] } },
		{ network: { httpsOrigins: ["https://127.0.0.1"] } },
		{ network: { httpsOrigins: ["https://169.254.169.254"] } },
		{ network: { httpsOrigins: ["http://api.example.com"] } },
		{ network: { httpsOrigins: [ORIGIN], anything: true } },
		{ permissions: ["network.local"], network: { localPorts: [] } },
		{ permissions: ["network.local"], network: { localPorts: [4187, 4187] } },
		{ permissions: ["network.local"], network: { localPorts: [0] } },
		{ permissions: ["network.local"], network: { localPorts: [65536] } },
		{ permissions: ["network.local"], network: { localPorts: [4187.5] } },
	])
		assert.throws(() => parseHostPluginManifest(manifest(over)), /invalid-network/, JSON.stringify(over));
});

test("host plugin request accepts only bounded GET/POST text and rejects ambient-credential headers", () => {
	assert.equal(parsePluginRequest({ method: "network.request", request: { url: `${ORIGIN}/v1` } }).request.method, "GET");
	const valid = parsePluginRequest({ method: "network.request", request: { url: `${ORIGIN}/v1`, method: "POST", body: "{}", headers: { Authorization: "Bearer plugin-owned-test-value", "Content-Type": "application/json" } } });
	assert.equal(valid.request.headers.authorization, "Bearer plugin-owned-test-value");
	for (const request of [
		{ url: "file:///secret" },
		{ url: "https://user:pw@api.example.com" },
		{ url: `${ORIGIN}/a#fragment` },
		{ url: `${ORIGIN}/a`, method: "DELETE" },
		{ url: ORIGIN, method: "GET", body: "data" },
		{ url: ORIGIN, method: "POST", body: "x".repeat(256 * 1024 + 1) },
		{ url: ORIGIN, timeoutMs: 30001 },
		{ url: ORIGIN, timeoutMs: 0 },
		...["Cookie", "Host", "Origin", "Referer", "Proxy-Authorization", "Connection", "Content-Length", "Sec-Fetch-Site", "Accept-Encoding", "Set-Cookie"].map((key) => ({ url: ORIGIN, headers: { [key]: "value" } })),
		{ url: ORIGIN, headers: { "x-api-key": "value\r\nInjected: true" } },
		{ url: ORIGIN, headers: { Authorization: "one", authorization: "two" } },
	])
		assert.throws(() => parsePluginRequest({ method: "network.request", request }), /invalid-network-request/);
});

test("public address policy rejects private, special, mapped and tunnel ranges", () => {
	for (const address of [
		"0.0.0.0",
		"10.0.0.1",
		"127.0.0.1",
		"100.64.1.1",
		"169.254.169.254",
		"172.16.0.1",
		"192.168.0.1",
		"192.0.2.1",
		"198.18.0.1",
		"224.0.0.1",
		"255.255.255.255",
		"::1",
		"::",
		"::ffff:127.0.0.1",
		"fc00::1",
		"fe80::1",
		"ff02::1",
		"64:ff9b::a00:1",
		"2001::1",
		"2001:db8::1",
		"2002:7f00:1::1",
		"3fff::1",
		"not-an-address",
	])
		assert.equal(isPublicPluginAddress(address), false, address);
	for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(isPublicPluginAddress(address), true, address);
});

test("HTTPS requests pin validated DNS and never reach unlisted origins or private DNS answers", async () => {
	const sent = [];
	const network = fixture(async (url, input, address) => {
		sent.push({ url: String(url), input, address });
		return result();
	});
	const response = await call(network, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
	assert.equal(response.status, 200);
	assert.equal(response.ok, true);
	assert.equal(response.body, '{"value":1}');
	assert.equal(sent[0].address.address, "8.8.8.8");
	for (const url of ["https://other.example.com/v1", "http://127.0.0.1:4187/api", "https://api.example.com:8443/v1"]) await assert.rejects(call(network, { url }), /network-origin-denied|permission-denied/);
	assert.equal(sent.length, 1);
	for (const addresses of [
		[{ address: "127.0.0.1", family: 4 }],
		[
			{ address: "8.8.8.8", family: 4 },
			{ address: "10.0.0.1", family: 4 },
		],
		[{ address: "::ffff:127.0.0.1", family: 6 }],
		[],
	]) {
		await assert.rejects(
			call(
				fixture(
					async () => {
						assert.fail("private DNS must never connect");
					},
					async () => addresses,
				),
			),
			/network-address-denied/,
		);
	}
});

test("local requests require the separate permission and only connect to declared IPv4 loopback ports", async () => {
	const value = manifest({ permissions: ["network.local"], network: { localPorts: [4187] } });
	const sent = [];
	const network = fixture(
		async (url, input, address) => {
			sent.push(address.address);
			return result();
		},
		async () => {
			assert.fail("literal loopback must not use DNS");
		},
	);
	await call(network, { url: "http://127.0.0.1:4187/api/sessions" }, value);
	assert.deepEqual(sent, ["127.0.0.1"]);
	for (const url of ["http://127.0.0.1:4188/api", "http://localhost:4187/api", "http://[::1]:4187/api", "http://192.168.0.1:4187/api", "http://127.1:4187/api", "http://2130706433:4187/api", "https://127.0.0.1:4187/api"])
		await assert.rejects(call(network, { url }, value), /network-origin-denied|permission-denied|invalid-network-request/);
	assert.equal(sent.length, 1);
});

test("redirects recheck same-origin policy and DNS, strip POST bodies on 303 and preserve them on 307", async () => {
	for (const status of [303, 307]) {
		const sent = [];
		const network = fixture(async (url, input) => {
			sent.push({ url: String(url), method: input.method, body: input.body });
			return sent.length === 1 ? result({ status, headers: { location: "/next" } }) : result();
		});
		await call(network, { method: "POST", body: "payload" });
		assert.equal(sent[1].url, `${ORIGIN}/next`);
		assert.equal(sent[1].method, status === 303 ? "GET" : "POST");
		assert.equal(sent[1].body, status === 303 ? undefined : "payload");
	}
	for (const location of ["https://other.example.com/next", "http://127.0.0.1:4187/api", "file:///secret"]) await assert.rejects(call(fixture(async () => result({ status: 302, headers: { location } }))), /network-origin-denied|network-redirect-denied|permission-denied|invalid-network-request/);
	await assert.rejects(call(fixture(async () => result({ status: 302, headers: { location: "/again" } }))), /network-too-many-redirects/);
	let lookups = 0;
	await assert.rejects(
		call(
			fixture(
				async () => result({ status: 302, headers: { location: "/again" } }),
				async () => [{ address: ++lookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }],
			),
		),
		/network-address-denied/,
	);
});

test("timeouts cover DNS and response waits; revoked DNS results never start a request", async () => {
	await assert.rejects(
		call(
			fixture(
				async () => result(),
				() => new Promise(() => {}),
			),
			{ timeoutMs: 10 },
		),
		/network-timeout/,
	);
	await assert.rejects(
		call(
			fixture(() => new Promise(() => {})),
			{ timeoutMs: 10 },
		),
		/network-timeout/,
	);
	const controller = new AbortController();
	let resolve;
	const pending = call(
		fixture(
			async () => {
				assert.fail("late DNS must not connect");
			},
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		),
		{},
		manifest(),
		controller.signal,
	);
	controller.abort(new Error("plugin-revoked"));
	resolve([{ address: "8.8.8.8", family: 4 }]);
	await assert.rejects(pending, /plugin-revoked/);
});

test("broker aborts in-flight network on unmount, scope switch, disable, fingerprint change and dispose", async () => {
	for (const mode of ["unbind", "update", "disable", "fingerprint", "dispose"]) {
		const listeners = new Set();
		let plugin = { manifest: parseHostPluginManifest(manifest()), fingerprint: "f" };
		let signal;
		let started;
		const start = new Promise((resolve) => {
			started = resolve;
		});
		const network = fixture((_url, _input, _address, abort) => {
			signal = abort;
			started();
			return new Promise(() => {});
		});
		const broker = new HostPluginBroker(
			{
				getEnabled: () => plugin,
				onChanged: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			{ describe: (context) => context },
			{},
			undefined,
			network,
		);
		broker.bind(10, "network.demo", "f", { projectId: "a", locale: "en-US", theme: "dark" });
		const pending = broker.request(10, true, { method: "network.request", request: { url: `${ORIGIN}/api` } });
		await start;
		if (mode === "unbind") broker.unbind(10);
		if (mode === "update") broker.update(10, { projectId: "b", locale: "en-US", theme: "dark" });
		if (mode === "disable" || mode === "fingerprint") {
			plugin = mode === "disable" ? undefined : { ...plugin, fingerprint: "new" };
			for (const listener of listeners) listener();
		}
		if (mode === "dispose") broker.dispose();
		assert.equal(signal.aborted, true, mode);
		assert.equal((await pending).code, "plugin-revoked", mode);
		broker.dispose();
		assert.equal(listeners.size, 0);
	}
});

/** A destroyed guest still owns its broker binding until the view host revokes it. */
test("view teardown aborts network even when the guest has already been destroyed", async () => {
	for (const mode of ["destroyed", "render-process-gone", "unmount"]) {
		const plugin = { manifest: parseHostPluginManifest(manifest()), fingerprint: "f" };
		const manager = { getEnabled: () => plugin, onChanged: () => () => {} };
		let signal;
		let started;
		const start = new Promise((resolve) => {
			started = resolve;
		});
		const network = fixture((_url, _input, _address, abort) => {
			signal = abort;
			started();
			return new Promise(() => {});
		});
		const broker = new HostPluginBroker(manager, { describe: (context) => context }, {}, undefined, network);
		let detached = 0;
		const isolated = {
			setPermissionCheckHandler() {},
			setPermissionRequestHandler() {},
			setDevicePermissionHandler() {},
			on() {},
			webRequest: { onBeforeRequest() {} },
			protocol: {
				handle() {},
				unhandle() {
					detached++;
				},
			},
		};
		const { HostPluginViewHost } = loadTsCommonJs("src/main/plugins/HostPluginViewHost.ts", { stubs: { electron: { session: { fromPartition: () => isolated } } } });
		const host = new HostPluginViewHost(manager, broker, {}, "unused-preload");
		let destroyed = false;
		const guest = Object.assign(new EventEmitter(), {
			id: 10,
			isDestroyed: () => destroyed,
			close() {
				destroyed = true;
				this.emit("destroyed");
			},
			setWindowOpenHandler() {},
			insertCSS: async () => "",
		});
		let pending;
		try {
			const { instanceId } = await host.mount({ pluginId: "network.demo", panelId: "main", context: { locale: "en-US", theme: "dark" } });
			host.attachGuest(instanceId, guest);
			pending = broker.request(10, true, { method: "network.request", request: { url: `${ORIGIN}/api` } });
			await start;
			if (mode === "destroyed") {
				destroyed = true;
				guest.emit("destroyed");
			} else if (mode === "render-process-gone") guest.emit("render-process-gone");
			else host.unmount(instanceId);
			assert.equal(signal.aborted, true, mode);
			assert.equal(host.hasLive(instanceId), false, mode);
			assert.equal(detached, 1, mode);
			assert.equal((await pending).code, "plugin-revoked", mode);
		} finally {
			host.dispose();
			broker.dispose();
			if (pending) await pending;
		}
	}
});

test("broker denies network permission/sender spoofing and preserves its two-in-flight limit", async () => {
	let started = 0;
	const listeners = new Set();
	const network = fixture(() => {
		started++;
		return new Promise(() => {});
	});
	const manager = {
		getEnabled: () => ({ manifest: parseHostPluginManifest(manifest()), fingerprint: "f" }),
		onChanged: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const broker = new HostPluginBroker(manager, { describe: (context) => context }, {}, undefined, network);
	broker.bind(10, "network.demo", "f", { locale: "en-US", theme: "dark" });
	assert.equal((await broker.request(11, true, { method: "network.request", request: { url: ORIGIN } })).code, "plugin-not-authorized");
	assert.equal((await broker.request(10, false, { method: "network.request", request: { url: ORIGIN } })).code, "plugin-not-authorized");
	assert.equal((await broker.request(10, true, { method: "network.request", request: { url: "http://127.0.0.1:4187/api" } })).code, "permission-denied");
	const first = broker.request(10, true, { method: "network.request", request: { url: ORIGIN } });
	const second = broker.request(10, true, { method: "network.request", request: { url: ORIGIN } });
	assert.equal((await broker.request(10, true, { method: "network.request", request: { url: ORIGIN } })).code, "rate-limited");
	broker.dispose();
	assert.equal((await first).code, "plugin-revoked");
	assert.equal((await second).code, "plugin-revoked");
	assert.ok(started <= 2);
});

test("page sandbox remains offline and network is exposed only via the dedicated preload", () => {
	assert.match(HOST_PLUGIN_CSP, /connect-src 'none'/);
	assert.match(readFileSync("src/main/plugins/HostPluginViewHost.ts", "utf8"), /cancel:\s*!pluginAssetFromUrl/);
	assert.match(readFileSync("src/preload/hostPlugin.ts", "utf8"), /network:\s*\{\s*request:\s*\(.*\)\s*=>\s*request\(\{\s*method:\s*"network\.request"/);
});
