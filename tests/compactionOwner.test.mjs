import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 「谁在管上下文窗口」的判定：pi 的压缩会被扩展用 session_before_compact 钩子整体取消
 * （Magic Context 默认接管；billion-context-pi 无手动入口）。判定结果决定 PiDeck 手动压缩
 * 是走 native RPC、改写成扩展命令，还是明确拒绝——判错就会回到「点了没反应」。
 *
 * 注意：模块在 vm 里加载，跨 realm 的数组原型不同，断言一律比较字符串。
 */

const { MAGIC_CONTEXT_WRAPUP_COMMAND, collectPackageNames, ownerNamesLoadedInPaths, packageNameFromSource, parseJsonc, readPiCompactionOwnership, invalidatePiCompactionOwnershipCache, resolvePiCompactionOwnership } = loadTsCommonJs("src/main/pi/compactionOwner.ts");

const { compactRoutedCommand, compactOwnerReason } = loadTsCommonJs("src/shared/compactFeedback.ts");

const MC = "@cortexkit/pi-magic-context";
const BC = "billion-context-pi";

/** owners 数组 → "a,b"（跨 realm 安全比较）。 */
const ids = (result) => result.owners.join(",");

test("package sources resolve to package names across npm/git/local forms", () => {
	assert.equal(packageNameFromSource("npm:@cortexkit/pi-magic-context@0.42.5"), MC);
	assert.equal(packageNameFromSource("npm:@cortexkit/pi-magic-context"), MC);
	assert.equal(packageNameFromSource("npm:billion-context-pi"), BC);
	assert.equal(packageNameFromSource("npm:pi-web-access@1.2.3"), "pi-web-access");
	// 非 npm 源不该被认成接管者
	assert.equal(packageNameFromSource("git:github.com/a/b"), "git:github.com/a/b");
	assert.equal(collectPackageNames(["npm:pi-tracker", { source: `npm:${MC}@0.42.5` }, 42]).join(","), `pi-tracker,${MC}`);
});

test("jsonc parsing tolerates comments and trailing commas", () => {
	const parsed = parseJsonc(`{
		// line comment
		"enabled": true, /* block comment */
		"compaction": { "enabled": false, },
		"historian": { "pi": { "model": "a//b" } },
	}`);
	assert.equal(parsed.enabled, true);
	assert.equal(parsed.compaction.enabled, false);
	// 字符串里的 // 不能被当成注释
	assert.equal(parsed.historian.pi.model, "a//b");
	assert.equal(parseJsonc("{ broken"), null);
});

test("magic-context owns compaction by default, even without a historian model", () => {
	const result = resolvePiCompactionOwnership({ packages: [`npm:${MC}@0.42.5`] });
	assert.equal(ids(result), "magic-context");
	assert.equal(result.conflicted, false);
	// 没有 config 文件（compaction.enabled 缺省 true）→ 接管
	assert.equal(result.manualCommand, MAGIC_CONTEXT_WRAPUP_COMMAND);
	// historian 未配置 → 它自己也压不了，这一条必须能提示给用户
	assert.equal(result.ownerReady, false);
	assert.equal(
		result.notes.some((note) => note.includes("historian")),
		true,
	);
});

test("config gates: compaction.enabled=false hands the window back, enabled=false disables MC", () => {
	assert.equal(
		ids(
			resolvePiCompactionOwnership({
				packages: [`npm:${MC}`],
				magicContextConfig: { compaction: { enabled: false } },
			}),
		),
		"",
	);
	assert.equal(
		ids(
			resolvePiCompactionOwnership({
				packages: [`npm:${MC}`],
				magicContextConfig: { enabled: false },
			}),
		),
		"",
	);
	// historian 模型配好 + 仍在接管 → 可改写，且不再提示「压不了」
	const ready = resolvePiCompactionOwnership({
		packages: [`npm:${MC}`],
		magicContextConfig: { historian: { pi: { model: "anthropic/claude-haiku-4-5" } } },
	});
	assert.equal(ready.ownerReady, true);
	assert.equal(ids(ready), "magic-context");
	// omp harness 的模型块同样算配好（同一份配置被两个宿主读）
	assert.equal(
		resolvePiCompactionOwnership({
			packages: [`npm:${MC}`],
			magicContextConfig: { historian: { omp: { model: "opencode/claude-haiku-4-5" } } },
		}).ownerReady,
		true,
	);
});

test("disabled extension entries cannot own compaction", () => {
	assert.equal(ids(resolvePiCompactionOwnership({ packages: [`npm:${MC}`], disabledExtensions: [MC] })), "");
	assert.equal(ids(resolvePiCompactionOwnership({ packages: [`npm:${BC}`], disabledExtensions: [BC] })), "");
});

test("billion-context owns compaction but offers no manual command", () => {
	const result = resolvePiCompactionOwnership({ packages: [`npm:${BC}`] });
	assert.equal(ids(result), "billion-context");
	assert.equal(result.manualCommand, undefined);
	assert.equal(result.ownerReady, true);
	// acp.json enabled:false 时不注册钩子
	assert.equal(
		ids(
			resolvePiCompactionOwnership({
				packages: [`npm:${BC}`],
				billionContextConfig: { enabled: false },
			}),
		),
		"",
	);
});

