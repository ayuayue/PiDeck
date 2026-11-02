/**
 * Agent 记忆挂载（纯计算 + mcp.json 合并）的守卫测试。
 *
 * 守的是「写用户文件」这条边界：只动自己那一项、幂等、损坏文件不抢修、可撤销。
 * 这些都是静态断言能证明的，不需要启动 Electron。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectKeyFromPath } from "../resources/agent-memory/paths.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const mounts = loadTsCommonJs("src/main/agentMemory/agentMemoryMounts.ts");
const registration = loadTsCommonJs("src/main/agentMemory/AgentMemoryMcpRegistration.ts");

const APP = {
	userData: join(tmpdir(), "pideck-memory-tests"),
	home: join(tmpdir(), "pideck-home"),
	execPath: "/opt/PiDeck/pideck",
	isPackaged: true,
	appPath: "/opt/PiDeck/resources/app.asar",
	resourcesPath: "/opt/PiDeck/resources",
};

/** 注册相关用例指到仓库里真实存在的脚本：注册器会检查 args[0]，缺失则拒绝留悬空条目。 */
const REAL_SCRIPT = join(process.cwd(), "resources", "agent-memory", "server.mjs");
const realMount = { ...mounts.buildAgentMemoryMountForApp(APP), args: [REAL_SCRIPT] };

test("挂载：env 只带显式字段，会话来源与 cwd 都编码进环境变量", () => {
	const mount = mounts.buildAgentMemoryMountForApp({ ...APP, cwd: "D:/work/app" });

	// 必须以 Node 身份运行：服务器依赖 node:sqlite（FTS5），Electron 主进程二进制走 ELECTRON_RUN_AS_NODE
	assert.equal(mount.env.ELECTRON_RUN_AS_NODE, "1");
	assert.equal(mount.command, APP.execPath);
	// 打包态脚本来自 extraResources；开发态来自仓库 resources/
	assert.equal(mount.args[0], join(APP.resourcesPath, "agent-memory", "server.mjs"));
	assert.equal(mounts.resolveAgentMemoryServerPath({ isPackaged: false, appPath: "/repo", resourcesPath: "/repo/node_modules/electron/dist/resources" }), join("/repo", "resources", "agent-memory", "server.mjs"));
	// 记忆根固定在 userData/memory：用户可备份、可手改
	assert.equal(mount.env.PIDECK_AGENT_MEMORY_DIR, join(APP.userData, "memory"));
	assert.equal(mount.env.PIDECK_AGENT_MEMORY_CWD, "D:/work/app");
	const sources = JSON.parse(mount.env.PIDECK_AGENT_MEMORY_SOURCES);
	assert.deepEqual(
		sources.map((source) => [source.backend, source.dir]),
		[
			["pi", join(APP.home, ".pi", "agent", "sessions")],
			["acp", join(APP.userData, "acp-sessions")],
		],
	);
	// 没有 cwd 时不写空值：环境变量为空会让服务器把项目键算成空串
	assert.equal(mounts.buildAgentMemoryMountForApp(APP).env.PIDECK_AGENT_MEMORY_CWD, undefined);
});

test("ACP：mcpServers 项是协议要求的 stdio 形态（name/command/args/env）", () => {
	const mount = mounts.buildAgentMemoryMountForApp({ ...APP, cwd: "D:/work/app" });
	const [server] = mounts.buildAcpMcpServers(mount);
	assert.equal(server.name, "pideck-agent-memory");
	assert.equal(server.command, APP.execPath);
	assert.deepEqual(server.args, mount.args);
	// ACP 的 McpServerStdio.env 是 EnvVariable[]：传对象会被 agent 的 schema 拒成 -32602 Invalid params
	assert.ok(Array.isArray(server.env), "env 必须是数组，不能是对象映射");
	for (const item of server.env) {
		assert.deepEqual(Object.keys(item).sort(), ["name", "value"], "env 项只能是 {name, value}");
		assert.equal(typeof item.value, "string");
	}
	const envMap = Object.fromEntries(server.env.map((item) => [item.name, item.value]));
	// 不 deepEqual 整个对象：TS 模块跨 realm 加载，原型不同会被误判，按字段断言
	assert.deepEqual(Object.keys(envMap).sort(), Object.keys(mount.env).sort());
	for (const [name, value] of Object.entries(mount.env)) assert.equal(envMap[name], value, `${name} 在数组形式里丢失或改值`);
});

