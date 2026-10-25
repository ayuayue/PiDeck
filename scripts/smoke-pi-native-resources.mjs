/**
 * pi 原生资源管理真实冒烟（A 系列端到端验证）。
 *
 * 全程隔离：PI_CODING_AGENT_DIR 指向临时目录，cwd 为临时项目，不读写真实 ~/.pi。
 * 对 0.99.2（官方安装器）与 1.0.0（nvm 全局）各跑一遍同一组断言。
 *
 * 用法：node scripts/smoke-pi-native-resources.mjs <pi二进制> <标签>
 * 依赖 scripts/smoke-pi-native-loadService.mjs / smoke-pi-native-loadMigration.mjs（同目录）。
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const PI_BIN = process.argv[2];
const LABEL = process.argv[3] || PI_BIN;
const ROOT = process.env.SMOKE_ROOT ?? `/tmp/pideck-smoke/run-${LABEL.replace(/[^a-z0-9.]/gi, "-")}`;
const AGENT = join(ROOT, "agent");
const PROJECT = join(ROOT, "project");

// ── 环境搭建 ────────────────────────────────────────────────
function resetEnv() {
	rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(join(AGENT, "skills"), { recursive: true });
	mkdirSync(join(AGENT, "extensions"), { recursive: true });
	mkdirSync(join(PROJECT, ".pi"), { recursive: true });
	// 预信任项目（trust.json：{ "<abs path>": true }）：未信任时 pi 不读项目 .pi/settings.json，
	// 项目层覆盖用例会静默失效。
	writeFileSync(join(AGENT, "trust.json"), JSON.stringify({ [PROJECT]: true }, null, 2), "utf8");
	writeSkill("smoke-skill", "冒烟测试技能：用于验证原生过滤是否真的生效。");
}

function writeSkill(name, description) {
	const dir = join(AGENT, "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody\n`, "utf8");
	return join(dir, "SKILL.md");
}

function writeExtension(name, commandName) {
	const file = join(AGENT, "extensions", `${name}.ts`);
	writeFileSync(file, `export default function (pi) {\n\tpi.registerCommand(${JSON.stringify(commandName)}, {\n\t\tdescription: "smoke ext command",\n\t\thandler: async (args, ctx) => { ctx.ui.notify("smoke"); },\n\t});\n}\n`, "utf8");
	return file;
}

function writeAgentSettings(settings) {
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
}

function readAgentSettings() {
	if (!existsSync(join(AGENT, "settings.json"))) return {};
	return JSON.parse(readFileSync(join(AGENT, "settings.json"), "utf8"));
}

// ── RPC 会话驱动 ────────────────────────────────────────────
/** 启动一次 RPC 会话，发 get_commands，返回命令列表；超时/异常直接失败。 */
function runRpc(options = {}) {
	return new Promise((resolve, reject) => {
		const args = ["--mode", "rpc", "--no-session", "--offline", "--no-themes"];
		const env = {
			...process.env,
			PI_CODING_AGENT_DIR: AGENT,
			// 隔离任何宿主代理/凭据干扰
			NO_COLOR: "1",
		};
		delete env.PI_OFFLINE;
		const child = spawn(PI_BIN, args, { cwd: PROJECT, env, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`RPC 超时（30s）。stderr: ${err.slice(-600)}`));
		}, 30_000);
		const lines = [];
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			out += chunk;
			let idx;
			while ((idx = out.indexOf("\n")) !== -1) {
				const line = out.slice(0, idx).trim();
				out = out.slice(idx + 1);
				if (line) lines.push(line);
			}
			const commandsResp = lines
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return null;
					}
				})
				.find((r) => r?.type === "response" && r?.command === "get_commands");
			if (commandsResp) {
				clearTimeout(timer);
				child.stdin.end();
				resolve(commandsResp);
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.stdin.write(JSON.stringify({ id: "smoke", type: "get_commands" }) + "\n");
	});
}

