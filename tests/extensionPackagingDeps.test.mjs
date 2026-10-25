import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 打包契约：resources/extensions/*.ts 的运行时裸导入，pi 扩展加载器只按扩展文件
 * 所在目录向上查 node_modules（见 2026-08-09 线上事故：打包版缺 undici 导致
 * pi 启动即退出 code=1，全部消息发送失败）。因此凡非 node 内置、非 pi 自带
 * （@earendil-works/*）的依赖，都必须经 extraResources 复制进
 * extensions/node_modules/<pkg>，并在 dependencies 中显式声明以保证顶层安装。
 */

// pi 扩展加载器自身可解析的包（实证：打包版成功加载 pi-deck-ask-question/todo，
// 仅 undici 解析失败）。新包不在此列时必须先验证打包版能解析再入列。
const PI_PROVIDED = /^(?:@earendil-works\/.*|typebox)$/;

function collectBareImports() {
	const dir = "resources/extensions";
	const specs = new Set();
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
		const source = readFileSync(join(dir, file), "utf8");
		// 逐行匹配，跳过 import type（编译期擦除，不参与运行时解析）
		for (const line of source.split("\n")) {
			if (/^\s*import\s+type\b/.test(line)) continue;
			const m = line.match(/(?:from|import|require\()\s*["']([^"']+)["']/);
			if (!m) continue;
			const spec = m[1];
			if (spec.startsWith("node:") || spec.startsWith(".") || spec.startsWith("/")) continue;
			if (PI_PROVIDED.test(spec)) continue;
			// 裸导入取包名（scoped 取两段）
			const parts = spec.split("/");
			specs.add(parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
		}
	}
	return [...specs];
}

test("extension runtime deps are packaged next to extensions", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const targets = new Set((pkg.build?.extraResources ?? []).map((e) => e.to));
	for (const dep of collectBareImports()) {
		assert.ok(targets.has(`extensions/node_modules/${dep}`), `扩展依赖 ${dep} 缺少 extraResources 映射 extensions/node_modules/${dep}，打包后 pi 将启动失败`);
		assert.ok(pkg.dependencies?.[dep], `扩展依赖 ${dep} 必须声明在 dependencies（保证顶层 hoisting 供 extraResources 复制）`);
		assert.ok(existsSync(join("node_modules", dep, "package.json")), `扩展依赖 ${dep} 未安装在顶层 node_modules`);
	}
});

/**
 * 2026-09-15 线上事故回归：热更新覆盖层（<userData>/builtin-extensions/）上层没有
 * node_modules，vendored 依赖必须由 BuiltInExtensionsUpdater 一并复制进覆盖层
 * （VENDOR_DEP_PACKAGE_NAMES）。新增扩展运行时依赖时两边必须同步——漏了覆盖层这条
 * 就是「打包版正常、热更新后 pi 启动失败、全部扩展被禁用」。
 */
test("extension runtime deps are covered by the updater's vendored package list", async () => {
	const { loadTsCommonJs: load } = await import("./helpers/loadTsCommonJs.mjs");
	const updaterModule = load("src/main/extensions/builtInExtensionsUpdater.ts");
	const vendorNames = [...updaterModule.VENDOR_DEP_PACKAGE_NAMES];
	assert.deepEqual([...collectBareImports()].sort(), [...vendorNames].sort(), "VENDOR_DEP_PACKAGE_NAMES 必须与扩展运行时裸导入集合一致（缺了覆盖层解析不到，多了白占空间）");
});
