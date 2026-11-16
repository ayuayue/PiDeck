import { existsSync, readdirSync, readFileSync } from "node:fs";

const entryPath = "src/renderer/src/hooks/useSessionTimelineController.ts";
const sessionTimelineHooksDirectory = "src/renderer/src/hooks/session/timeline";

/**
 * 时间线控制器源码：宿主 `useSessionTimelineController.ts` + 按域拆出的
 * `hooks/session/timeline/*.ts(x)`。
 *
 * 若干契约测试按**源码文本**断言行为（分页序号、锚点 entryId 归一、顶部补偿、
 * 整表渲染开关…）。这些规则按域搬进子 hook 后，断言该看的是「这一片域是否还有这条规则」，
 * 而不是「规则还写在哪一个文件里」——拆文件不该被误读成行为消失。因此断言内容一个字都不改，
 * 只把读取面从单文件换成这份聚合（与 mainIpcSources / preloadSources / configModalSources 同一套路）。
 *
 * 只列这一层明确目录，不递归全仓：聚合面越窄，断言命中才还有意义。
 */
export const sessionTimelineControllerSources = [
	{ path: entryPath, source: readFileSync(entryPath, "utf8") },
	...(existsSync(sessionTimelineHooksDirectory) ? readdirSync(sessionTimelineHooksDirectory) : [])
		.filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
		.sort()
		.map((name) => {
			const path = `${sessionTimelineHooksDirectory}/${name}`;
			return { path, source: readFileSync(path, "utf8") };
		}),
];

export const sessionTimelineControllerSource = sessionTimelineControllerSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
