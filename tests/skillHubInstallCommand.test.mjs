/**
 * skillHubInstallCommand 契约测试。
 *
 * 背景回归：skill-hub 安装此前在 Windows 上直接 execFile("npx.cmd", ...)，
 * Node 24（Electron 43 内置 Node 24.18 同款）对 .cmd/.bat 直 spawn 报同步
 * EINVAL，导致所有 skill 安装失败。详见 skillHubInstallCommand.ts 头注释。
 * 本测试把「win32 必须走 cmd.exe /d /s /c 包装」固化为契约，防止退回 .cmd 直调。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildSkillHubInstallCommand } = loadTsCommonJs("src/main/skills/skillHubInstallCommand.ts");

test("win32：无 --skill 时经 cmd.exe /d /s /c 包装，命令串与选项顺序正确", () => {
	const { command, args } = buildSkillHubInstallCommand({
		pkg: "anthropics/skills",
		global: true,
		platform: "win32",
	});
	// Windows cmd 包装必然是指向 cmd.exe 的数组调用，而不是 npx.cmd 直 spawn
	// （ComSpec 存在时 command 是完整择径的 cmd.exe，故用 endsWith 判断）
	assert.ok(command.toLowerCase().endsWith("cmd.exe"), command);
	assert.deepEqual([...args.slice(0, 3)], ["/d", "/s", "/c"]);
	assert.equal(args[3], "npx skills add anthropics/skills --agent pi --global --yes");
});

test("win32：带 --skill 与项目作用域时命令串包含 --skill 且不带 --global", () => {
	const { args } = buildSkillHubInstallCommand({
		pkg: "anthropics/skills",
		skillName: "pdf",
		global: false,
		platform: "win32",
	});
	assert.equal(args[3], "npx skills add anthropics/skills --agent pi --skill pdf --yes");
});

test("非 Windows 平台保持 npx 数组直调（无 cmd 包装）", () => {
	const { command, args } = buildSkillHubInstallCommand({
		pkg: "anthropics/skills",
		skillName: "pdf",
		global: true,
		platform: "darwin",
	});
	assert.equal(command, "npx");
	// loadTsCommonJs 跨 realm 返回的数组原型不同，deepStrictEqual 会误报，退用逐项断言
	assert.deepEqual([...args], ["skills", "add", "anthropics/skills", "--agent", "pi", "--skill", "pdf", "--global", "--yes"]);
});

test("回归锁：任何平台返回的 command 都不得是 .cmd/.bat 直 spawn（EINVAL 根因）", () => {
	for (const platform of ["win32", "darwin", "linux"]) {
		const { command, args } = buildSkillHubInstallCommand({
			pkg: "a/b",
			platform,
		});
		assert.ok(!command.toLowerCase().endsWith(".cmd") && !command.toLowerCase().endsWith(".bat"), `${platform} 平台 command 不应为 .cmd/.bat: ${command}`);
		assert.ok(
			args.every((a) => !a.toLowerCase().startsWith("npx.cmd")),
			`${platform} 平台参数不应以 npx.cmd 开头`,
		);
	}
});