test("two owners at once are reported as a conflict", () => {
	const result = resolvePiCompactionOwnership({ packages: [`npm:${MC}`, `npm:${BC}`] });
	assert.equal(ids(result), "magic-context,billion-context");
	assert.equal(result.conflicted, true);
	assert.equal(
		result.notes.some((note) => note.includes("多个")),
		true,
	);
	// pi 自己的自动压缩开关只进说明，不影响接管事实
	assert.equal(resolvePiCompactionOwnership({ packages: [`npm:${MC}`], piCompaction: { enabled: false } }).piAutoCompactionEnabled, false);
	assert.equal(resolvePiCompactionOwnership({ packages: [`npm:${MC}`], piCompaction: { enabled: true } }).piAutoCompactionEnabled, true);
});

test("manual command is dropped when the session does not register it", () => {
	// get_commands 里没有 ctx-wrapup（compaction-off 模式 / 子会话）→ 不能改写，只能说明
	const result = resolvePiCompactionOwnership({
		packages: [`npm:${MC}`],
		sessionCommandNames: ["ctx-status", "compact"],
	});
	assert.equal(result.manualCommand, undefined);
	assert.equal(
		result.notes.some((note) => note.includes("/ctx-wrapup")),
		true,
	);
	// 命令名带 / 前缀也要认
	assert.equal(
		resolvePiCompactionOwnership({
			packages: [`npm:${MC}`],
			sessionCommandNames: ["/ctx-wrapup"],
		}).manualCommand,
		MAGIC_CONTEXT_WRAPUP_COMMAND,
	);
	// 探测失败（没给命令名单）不阻碍改写
	assert.equal(resolvePiCompactionOwnership({ packages: [`npm:${MC}`] }).manualCommand, MAGIC_CONTEXT_WRAPUP_COMMAND);
});

test("readPiCompactionOwnership reads the real file layout and refreshes on change", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-compaction-owner-"));
	try {
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(join(home, ".config", "cortexkit"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: [`npm:${MC}@0.42.5`], compaction: { enabled: true } }));
		// MC 配置缺失 → 缺省接管
		const before = readPiCompactionOwnership({ agentHomeDir: home });
		assert.equal(ids(before), "magic-context");
		assert.equal(before.piAutoCompactionEnabled, true);

		writeFileSync(
			join(home, ".config", "cortexkit", "magic-context.jsonc"),
			`{
				// 用户在用户级配置里交回上下文窗口
				"compaction": { "enabled": false },
			}`,
		);
		const after = readPiCompactionOwnership({ agentHomeDir: home });
		assert.equal(ids(after), "");

		invalidatePiCompactionOwnershipCache();
		assert.equal(ids(readPiCompactionOwnership({ agentHomeDir: home })), "");
	} finally {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {}
	}
});

test("loaded extension paths override the packages list (PiDeck-disabled extensions are not owners)", () => {
	// 白名单解析给出实际加载的路径（含 Windows 反斜杠与 scoped 包名）→ 以它为准
	assert.equal(ownerNamesLoadedInPaths(["C:\\Users\\u\\.pi\\agent\\npm\\node_modules\\@cortexkit\\pi-magic-context\\dist\\index.js", "C:\\Users\\u\\.pi\\agent\\npm\\node_modules\\pi-tracker\\dist\\index.js"]).join(","), "magic-context");
	// billion 被禁用（不在路径集合里）→ 即使 packages 里还有它的记录也不算接管者
	const onlyMagic = resolvePiCompactionOwnership({
		packages: [`npm:${MC}`, `npm:${BC}`],
		loadedOwnerNames: ["magic-context"],
	});
	assert.equal(ids(onlyMagic), "magic-context");
	assert.equal(onlyMagic.conflicted, false);
	// 两个都在路径集合里 → 冲突
	assert.equal(
		resolvePiCompactionOwnership({
			packages: [`npm:${MC}`, `npm:${BC}`],
			loadedOwnerNames: ["magic-context", "billion-context"],
		}).conflicted,
		true,
	);
	// 一个都没加载 → 没有接管者（原生 compact 可用）
	assert.equal(ids(resolvePiCompactionOwnership({ packages: [`npm:${MC}`], loadedOwnerNames: [] })), "");
	// readPiCompactionOwnership 透传 loadedExtensionPaths（null=无白名单 → 退回 packages）
	const home = mkdtempSync(join(tmpdir(), "pideck-compaction-owner-paths-"));
	try {
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: [`npm:${MC}`, `npm:${BC}`] }));
		assert.equal(
			ids(
				readPiCompactionOwnership({
					agentHomeDir: home,
					loadedExtensionPaths: [`C:\\u\\.pi\\agent\\npm\\node_modules\\@cortexkit\\pi-magic-context\\dist\\index.js`],
				}),
			),
			"magic-context",
		);
		assert.equal(ids(readPiCompactionOwnership({ agentHomeDir: home, loadedExtensionPaths: null })), "magic-context,billion-context");
	} finally {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {}
	}
});

test("shared markers parse back into the command and reason the renderer shows", () => {
	assert.equal(compactRoutedCommand("Compaction routed to extension command: /ctx-wrapup"), "/ctx-wrapup");
	assert.equal(compactRoutedCommand("Compaction cancelled by user abort"), null);
	assert.equal(compactOwnerReason("Compaction cancelled by session_before_compact hook: 该扩展取消了 pi 的压缩"), "该扩展取消了 pi 的压缩");
	assert.equal(compactOwnerReason("Compaction cancelled"), null);
});
