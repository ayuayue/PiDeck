import { readdirSync, readFileSync } from "node:fs";

const entryPath = "src/preload/index.ts";
const apiDirectory = "src/preload/api";

/**
 * preload 暴露面的源码：组装入口 + 按命名空间域拆出的 `src/preload/api/*.ts`。
 *
 * 契约测试断言的是「这条通道/这个方法在 preload 里长什么样」，不是「它在哪个文件里」；
 * 拆分后只读 `index.ts` 会看不到域文件里的转发，断言假绿。只读一层目录（不递归全仓）。
 */
export const preloadSources = [
	{ path: entryPath, source: readFileSync(entryPath, "utf8") },
	...readdirSync(apiDirectory)
		.filter((name) => name.endsWith(".ts"))
		.sort()
		.map((name) => {
			const path = `${apiDirectory}/${name}`;
			return { path, source: normalizeRelativeDepth(readFileSync(path, "utf8")) };
		}),
];

/**
 * `api/*.ts` 比 `index.ts` 深一层，同一个引用在拆分前写作 `"../shared/…"`、拆分后必须写作
 * `"../../shared/…"`。断言扫的是「引用了哪个类型/通道」，与目录深度无关，因此这里按拆分前的
 * 单文件口径归一化，让拆分不改变任何源码正则的含义。
 */
function normalizeRelativeDepth(source) {
	return source.replace(/"\.\.\/\.\.\//g, '"../');
}

export const preloadSource = preloadSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
