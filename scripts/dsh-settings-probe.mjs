#!/usr/bin/env node
/**
 * DSH settings 域探针：describe() 的实际返回结构 → 决定配置管理页表单怎么渲染。
 * 用法：node scripts/dsh-settings-probe.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir as osHomedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { InProcessApiClient, toFetchHandler } from "@deepseek-ai/dsh-host-apiproxy";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");

const log = (prefix, ...rest) => console.log(`[${prefix}]`, ...rest);

async function main() {
	const dshHome = process.env.DSH_HOME || join(osHomedir(), ".dsh");
	process.env.DSH_HOME = dshHome;
	process.env.DSH_TELEMETRY_DISABLED = "1";
	log("home", `DSH_HOME=${dshHome}`);

	const basePatchPath = require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
	const patches = loadOverlayPatches("pideck-probe", basePatchPath);
	patches.push({ id: "hmr", disabled: true });
	patches.push({ id: "session-telemetry-otel", disabled: true });
	patches.push({
		insert: [
			{ id: "storage", name: "@deepseek-ai/dsh-storage" },
			{
				id: "storage-json",
				name: "@deepseek-ai/dsh-storage-json",
				config: { root: { __jsExpr: "dshHomePath('storages')" } },
			},
			{ id: "storage-domain", name: "@deepseek-ai/dsh-storage-domain", config: { backend: "json" } },
			{ id: "workspace", name: "@deepseek-ai/dsh-workspace" },
			{ id: "api-gateway", name: "@deepseek-ai/dsh-host-apiproxy" },
			{ id: "pideck-directory-picker", name: "./pideck-directory-picker.js" },
		],
	});

	const configDir = mkdtempSync(join(tmpdir(), "pideck-dsh-config-"));
	const configPath = join(configDir, "cordis.yml");
	writeFileSync(configPath, "[]\n");
	writeFileSync(join(configDir, "pideck-directory-picker.js"), ["export default {", "  apply(ctx) {", "    ctx.provide('directoryPicker', {", "      capability() { return { kind: 'none' }; },", "    });", "  },", "};", ""].join("\n"));

	let ctx;
	try {
		ctx = await boot(
			"pideck-probe",
			configPath,
			patches,
			(hostCtx) => {
				provideCmdline(hostCtx, {
					args: [],
					exit: (code) => {
						process.exitCode = code;
					},
				});
			},
			pathToFileURL(join(projectRoot, "node_modules") + "/").href,
		);
	} catch (error) {
		log("boot", `FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		return 1;
	}
	log("boot", "OK");

	const client = new InProcessApiClient(toFetchHandler(ctx.apiProxy));

	const described = await client.settings.describe({});
	if (!described.result.ok) {
		log("settings.describe", `FAILED: ${JSON.stringify(described.result.error)}`);
	} else {
		const { writable, hasDocument, namespaces } = described.result.value;
		log("settings.describe", `writable=${writable} hasDocument=${hasDocument} namespaces=${namespaces.length}`);
		for (const ns of namespaces) {
			log("ns", `\n=== ${ns.ns} (applies=${ns.applies}, revision=${ns.revision}) ===`);
			log("ns", `value = ${JSON.stringify(ns.value, null, 2)}`);
			log("ns", `user  = ${JSON.stringify(ns.user, null, 2)}`);
			log("ns", `secrets = ${JSON.stringify(ns.secrets)}`);
			log("ns", `schema = ${JSON.stringify(ns.schema).slice(0, 1500)}`);
		}
	}

	// credentials.describe：refs 必须匹配 env 名格式（^[A-Za-z_][A-Za-z0-9_]*$）
	const refs = ["DEEPSEEK_API_KEY", "OPENCODE_GO_API_KEY", "WEISHIAIR_API_KEY"];
	const creds = await client.credentials.describe({ refs });
	if (!creds.result.ok) {
		log("credentials.describe", `FAILED: ${JSON.stringify(creds.result.error)}`);
	} else {
		log("credentials.describe", JSON.stringify(creds.result.value, null, 2));
	}

	// 收集所有 namespace schema 里出现的类型集合，确认渲染器要支持哪些
	const typeSet = new Set();
	const roleSet = new Set();
	for (const ns of described.result.ok ? described.result.value.namespaces : []) {
		const schema = ns.schema;
		if (schema && typeof schema === "object" && schema.refs && typeof schema.refs === "object") {
			for (const ref of Object.values(schema.refs)) {
				if (ref && typeof ref === "object" && typeof ref.type === "string") {
					typeSet.add(ref.type);
					if (ref.meta && typeof ref.meta.role === "string") roleSet.add(ref.meta.role);
				}
			}
		}
	}
	log("types", `schema 类型集合: ${[...typeSet].sort().join(", ")}`);
	log("roles", `meta.role 集合: ${[...roleSet].sort().join(", ")}`);

	// 完整 dump 到文件（不截断）：供渲染器开发时核对 schema 形状
	const outPath = join(scriptDir, "dsh-settings-dump.json");
	writeFileSync(outPath, JSON.stringify(described.result.ok ? described.result.value : described.result.error, null, 2));
	log("dump", `完整 describe 已写入 ${outPath}`);

	await Promise.race([
		ctx.fiber.dispose().then(
			() => true,
			(error) => {
				log("dispose", `warn: ${String(error)}`);
				return true;
			},
		),
		new Promise((r) => setTimeout(r, 5000)),
	]);
	rmSync(configDir, { recursive: true, force: true });
	return 0;
}

main().then((code) => process.exit(code));
