import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 资源管理器池（W1）：按 PiResourceTarget 隔离 + 设置变更失效 + 本机行为不变。
 *
 * 断言按行为：同一 WSL 身份的四类管理器实例稳定复用；两个身份拿到的实例不同；身份改 distro/user
 * 后按新 cacheKey 重建；解析失败回稳定码且不留缓存；本机目标永远返回装配注入的单例，且绝不
 * 对这些单例调用 configureWsl（旧全局切换路径）。
 */

const shared = loadTsCommonJs("src/shared/piConfig.ts");
const poolModule = loadTsCommonJs("src/main/config/PiResourceManagerPool.ts");
const wslPaths = loadTsCommonJs("src/main/wsl/WslPaths.ts");
const { PromptManager } = loadTsCommonJs("src/main/prompts/PromptManager.ts");

/** 只有一个 WSL 目标，身份（distro/user）由主进程设置决定。 */
const WSL_TARGET = () => ({ target: { kind: "wsl" } });

function environment(distro = "Ubuntu-26.04", user = "dev") {
	return wslPaths.createWslEnvironment(distro, user, "/home/" + user);
}

function resolution({ distro = "Ubuntu-26.04", user = "dev" } = {}) {
	const env = environment(distro, user);
	return { kind: "wsl", cacheKey: "wsl:" + distro + ":" + user, home: env.windowsHome, distro, user, environment: env };
}

function fakeManager(name, locale) {
	return {
		name,
		locale,
		configureWsl() {
			throw new Error("shared/local manager must never be reconfigured: " + name);
		},
	};
}

function createHarness(options = {}) {
	const created = [];
	const local = {
		skills: fakeManager("local-skills", options.local),
		prompts: fakeManager("local-prompts", options.local),
		extensions: fakeManager("local-extensions", options.local),
		xuePrompts: fakeManager("local-xue", options.local),
	};
	const resolverCalls = [];
	const resolver = {
		resolve: async (target) => {
			resolverCalls.push(target);
			if (options.resolve) return await options.resolve(target, resolverCalls.length);
			throw new Error("unexpected wsl target " + JSON.stringify(target));
		},
	};
	const factories = {
		skills: (input) => {
			created.push({ kind: "skills", ...input });
			return fakeManager("skills:" + input.home, input.home);
		},
		prompts: (input) => {
			created.push({ kind: "prompts", ...input });
			return fakeManager("prompts:" + input.home, input.home);
		},
		extensions: (input) => {
			created.push({ kind: "extensions", ...input });
			return fakeManager("extensions:" + input.home, input.home);
		},
		xuePrompts: (input) => {
			created.push({ kind: "xuePrompts", ...input });
			return fakeManager("xue:" + input.home, input.home);
		},
	};
	const pool = poolModule.createPiResourceManagerPool({ resolver, local: { skills: () => local.skills, prompts: () => local.prompts, extensions: () => local.extensions, xuePrompts: () => local.xuePrompts }, create: factories, maxScopes: options.maxScopes });
	return { pool, local, created, resolverCalls };
}

test("本机目标返回装配单例：不调用解析器、不创建实例、不 configureWsl", async () => {
	const { pool, local, created, resolverCalls } = createHarness();
	const strip = (value) => JSON.parse(JSON.stringify(value));
	assert.equal(await pool.skills(undefined), local.skills);
	assert.equal(await pool.prompts({}), local.prompts);
	assert.equal(await pool.prompts({ target: { kind: "local" } }), local.prompts);
	assert.equal(await pool.extensions(null), local.extensions);
	assert.equal(await pool.xuePrompts(strip({ target: { kind: "local" } })), local.xuePrompts);
	assert.equal(resolverCalls.length, 0);
	assert.equal(created.length, 0);
	assert.equal(pool.scopeCount(), 0);
});

