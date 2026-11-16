import { readFileSync } from "node:fs";

/**
 * AppUtils 源码聚合：入口 `AppUtils.ts` + 按域拆出的 `components/app/appUtils/*.ts`。
 *
 * 入口已退化为纯转发（barrel），实现按域分散在同级目录；契约测试扫描这里，而不是只扫
 * 入口——否则域再拆一次、或实现从入口搬走，只读源码的断言会整片失效（2026-11 拆分）。
 *
 * 顺序有意义：入口排第一。`thinkingStreamChannel` 用 `indexOf("function flushThinking()")`
 * + 定长切片断言分组内部结构；切片落在 groupMessages.ts 内部即可，与拆分前一致。
 */
const entryPath = "src/renderer/src/components/app/AppUtils.ts";
const domainDirectory = "src/renderer/src/components/app/appUtils";

/**
 * 显式文件清单（不扫目录）：新增/删除域文件必须同步这里，避免「以为扫到了、
 * 其实没扫」的静默漏断言。每行末尾注释说明这个文件是什么域。
 */
const domainFiles = [
	"fileNodeDrag.ts", // 文件树拖拽负载（MIME / 读写 / @ 引用）
	"textFormat.ts", // 思考标签剥离、时间格式化、消息摘要
	"pathMatch.ts", // 关键词匹配、~ 友好路径、文件树展平
	"renderTypes.ts", // 时间线条目类型（MessageItem / AgentRunItem…）
	"renderEquality.ts", // 渲染等价判断（memo 比较入口）
	"reconcileRuns.ts", // 渲染列表引用复用
	"groupMessages.ts", // 消息分组装配（回合边界）
	"outline.ts", // 会话定位轴（buildOutline）
	"composerTrigger.ts", // @ / & 触发识别与应用
	"commandMenu.ts", // `/` 菜单可见性与内置命令补齐
	"suggestionItems.ts", // 建议列表构造（命令 / 路径 / 会话）
	"toolArgs.ts", // 工具参数解析（路径 / 写入内容 / 改动行数）
];

export const appUtilsSourceFiles = [entryPath, ...domainFiles.map((name) => `${domainDirectory}/${name}`)];

/** `[{ path, source }]`：需要逐文件断言时用（例如「某段实现只在一个文件里」）。 */
export const appUtilsSources = appUtilsSourceFiles.map((path) => ({ path, source: readFileSync(path, "utf8") }));

/** 拼成一份源码文本：`// path` 头保留来源，`[\s\S]*?` 形态的跨行断言仍可用。 */
export const appUtilsSource = appUtilsSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
