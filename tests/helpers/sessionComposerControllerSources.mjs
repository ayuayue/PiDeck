import { existsSync, readdirSync, readFileSync } from "node:fs";

const entryPath = "src/renderer/src/hooks/useSessionComposerController.ts";
const composerHooksDirectory = "src/renderer/src/hooks/session/composer";

/**
 * 会话输入框控制器源码：宿主 `useSessionComposerController.ts` + 按域拆出的
 * `hooks/session/composer/*.ts`。
 *
 * 一批契约测试按**源码文本**断言行为（粘贴优先级链、忙碌投递语义、键盘接管、
 * 生图/生视频占位消息、历史回溯…）。这些规则按域搬进子 hook 后，断言该看的是
 * 「这一片域是否还有这条规则」，而不是「规则还写在哪个文件里」——拆文件不该被
 * 读成行为消失。因此断言内容一个字都不改，只把读取面从单文件换成这份聚合
 * （与 sessionTimelineControllerSources / configModalSources / mainIpcSources 同一套路）。
 *
 * 只列这一层明确目录，不递归全仓：聚合面越窄，断言命中才还有意义。
 */
export const sessionComposerControllerSources = [
	{ path: entryPath, source: readFileSync(entryPath, "utf8") },
	...(existsSync(composerHooksDirectory) ? readdirSync(composerHooksDirectory) : [])
		.filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
		.sort()
		.map((name) => {
			const path = `${composerHooksDirectory}/${name}`;
			return { path, source: readFileSync(path, "utf8") };
		}),
];

export const sessionComposerControllerSource = sessionComposerControllerSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