test("同一 WSL 目标复用实例；身份（distro/user）变了才换实例且各只属于自己 HOME", async () => {
	let current = resolution();
	const { pool, created, local } = createHarness({ resolve: async () => current });

	const a1 = await pool.skills(WSL_TARGET());
	const a2 = await pool.skills(WSL_TARGET());
	assert.equal(a1, a2);
	assert.equal(a1.locale, resolution().home);

	for (const kind of ["prompts", "extensions", "xuePrompts"]) {
		const first = await pool[kind](WSL_TARGET());
		const second = await pool[kind](WSL_TARGET());
		assert.equal(first, second, kind + " should be cached per identity");
	}

	// 开发设置里换成另一个发行版/用户：cacheKey 变了，必须是新实例。
	current = resolution({ distro: "Ubuntu-24.04", user: "root" });
	const b1 = await pool.skills(WSL_TARGET());
	await pool.extensions(WSL_TARGET());
	assert.notEqual(a1, b1);
	assert.equal(b1.locale, current.home);
	assert.equal(pool.scopeCount(), 2, "两个身份各自保留自己的作用域直到被淘汰");

	// 切回原身份：缓存里还是原来那个实例，不会把新身份的管理器还给它。
	current = resolution();
	const back = await pool.skills(WSL_TARGET());
	assert.equal(back, a1);
	// 扩展与提示词库工厂拿到的是该身份解析出的 environment（构造期绑定发行版）。
	const extensionCreate = created.filter((entry) => entry.kind === "extensions");
	assert.deepEqual(JSON.parse(JSON.stringify(extensionCreate.map((entry) => entry.environment.distro).sort())), ["Ubuntu-24.04", "Ubuntu-26.04"]);
	// 本机单例没有被任何 WSL 目标重配置（旧全局 configureWsl 路径已不存在）。
	assert.equal(typeof local.skills.configureWsl, "function");
});

test("身份改 distro/user 后旧实例不再被返回，旧作用域不会被当成新身份", async () => {
	let current = resolution();
	const { pool, created } = createHarness({ resolve: async () => current });
	const first = await pool.skills(WSL_TARGET());
	assert.equal(pool.scopeCount(), 1);

	current = resolution({ distro: "Ubuntu-24.04", user: "root" });
	const second = await pool.skills(WSL_TARGET());
	assert.notEqual(first, second);
	assert.equal(second.locale, current.home);
	assert.deepEqual(JSON.parse(JSON.stringify(created.map((entry) => entry.home))), [first.locale, current.home]);
});

test("解析失败回稳定码且清空全部作用域（不静默复用旧实例）", async () => {
	let removed = false;
	const { pool } = createHarness({
		resolve: async () => {
			if (removed) throw new Error(shared.PI_RESOURCE_CODES.unavailable);
			return resolution();
		},
	});
	const manager = await pool.skills(WSL_TARGET());
	assert.equal(pool.scopeCount(), 1);
	removed = true;
	await assert.rejects(pool.skills(WSL_TARGET()), { message: shared.PI_RESOURCE_CODES.unavailable });
	// 身份失效（WSL 关掉/改坏）时池整体作废：下一次配置回来不会复用旧 HOME。
	pool.invalidate();
	assert.equal(pool.scopeCount(), 0);
	assert.ok(manager, "old instance must not be reused after invalidation");
});

