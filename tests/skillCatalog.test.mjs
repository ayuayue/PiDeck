/**
 * 通用技能目录扫描（skillCatalog）：DSH 文件系统 provider 的只读复刻。
 *
 * 这是「pi/dsh 共用读 SKILL.md」的第一层：frontmatter 解析、根目录 rank 合并、
 * 目录 bundle / 扁平 md、.system 跳过、项目根（最近 .git）解析、并集合并。
 * 目标是保证草稿期扫描结果与 host 目录不冲突（同名 host 优先）且不会漏静态根。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const catalog = loadTsCommonJs("src/main/skills/skillCatalog.ts");

/** VM realm 的数组/对象与宿主 realm 原型不同：断言前拍平成普通 JSON。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 内存扫描 IO：directories 映射目录项；files 映射文件内容（缺省 = 读取失败/不存在）。 */
function createIo(directories, files) {
	return {
		async listDirectory(path) {
			const entries = directories[path];
			if (entries === undefined) throw new Error("ENOENT");
			return entries.map((entry) => ({ name: entry.name, type: entry.type }));
		},
		async readTextHead(path) {
			return files[path];
		},
	};
}

function dir(name) {
	return { name, type: "directory" };
}
function file(name) {
	return { name, type: "file" };
}

const sk = (name, description, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n`;
const flat = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`;

test("parseSkillFrontmatter：pi 基础字段 + DSH 布尔策略（disable-model-invocation / user-invocable）", () => {
	assert.deepEqual(plain(catalog.parseSkillFrontmatter("---\nname: demo\ndescription: Demo skill\n---\n\nbody")), { name: "demo", description: "Demo skill", modelInvocable: true, userInvocable: true });
	assert.deepEqual(plain(catalog.parseSkillFrontmatter("---\nname: demo\ndescription: Demo\nwhenToUse: 当需要演示时\ndisable-model-invocation: true\nuser-invocable: false\n---\n")), {
		name: "demo",
		description: "Demo",
		whenToUse: "当需要演示时",
		modelInvocable: false,
		userInvocable: false,
	});
	assert.deepEqual(plain(catalog.parseSkillFrontmatter("---\r\nname: 'quoted'\r\ndescription: \"quoted desc\"\r\n---\r\n")), { name: "quoted", description: "quoted desc", modelInvocable: true, userInvocable: true });
	assert.deepEqual(plain(catalog.parseSkillFrontmatter("no frontmatter here")), { modelInvocable: true, userInvocable: true });
});

test("scanSkillRoot：目录 bundle + 根层扁平 md；缺 name/description、读取失败、非 md 都跳过", async () => {
	const root = { path: "/root", rank: 100, source: "project-dsh" };
	const bundleFile = join("/root", "bundle", "SKILL.md");
	const flatFile = join("/root", "flat.md");
	const io = createIo({ "/root": [dir("bundle"), dir("broken"), dir("no-frontmatter"), file("flat.md"), file("readme.txt")] }, { [bundleFile]: sk("bundle-skill", "Bundle skill"), [join("/root", "no-frontmatter", "SKILL.md")]: "no frontmatter", [flatFile]: flat("flat-skill", "Flat skill") });
	const skills = await catalog.scanSkillRoot(root, io);
	assert.deepEqual(plain(skills.map((skill) => skill.name)), ["bundle-skill", "flat-skill"]);
	assert.deepEqual(plain(skills.map((skill) => skill.source)), ["project-dsh", "project-dsh"]);
	assert.deepEqual(plain(skills.map((skill) => skill.rank)), [100, 100]);
	assert.equal(skills[0].path, bundleFile);
	assert.equal(skills[0].dir, join("/root", "bundle"));
	assert.equal(skills[1].path, flatFile);
	assert.equal(skills[1].dir, "/root");
});

test("scanSkillRoot：user-dsh 根跳过 .system；单个目录读取失败不影响其它技能", async () => {
	const root = { path: "/user", rank: 400, source: "user-dsh", skipSystem: true };
	const io = createIo({ "/user": [dir(".system"), dir("ok"), dir("bad")] }, { [join("/user", ".system", "SKILL.md")]: sk("system-skill", "hidden"), [join("/user", "ok", "SKILL.md")]: sk("ok-skill", "ok") });
	const skills = await catalog.scanSkillRoot(root, io);
	assert.deepEqual(plain(skills.map((skill) => skill.name)), ["ok-skill"]);
});

test("scanSkillRoots：同名技能按 rank 小者胜，最终按 name 排序", async () => {
	const io = createIo(
		{ "/project": [dir("dup")], "/user": [dir("dup"), dir("user-only")] },
		{
			[join("/project", "dup", "SKILL.md")]: sk("dup", "project version"),
			[join("/user", "dup", "SKILL.md")]: sk("dup", "user version"),
			[join("/user", "user-only", "SKILL.md")]: sk("user-only", "user only"),
		},
	);
	const skills = await catalog.scanSkillRoots(
		[
			{ path: "/user", rank: 400, source: "user-dsh", skipSystem: true },
			{ path: "/project", rank: 100, source: "project-dsh" },
		],
		io,
	);
	assert.deepEqual(plain(skills.map((skill) => [skill.name, skill.description, skill.rank])), [
		["dup", "project version", 100],
		["user-only", "user only", 400],
	]);
});

test("resolveSkillProjectRoot：向上找最近 .git；找不到时回退 cwd", async () => {
	// 用 fromCharCode(92) 处理 Windows 分隔符，避免测试源码里的反斜杠转义噪音。
	const sep = String.fromCharCode(92);
	const normalize = (path) =>
		String(path)
			.split(sep)
			.join("/")
			.replace(/\/\.git$/, "");
	const gitDirs = new Set(["C:/repo", "C:/repo/apps"]);
	const pathExists = async (path) => gitDirs.has(normalize(path));
	assert.equal(await catalog.resolveSkillProjectRoot("C:/repo/apps/web", pathExists), resolve("C:/repo/apps"));
	assert.equal(await catalog.resolveSkillProjectRoot("C:/outside/deep", pathExists), resolve("C:/outside/deep"));
});

test("dshSkillRoots：rank 顺序与 DSH provider 对齐，custom/user/bundled 齐全", () => {
	const roots = catalog.dshSkillRoots({
		projectRoot: "/repo",
		dshHome: "/dsh",
		agentsHome: "/agents",
		customSkillDirs: ["/custom"],
		bundledSkillDir: "/bundled",
	});
	assert.deepEqual(plain(roots.map((root) => [root.path, root.rank, root.source, Boolean(root.skipSystem)])), [
		[join("/repo", ".dsh", "skills"), 100, "project-dsh", false],
		[join("/repo", ".agents", "skills"), 200, "project-agents", false],
		["/custom", 300, "custom", false],
		[join("/dsh", "skills"), 400, "user-dsh", true],
		[join("/agents", "skills"), 500, "user-agents", false],
		["/bundled", 600, "bundled", false],
	]);
	const withoutProject = catalog.dshSkillRoots({ dshHome: "/dsh", agentsHome: "/agents" });
	assert.deepEqual(plain(withoutProject.map((root) => root.path)), [join("/dsh", "skills"), join("/agents", "skills")]);
});

test("listDshFilesystemSkills：真实目录端到端——项目/user/agents 根合并，过滤 user-invocable:false 与非法名", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-skill-catalog-"));
	try {
		const project = join(base, "project");
		const dshHome = join(base, "dsh-home");
		const agentsHome = join(base, "agents-home");
		await mkdir(join(project, ".git"), { recursive: true });
		await mkdir(join(project, ".dsh", "skills", "project-skill"), { recursive: true });
		await writeFile(join(project, ".dsh", "skills", "project-skill", "SKILL.md"), sk("project-skill", "Project skill"));
		await mkdir(join(project, ".agents", "skills"), { recursive: true });
		await writeFile(join(project, ".agents", "skills", "flat-skill.md"), flat("flat-skill", "Flat skill"));
		await mkdir(join(dshHome, "skills", "user-skill"), { recursive: true });
		await writeFile(join(dshHome, "skills", "user-skill", "SKILL.md"), sk("user-skill", "User skill"));
		await mkdir(join(dshHome, "skills", ".system", "system-skill"), { recursive: true });
		await writeFile(join(dshHome, "skills", ".system", "system-skill", "SKILL.md"), sk("system-skill", "System skill"));
		await mkdir(join(agentsHome, "skills", "restricted"), { recursive: true });
		await writeFile(join(agentsHome, "skills", "restricted", "SKILL.md"), sk("restricted", "User only", "user-invocable: false\n"));
		await mkdir(join(agentsHome, "skills", "Bad_Name"), { recursive: true });
		await writeFile(join(agentsHome, "skills", "Bad_Name", "SKILL.md"), sk("Bad_Name", "Bad name"));
		const skills = await catalog.listDshFilesystemSkills({ projectPath: join(project, "sub", "dir"), dshHome, agentsHome });
		assert.deepEqual(plain(skills.map((skill) => skill.name)), ["flat-skill", "project-skill", "user-skill"]);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
