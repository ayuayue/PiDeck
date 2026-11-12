import { existsSync, readdirSync, readFileSync } from "node:fs";

const entryPath = "src/renderer/src/ConfigModal.tsx";
const configModalDirectory = "src/renderer/src/config/configModal";

/**
 * 配置弹窗源码：外壳 `ConfigModal.tsx` + 按 Tab/域拆出的 `config/configModal/*.ts(x)`。
 * 契约测试扫描这里，而不是只扫 `ConfigModal.tsx`——否则再拆一次 Tab，断言会随搬迁失效。
 * 目录不存在时按空处理，拆走最后一个文件也不会让读源失败。
 */
export const configModalSources = [
	{ path: entryPath, source: readFileSync(entryPath, "utf8") },
	...(existsSync(configModalDirectory) ? readdirSync(configModalDirectory) : [])
		.filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
		.sort()
		.map((name) => {
			const path = `${configModalDirectory}/${name}`;
			return { path, source: readFileSync(path, "utf8") };
		}),
];

export const configModalSource = configModalSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
