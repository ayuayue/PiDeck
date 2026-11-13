import { existsSync, readdirSync, readFileSync } from "node:fs";

const entryPath = "src/renderer/src/App.tsx";
const workbenchDirectory = "src/renderer/src/components/workbench";

/**
 * 渲染层工作台装配源码：装配入口 `App.tsx` + 按形态拆出的 `components/workbench/*.tsx`。
 * 契约测试扫描这里，而不是只扫 `App.tsx`——否则装配层再拆一次，断言会随搬迁失效。
 * 目录不存在时按空处理，拆走最后一个文件也不会让读源失败。
 */
const appHookDirectory = "src/renderer/src/hooks/app";
const appHookFiles = ["useAppProjectActions.ts", "useAppSidebarActions.ts", "useSessionTabsAssembly.ts", "useAppSessionPaneServices.tsx", "useAppFileTreeTransfer.ts"];

/**
 * 装配层的域 hook：项目记录动作（useAppProjectActions）、侧栏动作装配（useAppSidebarActions）、
 * 会话 Tab 栏装配（useSessionTabsAssembly）、会话栏服务装配（useAppSessionPaneServices）
 * 与文件树传输（useAppFileTreeTransfer）。它们承载的闸门/文案/装配顺序属于 App 装配契约，
 * 契约测试随搬迁一起看这些文件。
 */
export const rendererAppSources = [
	{ path: entryPath, source: readFileSync(entryPath, "utf8") },
	...appHookFiles.map((name) => {
		const path = `${appHookDirectory}/${name}`;
		return { path, source: readFileSync(path, "utf8") };
	}),
	...(existsSync(workbenchDirectory) ? readdirSync(workbenchDirectory) : [])
		.filter((name) => name.endsWith(".tsx"))
		.sort()
		.map((name) => {
			const path = `${workbenchDirectory}/${name}`;
			return { path, source: readFileSync(path, "utf8") };
		}),
];

export const rendererAppSource = rendererAppSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