test("mcp.json 合并：只增改自己那一项，其它服务器与顶层键原样保留", () => {
	const entry = mounts.buildPiMcpEntry(mounts.buildAgentMemoryMountForApp(APP));
	const existing = {
		$schema: "https://example.com/mcp.schema.json",
		mcpServers: { magpie: { url: "http://127.0.0.1:3425/mcp" }, "pideck-cua": { url: "http://127.0.0.1:1/mcp", exposure: "direct" } },
	};
	const plan = mounts.planPiMcpRegistration(existing, entry);
	assert.equal(plan.changed, true);
	assert.equal(plan.next.$schema, existing.$schema, "顶层未知键不能被吞");
	assert.deepEqual(plan.next.mcpServers.magpie, existing.mcpServers.magpie);
	assert.deepEqual(plan.next.mcpServers["pideck-cua"], existing.mcpServers["pideck-cua"]);
	// exposure 必须是 direct：默认 codemode 下工具不声明给模型，装了也等于没装
	assert.equal(plan.next.mcpServers["pideck-agent-memory"].exposure, "direct");
	// 幂等：同内容再算一次不应写盘
	assert.equal(mounts.planPiMcpRegistration(plan.next, entry).changed, false);
	// 空文件/无 mcpServers 也能建
	assert.equal(mounts.planPiMcpRegistration(undefined, entry).next.mcpServers["pideck-agent-memory"].exposure, "direct");
});

test("mcp.json 合并：mcpServers 形状不对时报错而不是抢修覆盖", () => {
	const entry = mounts.buildPiMcpEntry(mounts.buildAgentMemoryMountForApp(APP));
	// 跨 vm realm 的对象原型不同：deepStrictEqual 会误判，这里按字段断言
	assert.equal(mounts.planPiMcpRegistration({ mcpServers: [] }, entry).error, "invalid-config");
	assert.equal(mounts.planPiMcpRegistration({ mcpServers: "nope" }, entry).error, "invalid-config");
});

test("注册落盘：幂等写入、保留他人条目、可撤销", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pideck-mcp-json-"));
	const mcpPath = join(agentDir, "mcp.json");
	writeFileSync(mcpPath, JSON.stringify({ mcpServers: { magpie: { url: "http://127.0.0.1:3425/mcp" } } }), "utf8");
	const mount = realMount;

	const first = registration.ensureAgentMemoryMcpRegistered(mount, { agentDir });
	assert.equal(first.written, true);
	const written = JSON.parse(readFileSync(mcpPath, "utf8"));
	assert.ok(written.mcpServers["pideck-agent-memory"], "新条目必须落盘");
	assert.deepEqual(written.mcpServers.magpie, { url: "http://127.0.0.1:3425/mcp" }, "别人的条目不能被覆盖");

	// 第二次启动：内容一致，不重写用户文件
	assert.equal(registration.ensureAgentMemoryMcpRegistered(mount, { agentDir }).written, false);

	const removed = registration.unregisterAgentMemoryMcp({ agentDir });
	assert.equal(removed.removed, true);
	const after = JSON.parse(readFileSync(mcpPath, "utf8"));
	assert.equal(after.mcpServers["pideck-agent-memory"], undefined);
	assert.ok(after.mcpServers.magpie);
	// 再撤一次是无操作
	assert.equal(registration.unregisterAgentMemoryMcp({ agentDir }).removed, false);
});

test("注册落盘：损坏的 mcp.json 不覆盖（宁可记忆不可用，也不破坏用户配置）", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pideck-mcp-broken-"));
	const mcpPath = join(agentDir, "mcp.json");
	writeFileSync(mcpPath, "{ this is not json", "utf8");
	const result = registration.ensureAgentMemoryMcpRegistered(realMount, { agentDir });
	assert.equal(result.written, false);
	assert.equal(result.skipped, "unreadable");
	assert.equal(readFileSync(mcpPath, "utf8"), "{ this is not json");
});

