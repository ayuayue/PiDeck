#!/usr/bin/env node
/** Boot the actual PiDeck DSH host + RPC bridge in a disposable HOME. No model/network calls. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { buildDshHarness, startDshHarness } from "./dsh-boot-harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [input] = process.argv.slice(2);
const installed = input === "--installed";
const archive = resolve(input ?? join(root, "dist-runtime", `dsh-runtime-${process.platform}-${process.arch}.tgz`));
if (!installed && !existsSync(archive)) throw new Error(`Archive not found: ${archive}`);
const temp = mkdtempSync(join(tmpdir(), "pideck-dsh-boot-"));
let host;
function value(result) {
	assert.equal(result.ok, true, JSON.stringify(result));
	return result.value;
}
try {
	let runtimeRoot = root;
	if (!installed) {
		await tar.x({ file: archive, cwd: temp });
		runtimeRoot = join(temp, "dsh-runtime");
		const manifest = JSON.parse(readFileSync(join(runtimeRoot, "manifest.json"), "utf8"));
		const declared = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dshRuntimeVersion;
		assert.equal(manifest.runtimeVersion, declared);
	}
	const home = join(temp, "home");
	mkdirSync(home);
	const legacy = "agent-presets:\n  default: minimal\n";
	writeFileSync(join(home, "settings.yaml"), legacy);
	// 旧目录身份、递归组合、相对插件/资源、缺省 metadata 和 teardown 不写回。
	const presetDir = join(home, ".agent-presets", "legacy-custom");
	mkdirSync(presetDir, { recursive: true });
	const oldComposition =
		"- id: delegation\n  name: cordis:group\n  group: true\n  isolate:\n    workflowEngine: true\n  config:\n    - id: workflow-worker-thread\n      name: '@deepseek-ai/dsh-workflow-worker-thread'\n      config:\n        provider: spawn\n- id: nested\n  name: cordis:include\n  config:\n    path: ./nested.yml\n";
	const nested = "- id: resource-check\n  name: ./resource-check.mjs\n";
	writeFileSync(join(presetDir, "agent.cordis.yml"), oldComposition);
	writeFileSync(join(presetDir, "nested.yml"), nested);
	writeFileSync(join(presetDir, "resource.txt"), "legacy-resource");
	writeFileSync(join(presetDir, "resource-check.mjs"), 'import {readFileSync} from "node:fs"; export function apply(ctx) { if(readFileSync(new URL("resource.txt",ctx.baseUrl),"utf8") !== "legacy-resource") throw new Error("relative resource lost"); }');
	const build = await buildDshHarness(temp);
	host = await startDshHarness({ build, home, runtimeRoot });
	const inventory = value(await (await host.rpc.rawFetch("/pideck-plugin/rpc", { method: "POST", body: JSON.stringify({ method: "staticInventory" }) })).json());
	assert.ok(inventory.length > 0, "static plugin inventory must be available");
	assert.deepEqual(
		inventory.filter((entry) => entry.fiberPhase === "failed"),
		[],
		"no plugin may silently fail after host-ready",
	);
	assert.ok(!inventory.some((entry) => /dsh-webserver|dsh-web-app$/.test(entry.moduleName)), "headless composition must not mount a browser server");
	const telemetry = inventory.find((entry) => entry.moduleName === "@deepseek-ai/dsh-session-telemetry-otel");
	assert.equal(telemetry?.enabled, false, "telemetry must stay disabled");
	const presets = value(await host.rpc.call("agentPresets/list", {}));
	assert.deepEqual(
		presets.presets.map((item) => item.id),
		["standard", "ptc", "minimal", "cordis", "legacy-custom"],
	);
	for (const preset of presets.presets) assert.equal(preset.broken, undefined, `${preset.id}: ${preset.broken}`);
	const described = value(await host.rpc.call("settings/describe", {}));
	assert.equal(described.writable, true);
	const registry = described.namespaces.find((item) => item.ns === "agent-preset-registry");
	assert.ok(registry, "preset settings namespace must exist");
	assert.equal(registry.value.selectedDefault, "minimal");
	value(await host.rpc.call("settings/update", { ns: registry.ns, patch: { selectedDefault: "ptc" }, expectedRevision: registry.revision }));
	assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), legacy);
	await host.stop();
	host = await startDshHarness({ build, home, runtimeRoot });
	const restored = value(await host.rpc.call("settings/describe", {}));
	assert.equal(restored.namespaces.find((item) => item.ns === registry.ns)?.value.selectedDefault, "ptc");
	assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), legacy);
	const restarted = value(await host.rpc.call("agentPresets/list", {}));
	for (const preset of restarted.presets) assert.equal(preset.broken, undefined, `${preset.id}: ${preset.broken}`);
	await host.stop();
	assert.equal(readFileSync(join(presetDir, "agent.cordis.yml"), "utf8"), oldComposition);
	assert.equal(readFileSync(join(presetDir, "nested.yml"), "utf8"), nested);
	console.log(`BOOT OK — real hostEntry, official/legacy presets, read-only includes, profile write/restart (${installed ? "installed tree" : "archive"})`);
} catch (error) {
	console.error("BOOT FAILED", error);
	if (host) console.error(host.logs());
	process.exitCode = 1;
} finally {
	await host?.stop();
	rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
