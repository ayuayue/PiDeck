import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 加载 enabledExtensionResolver.ts（会加载哪些扩展的查询；原生过滤 + 旧禁用记录）。 */
function loadResolverModule() {
	return loadTsCommonJs("src/main/extensions/enabledExtensionResolver.ts");
}

/** 在临时根下构造 ~/.pi/agent + <cwd>/.pi 项目目录骨架。返回各关键路径与写文件助手。 */
function setupFixtures() {
	const root = mkdtempSync(join(tmpdir(), "pideck-ext-resolver-"));
	const home = root; // 模拟 HOME：~/.pi/agent 落在 root/.pi/agent
	const agentDir = join(home, ".pi", "agent");
	const cwd = join(root, "project");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
	const put = (rel, content = "{}") => {
		const full = join(root, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content, "utf8");
		return full;
	};
	const mkdir = (rel) => {
		const full = join(root, rel);
		mkdirSync(full, { recursive: true });
		return full;
	};
	return { root, home, agentDir, cwd, put, mkdir };
}

function same(actual, expected) {
	// vm 沙箱数组与主 realm deepStrictEqual 可能因原型不同失败
	assert.deepEqual([...actual].sort(), [...expected].sort());
}

test("disabled 为空时返回全部会加载的扩展路径（不再是 null 白名单语义）", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		put(".pi/agent/extensions/a.ts", "export {}");
		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		assert.ok(Array.isArray(result), "迁移后没有白名单概念，查询必须始终返回数组");
		assert.ok(
			result.some((path) => path.endsWith("a.ts")),
			"未禁用的本地扩展应在列表里",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("有禁用项时：npm 包按 manifest 入口注入，禁用的剔除、未安装的跳过", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put, mkdir } = setupFixtures();
	try {
		put(
			".pi/agent/settings.json",
			JSON.stringify({
				packages: ["npm:pi-web-access", "npm:pi-mcp-adapter", "npm:pi-missing"],
			}),
		);
		put(
			".pi/agent/npm/node_modules/pi-web-access/package.json",
			JSON.stringify({
				pi: { extensions: ["src/index.ts"] },
			}),
		);
		put(".pi/agent/npm/node_modules/pi-web-access/src/index.ts", "// extension");
		put(
			".pi/agent/npm/node_modules/pi-mcp-adapter/package.json",
			JSON.stringify({
				pi: { extensions: ["index.ts"] },
			}),
		);
		put(".pi/agent/npm/node_modules/pi-mcp-adapter/index.ts", "// extension");

		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "npm:pi-mcp-adapter" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		assert.notEqual(result, null);
		same(result, [join(home, ".pi", "agent", "npm", "node_modules", "pi-web-access", "src", "index.ts")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("project packages 从项目 .pi/npm 注入，且 user/project 同名禁用相互独立", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put, mkdir } = setupFixtures();
	try {
		put(".pi/agent/settings.json", JSON.stringify({ packages: ["npm:pi-web-access"] }));
		put(
			".pi/agent/npm/node_modules/pi-web-access/package.json",
			JSON.stringify({
				pi: { extensions: ["index.ts"] },
			}),
		);
		put(".pi/agent/npm/node_modules/pi-web-access/index.ts", "// extension");
		put("project/.pi/settings.json", JSON.stringify({ packages: ["npm:pi-project-tool"] }));
		put(
			"project/.pi/npm/node_modules/pi-project-tool/package.json",
			JSON.stringify({
				pi: { extensions: ["index.ts"] },
			}),
		);
		put("project/.pi/npm/node_modules/pi-project-tool/index.ts", "// extension");

		// 只禁用 user 级 pi-web-access：project 条目不受牵连
		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "npm:pi-web-access" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		same(result, [join(cwd, ".pi", "npm", "node_modules", "pi-project-tool", "index.ts")]);

		// 禁用 project 同名 → project 条目剔除，user 条目保留
		const result2 = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "project", source: "npm:pi-project-tool" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		same(result2, [join(home, ".pi", "agent", "npm", "node_modules", "pi-web-access", "index.ts")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("本地 .ts 文件扩展：user/project 目录都扫，禁用按文件名剔除", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		put(".pi/agent/extensions/local-tool.ts", "// x");
		put(".pi/agent/extensions/orca.ts", "// x");
		put("project/.pi/extensions/proj-ext.ts", "// x");

		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "local-tool.ts" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		same(result, [join(home, ".pi", "agent", "extensions", "orca.ts"), join(cwd, ".pi", "extensions", "proj-ext.ts")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("目录扩展（index.ts / pi manifest）解析为入口文件路径", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		put(".pi/agent/extensions/my-dir/index.ts", "// entry");
		put(
			".pi/agent/extensions/pi-manifest-dir/package.json",
			JSON.stringify({
				pi: { extensions: ["src/main.ts"] },
			}),
		);
		put(".pi/agent/extensions/pi-manifest-dir/src/main.ts", "// entry");

		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "my-dir" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		same(result, [join(home, ".pi", "agent", "extensions", "pi-manifest-dir", "src", "main.ts")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("内置扩展注入：removedBuiltInExtensions 剔除 + 资源缺失跳过", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, mkdir } = setupFixtures();
	try {
		const extDir = mkdir("resources/extensions");
		writeFileSync(join(extDir, "pi-deck-todo.ts"), "// todo");
		writeFileSync(join(extDir, "pi-deck-plan-mode.ts"), "// plan");
		// pi-deck-vision.ts 故意不写 → 缺失跳过（listActiveBuiltInExtensionPaths 已过滤）

		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "npm:whatever" }],
			removedBuiltInExtensions: ["pi-deck-todo.ts"],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		const builtIns = (result ?? []).filter((p) => p.includes("pi-deck-"));
		same(builtIns, [join(extDir, "pi-deck-plan-mode.ts")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("全部禁用时返回空数组（≠ null）：调用方须仍加 --no-extensions", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		put(".pi/agent/extensions/solo.ts", "// x");
		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "solo.ts" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		assert.deepEqual([...result], []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("特殊字符扩展名（空格/中文/&）按字面匹配：spawn 数组传参无需转义，禁用按 source 精确命中", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		const special = "custom tools & more.ts";
		const chinese = "中文扩展.ts";
		put(`.pi/agent/extensions/${special}`, "// a");
		put(`.pi/agent/extensions/${chinese}`, "// b");
		put(".pi/agent/extensions/plain.ts", "// c");

		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: special }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		// 含特殊字符的禁用源被精确剔除，其余字面注入（pi 侧 resolvePath 只做 Unicode 空格规范化，
		// 普通空格/中文/& 均按字面处理）
		same(result, [join(home, ".pi", "agent", "extensions", chinese), join(home, ".pi", "agent", "extensions", "plain.ts")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目扩展禁用不误伤同 source 的全局扩展", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		const globalPath = put(".pi/agent/extensions/shared.ts", "export default () => {};");
		put("project/.pi/extensions/shared.ts", "export default () => {};");
		put("project/.pi/settings.json", JSON.stringify({ disabledExtensions: ["shared.ts"] }));
		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		assert.ok(result);
		same(result, [globalPath]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目继承覆盖只禁用全局 extension，保留同 source 项目资源", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		put(".pi/agent/extensions/shared.ts", "export default () => {};");
		const projectPath = put("project/.pi/extensions/shared.ts", "export default () => {};");
		put(
			"project/.pi/settings.json",
			JSON.stringify({
				pideckDisabledGlobalExtensions: ["shared.ts"],
			}),
		);
		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		assert.ok(result);
		same(result, [projectPath]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("拒绝项目 trust 时强制全局白名单且不显式注入项目扩展", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		const globalPath = put(".pi/agent/extensions/global.ts", "export default () => {};");
		put("project/.pi/extensions/project.ts", "export default () => {};");
		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			includeProjectResources: false,
			disabled: [],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		assert.ok(result);
		same(result, [globalPath]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("package extensions empty filter disables every manifest entry", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		put(
			".pi/agent/npm/node_modules/ext-pack/package.json",
			JSON.stringify({
				pi: { extensions: ["src/*.ts"] },
			}),
		);
		put(".pi/agent/npm/node_modules/ext-pack/src/a.ts", "// a");
		put(
			".pi/agent/settings.json",
			JSON.stringify({
				packages: [{ source: "npm:ext-pack", extensions: [] }],
			}),
		);
		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "missing" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		same(result, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("package extension filters apply glob then exact force overrides", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		const packageRoot = join(home, ".pi", "agent", "npm", "node_modules", "ext-pack");
		put(
			".pi/agent/npm/node_modules/ext-pack/package.json",
			JSON.stringify({
				pi: { extensions: ["src/*.ts"] },
			}),
		);
		put(".pi/agent/npm/node_modules/ext-pack/src/a.ts", "// a");
		put(".pi/agent/npm/node_modules/ext-pack/src/b.ts", "// b");
		put(
			".pi/agent/settings.json",
			JSON.stringify({
				packages: [
					{
						source: "npm:ext-pack",
						extensions: ["src/*.ts", "!src/b.ts", "+src/b.ts", "-src/a.ts"],
					},
				],
			}),
		);
		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "missing" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		same(result, [join(packageRoot, "src", "b.ts")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("project autoload:false extension package applies a delta over the user install", () => {
	const { resolveLoadableExtensionPaths } = loadResolverModule();
	const { root, home, cwd, put } = setupFixtures();
	try {
		const packageRoot = join(home, ".pi", "agent", "npm", "node_modules", "ext-pack");
		put(
			".pi/agent/npm/node_modules/ext-pack/package.json",
			JSON.stringify({
				pi: { extensions: ["src/*.ts"] },
			}),
		);
		put(".pi/agent/npm/node_modules/ext-pack/src/a.ts", "// a");
		put(".pi/agent/npm/node_modules/ext-pack/src/b.ts", "// b");
		put(".pi/agent/settings.json", JSON.stringify({ packages: ["npm:ext-pack"] }));
		put(
			"project/.pi/settings.json",
			JSON.stringify({
				packages: [{ source: "npm:ext-pack", extensions: ["!src/b.ts"], autoload: false }],
			}),
		);
		const result = resolveLoadableExtensionPaths({
			agentHomeDir: home,
			cwd,
			disabled: [{ scope: "user", source: "missing" }],
			removedBuiltInExtensions: [],
			builtInRoots: { appPath: root, resourcesPath: root, isDev: true },
		});
		same(result, [join(packageRoot, "src", "a.ts")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
