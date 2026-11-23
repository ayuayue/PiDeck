// rules.mjs —— scripts/skills/pideck/ 下每个判据脚本自己的规则，一条一个类型。
// 为什么要这份数据：判据脚本原来只有散文注释解释「我在判什么」，机器读不出来，
// 所以「这个判据还在判它该判的东西吗」只能靠人看。这里把命题 · 引入 · 消去 · 反例写成结构，
// 由 check-rules.mjs 校验四件是否齐、点名的命令是否还在盘上。
// 四件：claim 命题｜intro 引入（命令 + 期望）｜second 消去（第二入口）｜counter 反例（一个具体输入）

export const RULES = [
	// check-doc.mjs
	{
		id: "DOC1",
		script: "check-doc.mjs",
		claim: "§7 标题里写的动作条数与 7.1 表格行数一致",
		intro: "node check-doc.mjs → PASS",
		second: "把标题里的 21 改成 22 → 仍然 PASS 说明这条判据没生效",
		counter: "标题写 22、表格 21 行 → rc=1",
	},
	{
		id: "DOC2",
		script: "check-doc.mjs",
		claim: "源码里每个 webError 码在文档里都写过",
		intro: "node check-doc.mjs → 错误码 N 个，文档缺 0 个",
		second: "在 WebI18n.ts 里数同一批码，数量相同",
		counter: "新增一个码不写进 endpoints.md → 报「文档没写错误码 xxx」",
	},
	{
		id: "DOC3",
		script: "check-doc.mjs",
		claim: "路由文件按后缀 *Routes.ts 收集，不按前缀 WebApi*",
		intro: "ls src/main/web/*Routes.ts → 含非 WebApi 开头的两份",
		second: "台账条数与源码条数相等（75 = 75）",
		counter: "按 WebApi 前缀收集 → WebWorkspaceRoutes 那 11 条长期漏掉",
	},

	// check-paths.mjs
	{
		id: "PATH1",
		script: "check-paths.mjs",
		claim: "文档里每个 /api 路径的每一段，都在源码路由的段集合里出现过",
		intro: "node check-paths.mjs → PASS",
		second: "check-doc.mjs 按整条路由比对，同一份文档也 PASS",
		counter: "文档写 /api/session（少一个 s）→ rc=1",
	},
	{
		id: "PATH2",
		script: "check-paths.mjs",
		claim: "组合式路由要拆段，不能按整条比",
		intro: "源码出现 (update|delete|copy|export-html) → 拆成 4 个段",
		second: "文档写其中任一个 → 通过；写别的 → 报缺失段",
		counter: "整条比对：文档写 /api/sessions/<id>/update 被判「不存在」",
	},
	{
		id: "PATH3",
		script: "check-paths.mjs",
		claim: "本机绝对路径不能写进技能文档，三种写法都要认",
		intro: "node check-paths.mjs → 命中 C:\\Users、C:/Users、/c/Users 三种",
		second: "grep 这三种写法，命中数与判据一致",
		counter: "只认 C:\\Users：Git Bash 写法的路径静默通过",
	},

	// check-fields.mjs
	{
		id: "FIELD1",
		script: "check-fields.mjs",
		claim: "文档里反引号包住的标识符，必须在源码里有命中",
		intro: "node check-fields.mjs → 标识符 N 个，源码零命中 0 个",
		second: "ast_grep 在 src 上独立搜同一批标识符，数量相同",
		counter: "文档写 sorry（源码里没有这个词）→ 报「源码里找不到」",
	},
	{
		id: "FIELD2",
		script: "check-fields.mjs",
		claim: "字段名取自源码类型，不从文档猜",
		intro: "node check-fields.mjs → PASS",
		second: "在 WebApi*Routes.ts 的 body 类型里逐个 grep 字段名",
		counter: "文档写一个源码里不存在的字段名 → rc=1",
	},

	// check-format.mjs
	{
		id: "FMT1",
		script: "check-format.mjs",
		claim: "子节标题层级与编号一致：2.1 是 2 的子节，要用 H3",
		intro: "node check-format.mjs → PASS",
		second: "grep '^## [0-9]+\\.[0-9]+' 应为空",
		counter: "2.1 用 H2 → 报「编号 2.1 是 2 的子节，标题用了 H2」",
	},
	{
		id: "FMT2",
		script: "check-format.mjs",
		claim: "表格每行列数与表头一致",
		intro: "node check-format.mjs → PASS",
		second: "逐行 split('|') 计数与表头比较",
		counter: "单元格里出现裸竖线 → 报「表格 6 列，表头 5 列」",
	},

	// check-round-robin.mjs
	{
		id: "RR1",
		script: "check-round-robin.mjs",
		claim: "每份 web-api 文档在同一轮里既被索引也索引别人，不留孤儿文件",
		intro: "node check-round-robin.mjs → 每份都被提到 ≥1 次",
		second: "grep 目录下每个文件名在别处的出现次数，0 次的即为孤儿",
		counter: "新增一份 md 不写进任何索引 → 报该文件是孤儿",
	},
	// check-self-contained.mjs
	{
		id: "SC1",
		script: "check-self-contained.mjs",
		claim: "文档里不写节号引用（「见第 6 节」「按 9.2 办」）",
		intro: "node check-self-contained.mjs <文件> → rc=0",
		second: "人工：一个没读过技能的新会话照原文执行，能跑出 rc",
		counter: "写「见第 6 节」→ rc=1",
	},
	{
		id: "SC2",
		script: "check-self-contained.mjs",
		claim: "文档里不写前情指代与技能指代",
		intro: "node check-self-contained.mjs <文件> → rc=0",
		second: "把该段单独发给新会话，它能不问「上文是什么」就执行",
		counter: "写「上文说过」「按本技能办」→ rc=1",
	},
	{
		id: "SC3",
		script: "check-self-contained.mjs",
		claim: "一段离开本文件的文字，非空字符不得少于 40",
		intro: "node check-self-contained.mjs <文件> → rc=0",
		second: "人工核对：短消息要么补全，要么并入上一条",
		counter: "空对空的一段（不到 40 个非空字符）→ rc=1",
	},
];