async function getCommands() {
	const resp = await runRpc();
	if (!resp.success) throw new Error("get_commands 失败: " + JSON.stringify(resp).slice(0, 300));
	return resp.data.commands;
}

// ── 断言工具 ────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
	if (cond) {
		passed += 1;
		console.log(`  ✔ ${name}`);
	} else {
		failed += 1;
		console.log(`  ✖ ${name}${detail ? " — " + detail : ""}`);
	}
}

// ── 场景 ────────────────────────────────────────────────────
async function main() {
	console.log(`\n===== 冒烟：${LABEL}（${PI_BIN}）=====`);

	// 1) 基线：技能 + 自定义扩展命令 + 内置 mcp 都注册
	resetEnv();
	const skillPath = writeSkill("smoke-skill", "冒烟测试技能：用于验证原生过滤是否真的生效。");
	const extPath = writeExtension("smoke-ext", "smoke-ext-cmd");
	let commands = await getCommands();
	const names = commands.map((c) => c.name);
	check("基线：技能注册为 skill:smoke-skill", names.includes("skill:smoke-skill"), JSON.stringify(names.slice(0, 20)));
	check("基线：自定义扩展命令注册", names.includes("smoke-ext-cmd"), JSON.stringify(names.slice(0, 20)));
	const mcpCmd = commands.find((c) => c.name === "mcp");
	check("基线：内置 mcp 命令存在", Boolean(mcpCmd));
	check("基线：mcp 的 sourceInfo.path 为 builtin:mcp（M3 依赖）", mcpCmd?.sourceInfo?.path === "builtin:mcp", JSON.stringify(mcpCmd?.sourceInfo ?? null));

	// 2) 原生停用技能：-<SKILL.md 绝对路径>
	writeAgentSettings({ skills: [`-${skillPath}`] });
	commands = await getCommands();
	check(
		"原生 -路径 停用技能：skill:smoke-skill 消失",
		!commands.some((c) => c.name === "skill:smoke-skill"),
		commands
			.map((c) => c.name)
			.filter((n) => n.includes("smoke"))
			.join(","),
	);
	check(
		"原生停用技能不影响其它命令",
		commands.some((c) => c.name === "smoke-ext-cmd"),
	);

	// 3) 裸目录名不生效（pi 只认相对/绝对路径；冒烟校准点，曾误以为匹配 parentName）
	writeAgentSettings({ skills: ["-smoke-skill"] });
	commands = await getCommands();
	check(
		"裸目录名不停用技能（pi 只认相对/绝对路径）",
		commands.some((c) => c.name === "skill:smoke-skill"),
		"若消失说明 pi 匹配了裸名，需重新校准投影",
	);

	// 3b) 父目录相对路径（pi config 的真实写法；baseDir=agentDir → parentRel = skills/<name>）
	writeAgentSettings({ skills: ["-skills/smoke-skill"] });
	commands = await getCommands();
	check("原生 -skills/<名> 停用技能（parentRel 形态）", !commands.some((c) => c.name === "skill:smoke-skill"));

	// 4) 原生恢复：+<路径>（注意 pi 顺序是 排除→+→-，同值的 - 会压过 +，所以只写 +）
	writeAgentSettings({ skills: [`+${skillPath}`] });
	commands = await getCommands();
	check(
		"原生 +路径 启用技能",
		commands.some((c) => c.name === "skill:smoke-skill"),
	);

	// 5) 原生停用扩展文件：-<绝对路径>
	writeAgentSettings({ extensions: [`-${extPath}`] });
	commands = await getCommands();
	check(
		"原生 -路径 停用扩展：smoke-ext-cmd 消失",
		!commands.some((c) => c.name === "smoke-ext-cmd"),
		commands
			.map((c) => c.name)
			.filter((n) => n.includes("smoke"))
			.join(","),
	);
	check(
		"原生停用扩展不影响技能",
		commands.some((c) => c.name === "skill:smoke-skill"),
	);

	// 6) 原生停用内置扩展：-builtin:mcp
	writeAgentSettings({ extensions: ["-builtin:mcp"] });
	commands = await getCommands();
	check("原生 -builtin:mcp 停用内置 MCP（mcp 命令消失）", !commands.some((c) => c.name === "mcp"));
	check(
		"原生停用内置 MCP 不影响自定义扩展",
		commands.some((c) => c.name === "smoke-ext-cmd"),
	);
	// codemode 是工具不是命令（get_commands 不会列出），无法在此断言；跳过。

	// 7) 项目层覆盖：项目 +builtin:mcp 覆盖全局 -builtin:mcp（项目已在 trust.json 预信任）
	writeAgentSettings({ extensions: ["-builtin:mcp"] });
	writeFileSync(join(PROJECT, ".pi", "settings.json"), JSON.stringify({ extensions: ["+builtin:mcp"] }), "utf8");
	commands = await getCommands();
	check(
		"项目 +builtin:mcp 覆盖全局 -builtin:mcp",
		commands.some((c) => c.name === "mcp"),
	);
	// 7b) 未信任项目不读项目配置：清空 trust 后同样写 +builtin:mcp 应不生效（安全边界）
	writeFileSync(join(AGENT, "trust.json"), "{}", "utf8");
	commands = await getCommands();
	check("未信任项目不读项目 .pi 配置（mcp 维持全局停用）", !commands.some((c) => c.name === "mcp"));
	writeFileSync(join(AGENT, "trust.json"), JSON.stringify({ [PROJECT]: true }, null, 2), "utf8");

	// 8) 迁移端到端：旧禁用记录 → 原生规则 → pi 真的不加载
	resetEnv();
	const legacySkillPath = writeSkill("legacy-skill", "用于验证迁移端到端。");
	writeAgentSettings({});
	// 模拟 PiDeck 旧状态：disabledSkills=["legacy-skill"]（名字记录）
	const { PiResourceConfigService } = await import("./smoke-pi-native-loadService.mjs");
	const service = new PiResourceConfigService(
		{ globalSettingsPath: () => join(AGENT, "settings.json"), resolveProject: async () => null },
		{ packageKey: () => "k", savePackageSnapshot: () => {}, markPackageSnapshotAfter: () => {}, takePackageSnapshot: () => undefined, isPackageSnapshotCurrent: () => false, clearPackageSnapshot: () => {}, recordMigration: () => {}, readMigration: () => undefined },
		{},
	);
	const migration = await import("./smoke-pi-native-loadMigration.mjs");
	const plan = migration.planResourceMigration({
		legacy: {
			global: { disabledExtensions: [], disabledSkills: ["legacy-skill"], disabledPrompts: [], disableExtensionWhitelist: false },
			project: { disabledExtensions: [], disabledSkills: [], disabledPrompts: [], inheritedExtensions: [], inheritedSkills: [], inheritedPrompts: [] },
		},
		resources: [{ kind: "skills", name: "legacy-skill", value: legacySkillPath, scope: "user" }],
	});
	check("迁移计划：旧 disabledSkills 生成 1 条原生停用动作", plan.actions.length === 1 && plan.actions[0].value === legacySkillPath, JSON.stringify(plan.actions));
	const report = await migration.applyResourceMigration({ plan, service, state: { recordMigration: () => {}, readMigration: () => undefined }, migrationKey: "smoke" });
	check("迁移执行成功", report.ok && report.applied === 1, JSON.stringify(report).slice(0, 200));
	const after = readAgentSettings();
	check("迁移写入了原生 skills 规则", Array.isArray(after.skills) && after.skills.some((e) => e === `-${legacySkillPath}`), JSON.stringify(after.skills));
	commands = await getCommands();
	check(
		"迁移后 pi 真的不加载该技能（端到端）",
		!commands.some((c) => c.name === "skill:legacy-skill"),
		commands
			.map((c) => c.name)
			.filter((n) => n.includes("legacy"))
			.join(","),
	);

	console.log(`\n  结果：${passed} 通过 / ${failed} 失败`);
	if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
	console.error("冒烟异常：", e);
	process.exitCode = 1;
});
