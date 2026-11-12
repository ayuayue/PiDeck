import { readdirSync, readFileSync } from "node:fs";

const entryPath = "src/renderer/src/previewApi.ts";
const previewDirectory = "src/renderer/src/preview";

/**
 * 预览/浏览器模式 API 的源码：组装入口 + 按命名空间域拆出的 `preview/*.ts`。
 * 契约测试扫描这里，而不是只扫 `previewApi.ts`——否则拆分后断言会随搬迁失效。
 */
export const previewApiSources = [
	{ path: entryPath, source: readFileSync(entryPath, "utf8") },
	...readdirSync(previewDirectory)
		.filter((name) => name.endsWith(".ts"))
		.sort()
		.map((name) => {
			const path = `${previewDirectory}/${name}`;
			return { path, source: readFileSync(path, "utf8") };
		}),
];

export const previewApiSource = previewApiSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