test("非法目标与 ssh 目标在解析器之前失败，回闭集稳定码", async () => {
	const { pool, resolverCalls, created } = createHarness();
	const strip = (value) => JSON.parse(JSON.stringify(value));
	await assert.rejects(pool.skills({ target: { kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111" } }), { message: shared.PI_RESOURCE_CODES.sshUnsupported });
	await assert.rejects(pool.prompts(strip({ target: { kind: "wsl", hostId: "nope" } })), { message: shared.PI_RESOURCE_CODES.targetInvalid });
	await assert.rejects(pool.extensions({ target: { kind: "local" }, force: true }), { message: shared.PI_RESOURCE_CODES.targetInvalid });
	assert.equal(resolverCalls.length, 0);
	assert.equal(created.length, 0);
});

test("作用域缓存有上限：超过 maxScopes 先淘汰最旧的身份", async () => {
	const identities = [resolution({ user: "u0" }), resolution({ user: "u1" }), resolution({ user: "u2" })];
	let current = identities[0];
	const { pool, created } = createHarness({ maxScopes: 2, resolve: async () => current });
	await pool.skills(WSL_TARGET());
	current = identities[1];
	await pool.skills(WSL_TARGET());
	assert.equal(pool.scopeCount(), 2);
	current = identities[2];
	await pool.skills(WSL_TARGET());
	assert.equal(pool.scopeCount(), 2);
	// 第一个身份被淘汰：再访问必须是新实例。
	current = identities[0];
	const readded = await pool.skills(WSL_TARGET());
	assert.equal(pool.scopeCount(), 2);
	assert.equal(created.filter((entry) => entry.home === identities[0].home).length, 2);
	assert.ok(readded);
});

test("真实 PromptManager 实例被限制在解析出的 HOME 下（两个身份写读互不可见）", async () => {
	const homeA = await mkdtemp(join(tmpdir(), "pideck-w1-a-"));
	const homeB = await mkdtemp(join(tmpdir(), "pideck-w1-b-"));
	try {
		await mkdir(join(homeA, ".pi", "agent", "prompts"), { recursive: true });
		await mkdir(join(homeB, ".pi", "agent", "prompts"), { recursive: true });
		await writeFile(join(homeA, ".pi", "agent", "prompts", "alpha.md"), "---\ndescription: only in A\n---\n", "utf8");

		const byHome = { [homeA]: { ...resolution(), home: homeA }, [homeB]: { ...resolution({ user: "root" }), home: homeB } };
		let current = byHome[homeA];
		const pool = poolModule.createPiResourceManagerPool({
			resolver: { resolve: async () => current },
			local: { skills: () => null, prompts: () => null, extensions: () => null, xuePrompts: () => null },
			create: {
				skills: () => null,
				prompts: ({ home }) => new PromptManager(home),
				extensions: () => null,
				xuePrompts: () => null,
			},
		});

		const managerA = await pool.prompts(WSL_TARGET());
		current = byHome[homeB];
		const managerB = await pool.prompts(WSL_TARGET());
		const listA = await managerA.list();
		const listB = await managerB.list();
		assert.equal(listA.templates.map((template) => template.name).join(","), "alpha");
		assert.equal(listA.globalDir, join(homeA, ".pi", "agent", "prompts"));
		assert.equal(listB.templates.length, 0);
		assert.equal(listB.globalDir, join(homeB, ".pi", "agent", "prompts"));

		// 在 B 里新建只落在 B 的 HOME；A 看不到、A 的文件未被改动。
		await managerB.create({ name: "beta", description: "only in B" });
		assert.match(await readFile(join(homeB, ".pi", "agent", "prompts", "beta.md"), "utf8"), /description: only in B/);
		assert.equal((await managerA.list()).templates.map((template) => template.name).join(","), "alpha");
	} finally {
		await rm(homeA, { recursive: true, force: true });
		await rm(homeB, { recursive: true, force: true });
	}
});
test("真实 SkillManager 实例只扫描解析出的 HOME（两个身份技能互不可见）", async () => {
	const homeA = await mkdtemp(join(tmpdir(), "pideck-w1-skills-a-"));
	const homeB = await mkdtemp(join(tmpdir(), "pideck-w1-skills-b-"));
	try {
		const skillDir = join(homeA, ".pi", "agent", "skills", "alpha");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: only in A\n---\n\n# alpha\n", "utf8");

		const { SkillManager } = loadTsCommonJs("src/main/skills/SkillManager.ts", {
			stubs: { electron: { app: { isPackaged: false, getAppPath: () => process.cwd() } } },
		});
		const byHome = { [homeA]: { ...resolution(), home: homeA }, [homeB]: { ...resolution({ user: "root" }), home: homeB } };
		let current = byHome[homeA];
		const pool = poolModule.createPiResourceManagerPool({
			resolver: { resolve: async () => current },
			local: { skills: () => null, prompts: () => null, extensions: () => null, xuePrompts: () => null },
			create: {
				skills: ({ home }) => new SkillManager(home),
				prompts: () => null,
				extensions: () => null,
				xuePrompts: () => null,
			},
		});
		const managerA = await pool.skills(WSL_TARGET());
		current = byHome[homeB];
		const managerB = await pool.skills(WSL_TARGET());
		const listA = await managerA.list();
		const listB = await managerB.list();
		assert.deepEqual(JSON.parse(JSON.stringify(listA.skills.map((skill) => skill.name))), ["alpha"]);
		assert.deepEqual(JSON.parse(JSON.stringify(listB.skills)), []);
		for (const location of managerA.getLocations()) assert.ok(location.path.startsWith(homeA), location.path);
		for (const location of managerB.getLocations()) assert.ok(location.path.startsWith(homeB), location.path);
	} finally {
		await rm(homeA, { recursive: true, force: true });
		await rm(homeB, { recursive: true, force: true });
	}
});