test("注册落盘：脚本不存在时不写悬空条目（卸载/回滚后不让 pi 每个会话报 spawn 失败）", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pideck-mcp-missing-"));
	const mount = { ...realMount, args: [join(agentDir, "no-such-server.mjs")] };
	const result = registration.ensureAgentMemoryMcpRegistered(mount, { agentDir });
	assert.equal(result.written, false);
	assert.equal(result.skipped, "server-missing");
	assert.equal(existsSync(join(agentDir, "mcp.json")), false, "拒绝注册时连文件都不该创建");
});

test("项目作用域键：由 cwd 派生且稳定，跨后端共享同一份项目记忆", () => {
	// 同一个项目在 pi / ACP / 终端里 cwd 相同 → 键相同 → 记忆互通
	assert.equal(projectKeyFromPath("C:\\Users\\me\\proj"), projectKeyFromPath("C:/Users/me/proj"));
	assert.match(projectKeyFromPath("C:/Users/me/proj"), /^[A-Za-z0-9._-]{1,128}$/);
	assert.notEqual(projectKeyFromPath("C:/a/one"), projectKeyFromPath("C:/a/two"));
	// 空/非法输入返回空串（调用方据此拒绝写项目作用域）
	assert.equal(projectKeyFromPath(""), "");
	assert.equal(projectKeyFromPath(undefined), "");
	// 超长路径仍落在目录名允许的 128 字符内且不同前缀不撞
	const long = `C:/${"very-long-directory-name/".repeat(10)}`;
	const longB = `${long}other`;
	assert.ok(projectKeyFromPath(long).length <= 128);
	assert.notEqual(projectKeyFromPath(long), projectKeyFromPath(longB));
});

test("记忆目录不落在仓库里：一切路径都在 userData/home 之下", () => {
	const mount = mounts.buildAgentMemoryMountForApp(APP);
	for (const value of [mount.env.PIDECK_AGENT_MEMORY_DIR, ...JSON.parse(mount.env.PIDECK_AGENT_MEMORY_SOURCES).map((s) => s.dir)]) {
		assert.ok(value.startsWith(APP.userData) || value.startsWith(APP.home), `${value} 必须位于应用数据目录`);
	}
	assert.ok(!existsSync(join(process.cwd(), "memory")), "不得在 cwd 下创建记忆目录");
});

test("设置开关：开→注册、再开→不重写、关→只删自己那一项、再关→不碰文件", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pideck-mcp-toggle-"));
	const mcpPath = join(agentDir, "mcp.json");
	writeFileSync(mcpPath, JSON.stringify({ mcpServers: { magpie: { url: "http://127.0.0.1:3425/mcp" } } }), "utf8");
	const sync = (enabled) => registration.syncAgentMemoryRegistration({ enabled, mount: realMount, agentDir });

	assert.equal(sync(true).action, "registered");
	const written = JSON.parse(readFileSync(mcpPath, "utf8"));
	assert.ok(written.mcpServers["pideck-agent-memory"]);
	assert.ok(written.mcpServers.magpie, "开启时也不动别人的条目");

	assert.equal(sync(true).action, "unchanged", "内容没变就不该重写用户文件");

	const before = readFileSync(mcpPath, "utf8");
	assert.equal(sync(false).action, "unregistered");
	const after = JSON.parse(readFileSync(mcpPath, "utf8"));
	assert.equal(after.mcpServers["pideck-agent-memory"], undefined);
	assert.ok(after.mcpServers.magpie, "关闭时别人的条目必须留着");

	const snapshot = readFileSync(mcpPath, "utf8");
	assert.equal(sync(false).action, "absent");
	assert.equal(readFileSync(mcpPath, "utf8"), snapshot, "本来就关着时不该改写文件");
	assert.notEqual(before, snapshot);
});

test("设置开关：脚本缺失时报告 unavailable 而不是写悬空条目", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pideck-mcp-toggle-missing-"));
	const mount = { ...realMount, args: [join(agentDir, "no-such-server.mjs")] };
	const result = registration.syncAgentMemoryRegistration({ enabled: true, mount, agentDir });
	assert.equal(result.action, "unavailable");
	assert.equal(existsSync(join(agentDir, "mcp.json")), false);
});
