/** Network setup and consent tests do not access real endpoints or modify user plugin folders. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { hostPluginScaffoldInput, initialHostPluginScaffoldDraft } = loadTsCommonJs("src/renderer/src/config/hostPluginScaffoldDraft.ts");
const { parseHostPluginManifest } = loadTsCommonJs("src/main/plugins/hostPluginManifest.ts");
const { HostPluginPermissionDetails, HOST_PLUGIN_PERMISSION_OPTIONS } = loadTsCommonJs("src/renderer/src/config/HostPluginPermissionDetails.tsx", {
	stubs: { "../i18n": { t: (key) => key }, "@/lib/utils": loadTsCommonJs("src/renderer/src/lib/utils.ts") },
});
const draft = (over = {}) => ({ ...initialHostPluginScaffoldDraft(), id: "demo.network", name: "Network demo", ...over });
const manifest = (over = {}) => ({ schemaVersion: 1, apiVersion: 1, id: "demo.network", name: "Network demo", version: "0.1.0", permissions: [], contributes: { panels: [{ id: "main", title: "Network demo", entry: "app.html" }], commands: [] }, ...over });

test("network scaffold form defaults to offline and strips destinations when unchecked", () => {
	const initial = initialHostPluginScaffoldDraft();
	assert.deepEqual(Array.from(initial.permissions), ["sessions.read"]);
	assert.equal(hostPluginScaffoldInput(initial), null);
	const input = hostPluginScaffoldInput(draft({ httpsOrigins: "https://api.example.com", localPorts: "4187" }));
	assert.equal(input.network, undefined);
	assert.equal(input.presentation, "modal");
});

test("network scaffold form shapes exact destinations accepted by the authoritative manifest parser", () => {
	const input = hostPluginScaffoldInput(draft({ permissions: ["network.https", "network.local"], httpsOrigins: "https://api.example.com/, https://other.example.com:8443", localPorts: "4187, 8090" }));
	assert.deepEqual(Array.from(input.network.httpsOrigins), ["https://api.example.com", "https://other.example.com:8443"]);
	assert.deepEqual(Array.from(input.network.localPorts), [4187, 8090]);
	const parsed = parseHostPluginManifest(manifest({ permissions: input.permissions, network: input.network }));
	assert.equal(parsed.network.httpsOrigins[0], input.network.httpsOrigins[0]);
	assert.equal(parsed.network.localPorts[1], 8090);
});

test("network scaffold form refuses missing, duplicate or malformed grants", () => {
	for (const httpsOrigins of [
		"",
		"https://api.example.com/v1",
		"https://api.example.com?x=1",
		"https://api.example.com#a",
		"https://*.example.com",
		"https://user:pw@api.example.com",
		"http://api.example.com",
		"https://localhost",
		"https://service.localhost",
		"https://api.example.com https://api.example.com/",
		Array.from({ length: 17 }, (_, index) => `https://api${index}.example.com`).join(","),
	]) {
		assert.equal(hostPluginScaffoldInput(draft({ permissions: ["network.https"], httpsOrigins })), null, httpsOrigins);
	}
	for (const localPorts of ["", "0", "65536", "-1", "4187.5", "4187 4187", "localhost:4187", "http://127.0.0.1:4187"]) {
		assert.equal(hostPluginScaffoldInput(draft({ permissions: ["network.local"], localPorts })), null, localPorts);
	}
});

test("consent lists every requested capability and exact origin/port, warning about data export and local services", () => {
	const permissions = Array.from(HOST_PLUGIN_PERMISSION_OPTIONS, ([permission]) => permission);
	const value = parseHostPluginManifest(manifest({ permissions, network: { httpsOrigins: ["https://api.example.com", "https://other.example.com:8443"], localPorts: [4187, 8090] } }));
	const html = renderToStaticMarkup(React.createElement(HostPluginPermissionDetails, { manifest: value, warnings: true }));
	for (const [, key] of HOST_PLUGIN_PERMISSION_OPTIONS) assert.ok(html.includes(key), key);
	for (const destination of ["https://api.example.com", "https://other.example.com:8443", "http://127.0.0.1:4187", "http://127.0.0.1:8090"]) assert.ok(html.includes(destination), destination);
	assert.ok(html.includes("hostPlugins.networkDataWarning"));
	assert.ok(html.includes("hostPlugins.networkLocalWarning"));
});

test("offline consent shows no network warning and network-only consent does not claim session access", () => {
	const offline = renderToStaticMarkup(React.createElement(HostPluginPermissionDetails, { manifest: manifest({ permissions: ["sessions.read"] }), warnings: true }));
	assert.ok(offline.includes("hostPlugins.sessionsRead"));
	assert.ok(!offline.includes("hostPlugins.networkDestinations"));
	assert.ok(!offline.includes("hostPlugins.networkDataWarning"));
	const local = renderToStaticMarkup(React.createElement(HostPluginPermissionDetails, { manifest: manifest({ permissions: ["network.local"], network: { localPorts: [4187] } }), warnings: true }));
	assert.ok(local.includes("hostPlugins.noSessionsRead"));
	assert.ok(local.includes("hostPlugins.networkLocalWarning"));
	assert.ok(!local.includes("hostPlugins.networkDataWarning"));
});

test("settings uses the same inventory for scaffold and consent with labeled opt-in destination fields", () => {
	const source = readFileSync("src/renderer/src/config/HostPluginsTab.tsx", "utf8");
	assert.match(source, /HOST_PLUGIN_PERMISSION_OPTIONS\.map\(/);
	assert.match(source, /consent\s*&&\s*<HostPluginPermissionDetails\s+manifest=\{consent\.manifest\}\s+warnings/);
	assert.match(source, /hostPluginScaffoldInput\(draft\)/);
	assert.match(source, /permissions\.includes\("network\.https"\)/);
	assert.match(source, /permissions\.includes\("network\.local"\)/);
	assert.match(source, /htmlFor="host-plugin-https-origins"/);
	assert.match(source, /htmlFor="host-plugin-local-ports"/);
});
