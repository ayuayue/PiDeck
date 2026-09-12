#!/usr/bin/env node
/**
 * DSH runtime 归档的 boot 冒烟测试：解压 tgz 到临时目录，按 hostEntry 的插件组合
 * 真实 boot 一次 cordis 插件树，跑通才算归档可用。
 *
 *   node scripts/check-dsh-boot.mjs [<dsh-runtime-*.tgz>]
 *
 * 2026-08 事故背景：tar 扫描类校验只能确认「包存在」，抓不到「包在但入口文件被裁 /
 * 依赖包整体缺席」（@earendil-works/pi-ai 空壳、koffi 的 src/ 被裁）这类
 * host 加载到一半才崩的问题。真实 boot 是这类缺陷的唯一可靠门禁。
 *
 * 插件组合镜像 src/main/dsh/hostEntry.ts 的 patches，但跳过 PiDeck 私有插件
 * （pideck-* 是 app 侧代码、随 app 分发，不在 runtime 归档里，不属于本校验对象）；
 * 其余全部为 runtime 包，与 host 实际加载路径一致。
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import * as tar from "tar";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultArchive = join(
	scriptDir,
	"..",
	"dist-runtime",
	`dsh-runtime-${process.platform}-${process.arch}.tgz`,
);

const [rawPath] = process.argv.slice(2);
const archivePath = rawPath ? resolve(rawPath) : defaultArchive;

if (!existsSync(archivePath)) {
	console.error(`用法: node scripts/check-dsh-boot.mjs [<dsh-runtime-*.tgz>]\n找不到归档: ${archivePath}`);
	process.exit(1);
}

// 镜像 hostEntry 的 agent plane 禁用名单（dsh-base 的进程级全局工具）
const DSH_WEB_AGENT_PLANE_DISABLED = [
	"tool-bash", "tool-pwsh", "tool-jobs", "tool-fs", "tool-fs-search",
	"tool-str-replace-editor", "skill-filesystem", "tool-skill", "tool-goal",
	"plan-mode", "compaction-basic", "command-compact", "tool-result-pruner",
	"tool-subagent-control", "tool-subagent-list-agents", "tool-subagent",
	"tool-subagent-fork", "workflow-worker-thread", "tool-workflow", "tool-ralph",
	"agent-instructions", "tool-todo", "tool-web",
];

const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-boot-check-"));
try {
	console.log(`解压到临时目录: ${tmpRoot}`);
	await tar.x({ file: archivePath, cwd: tmpRoot });
	const nmRoot = join(tmpRoot, "dsh-runtime", "node_modules");
	if (!existsSync(nmRoot)) {
		console.error("FAIL 归档内没有 dsh-runtime/node_modules（解压后布局不对）");
		process.exit(1);
	}

	// 独立临时 DSH_HOME / config：校验不碰用户真实数据
	const dshHome = join(tmpRoot, "home");
	const configDir = join(tmpRoot, "config");
	mkdirSync(dshHome, { recursive: true });
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "cordis.yml"), "[]\n");

	// hostEntry 会写入 configDir 的 app 本地插件（directoryPicker 是 dsh-host-apiproxy
	// 激活的前置服务，不补 host 会停在 pending；其余两个是行为插件，与 runtime 无关
	// 但保持与真实 host 相同的组合以贴近实际加载路径）。
	writeFileSync(
		join(configDir, "pideck-directory-picker.js"),
		[
			"export default {",
			"  apply(ctx) {",
			"    ctx.provide('directoryPicker', {",
			"      capability() { return { kind: 'none' }; },",
			"    });",
			"  },",
			"};",
			"",
		].join("\n"),
	);
	writeFileSync(join(configDir, "pideck-slash-bridge.js"), "export default { apply() {} };\n");
	writeFileSync(join(configDir, "pideck-minimal-tool-filter.js"), "export default { apply() {} };\n");

	process.env.DSH_HOME = dshHome;
	process.env.DSH_TELEMETRY_DISABLED = "1";

	const requireRt = createRequire(join(nmRoot, "package.json"));
	const importFromRt = (specifier) => import(pathToFileURL(requireRt.resolve(specifier)).href);

	const [{ boot, loadOverlayPatches }, { provideCmdline }] = await Promise.all([
		importFromRt("@deepseek-ai/dsh-app-boot"),
		importFromRt("@deepseek-ai/dsh-cmdline"),
	]);

	const basePatchPath = requireRt.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
	const patches = loadOverlayPatches("pideck-dsh", basePatchPath);
	patches.push({ id: "hmr", disabled: true });
	patches.push({ id: "session-telemetry-otel", disabled: true });
	for (const id of DSH_WEB_AGENT_PLANE_DISABLED) patches.push({ id, disabled: true });
	patches.push({
		insert: [
			// 0.1.5：storage/storage-json/storage-domain/session-projection-cache 由
			// dsh-base 补丁自带（配置一致），重复 insert 报 duplicate loader entry id。
			// api-gateway 行已废（dsh-host-apiproxy 停发），传输/端点改为
			// connection + api-remotes + api-session-controller 等 Typert Remote 组合
			// （镜像 src/main/dsh/hostEntry.ts，见 docs/dsh-0.1.5-typert-migration.md）。
			{ id: "session-stats", name: "@deepseek-ai/dsh-session-stats" },
			{ id: "workspace", name: "@deepseek-ai/dsh-workspace" },
			{ id: "connection", name: "@deepseek-ai/dsh-client-connection" },
			// fileUploads 服务（session-controller 的附件上传依赖）。
			{ id: "file-upload", name: "@deepseek-ai/dsh-client-file-upload" },
			{ id: "api-remotes", name: "@deepseek-ai/dsh-api-remotes" },
			{ id: "session-controller", name: "@deepseek-ai/dsh-api-session-controller" },
			{ id: "settings-controller", name: "@deepseek-ai/dsh-api-settings-controller" },
			{ id: "workspace-controller", name: "@deepseek-ai/dsh-api-workspace-controller" },
			{ id: "pideck-directory-picker", name: "./pideck-directory-picker.js" },
			{ id: "pideck-slash-bridge", name: "./pideck-slash-bridge.js" },
			{ id: "pideck-minimal-tool-filter", name: "./pideck-minimal-tool-filter.js" },
			{ id: "tool-pwsh-persistent", name: requireRt.resolve("dsh-tool-pwsh-persistent") },
			{
				id: "agent-presets",
				name: "@deepseek-ai/dsh-agent-presets",
				// 0.1.5：随包 system 根由插件自带（includeShippedRoot 默认），只声明默认。
				config: {
					default: "standard",
				},
			},
			{ id: "plugin-inventory", name: "@deepseek-ai/dsh-host-plugin-inventory" },
			{ id: "cordis-host-runner", name: "@deepseek-ai/dsh-cordis-host-runner" },
			{ id: "bill", name: requireRt.resolve("dsh-bill") },
		],
	});

	const ctx = await boot(
		"pideck-dsh",
		join(configDir, "cordis.yml"),
		patches,
		(hostCtx) => {
			provideCmdline(hostCtx, { args: [], exit: () => undefined });
		},
		pathToFileURL(nmRoot + "/").href,
	);
	console.log("BOOT OK — 插件树加载成功（runtime 自包含校验通过）");
	// 不上 await ctx.stop()：部分插件（storage/workspace）会起后台任务，优雅停止
	// 可能永久挂起；校验目的是「树能加载」，到此即成功，直接退出让进程回收全部资源。
	process.exit(0);
} catch (error) {
	console.error("BOOT FAILED — 插件树加载失败（归档缺运行文件）：");
	console.error(inspect(error, { depth: 4, colors: false, breakLength: 120 }));
	const walk = (e, depth = 0) => {
		const errs = e?.errors ?? e?.cause?.errors;
		if (!Array.isArray(errs)) return;
		for (const sub of errs) {
			const msg = sub instanceof Error ? sub.message : String(sub);
			console.error(`${"  ".repeat(depth)}- ${msg}`);
			walk(sub, depth + 1);
		}
	};
	walk(error);
	process.exit(1);
} finally {
	try {
		rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// 原生模块（node-pty 等）可能在 Windows 上短暂锁住文件；清理失败不影响校验结论
	}
}
