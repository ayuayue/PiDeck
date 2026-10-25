/**
 * 自定义主题包（custom theme package）共享契约：格式定义、token 白名单、校验器与内置示例。
 *
 * 三方共用：
 * - 主进程 CustomThemeStore/themesIpc：扫描/保存前用 parseCustomThemePackage 校验（用户 JSON 视为不可信输入）；
 * - 渲染层设置页：编辑器保存前同源校验、卡片预览取色；
 * - SettingsStore.update：用 sanitizeCustomThemeSnapshot 清洗设置里的主题快照。
 *
 * 关键设计：
 * - 主题包 JSON 的 token 键用完整 CSS 变量名（如 "--color-bg-app"，与 DevTools 一致，方便对照）；
 * - 内部快照（settings.customTheme / 注入通道）沿用 customThemeOverrides 既有约定：键不含
 *   "--color-" 前缀（如 "bg-app"），useAppAppearance 注入时拼 "--color-${k}"；
 * - 白名单只放 foundation.css 的语义 token；排除 background/card（shadcn 桥接别名，覆盖会造成双源）
 *   与 logo-green 系列（品牌标识固定）。
 */

/** 主题包 JSON 的 token 键：完整 CSS 变量名 */
export type CustomThemeTokenInput = Record<string, string>;
/** 内部快照 token 键：不含 "--color-" 前缀（与 customThemeOverrides 约定一致） */
export type CustomThemeTokenMap = Record<string, string>;

/** 主题包结构（外部 JSON 形态；appearance 两个分档均可选，但至少一个非空） */
export type CustomThemePackage = {
	schemaVersion: 1;
	id: string;
	name: string;
	version?: string;
	author?: string;
	description?: string;
	appearance: {
		light?: CustomThemeTokenInput;
		dark?: CustomThemeTokenInput;
	};
};

/** 应用主题时写入 settings 的快照（内部无前缀键；亮暗分档） */
export type CustomThemeSnapshot = {
	id: string;
	name: string;
	light: CustomThemeTokenMap;
	dark: CustomThemeTokenMap;
};

/** 主题目录列表项（内置示例 + 用户文件；解析失败的用户文件以 parseError 呈现，便于发现与修复） */
export type CustomThemeListItem = {
	source: "builtin" | "user";
	/** 包内 id：展示与「应用」写快照用；内置示例与用户文件可能同 id（用户手改文件名/内容） */
	id: string;
	/**
	 * 用户文件的磁盘主键（文件名去 .json）；读取/删除必须用它定位文件，
	 * 不能拿包内 id 当路径——两者可以不一致。内置示例无文件，字段缺席。
	 */
	fileId?: string;
	name: string;
	version?: string;
	author?: string;
	description?: string;
	tokens: { light: CustomThemeTokenMap; dark: CustomThemeTokenMap };
	parseError?: string[];
};

export type CustomThemeParseResult = { ok: true; theme: CustomThemePackage; tokens: { light: CustomThemeTokenMap; dark: CustomThemeTokenMap } } | { ok: false; errors: string[] };

/** token 白名单分组：分组标题 + 每个 token 的双语说明（AI 指南与校验错误共用，单一事实源） */
export type CustomThemeTokenGroup = {
	key: string;
	zhTitle: string;
	enTitle: string;
	tokens: { token: string; zhDesc: string; enDesc: string }[];
};

/**
 * 语义 token 白名单（分组）。token 为不含 "--color-" 前缀的内部名；
 * 指南/错误信息展示时用 `--color-${token}` 还原完整变量名。
 * 来源：foundation.css 语义色 token 人工梳理；改 foundation 命名时同步这里与指南测试。
 */
export const CUSTOM_THEME_TOKEN_GROUPS: readonly CustomThemeTokenGroup[] = [
	{
		key: "surfaces",
		zhTitle: "表面（背景）",
		enTitle: "Surfaces (backgrounds)",
		tokens: [
			{ token: "bg-app", zhDesc: "应用整体底色", enDesc: "App-wide base background" },
			{ token: "bg-sidebar", zhDesc: "左侧栏底色", enDesc: "Sidebar background" },
			{ token: "bg-panel", zhDesc: "面板/卡片底色", enDesc: "Panel / card background" },
			{ token: "bg-popover", zhDesc: "弹层/下拉菜单底色", enDesc: "Popover / dropdown background" },
			{ token: "bg-input", zhDesc: "输入框底色", enDesc: "Input field background" },
			{ token: "bg-muted", zhDesc: "弱化区块底色", enDesc: "Muted block background" },
			{ token: "bg-hover", zhDesc: "悬停态底色", enDesc: "Hover background" },
			{ token: "bg-active", zhDesc: "按下/选中态底色", enDesc: "Active / selected background" },
			{ token: "bg-subtle", zhDesc: "更弱的分隔底色", enDesc: "Subtle separator background" },
		],
	},
	{
		key: "text",
		zhTitle: "文字",
		enTitle: "Text",
		tokens: [
			{ token: "text-primary", zhDesc: "正文主文字", enDesc: "Primary text" },
			{ token: "text-secondary", zhDesc: "次级文字（标题、说明）", enDesc: "Secondary text" },
			{ token: "text-tertiary", zhDesc: "三级说明文字", enDesc: "Tertiary text" },
			{ token: "text-faint", zhDesc: "最弱占位/时间戳", enDesc: "Faintest placeholder / timestamp" },
			{ token: "text-inverse", zhDesc: "主色底上的反色文字", enDesc: "Inverse text on accent surfaces" },
		],
	},
	{
		key: "border",
		zhTitle: "边框",
		enTitle: "Borders",
		tokens: [
			{ token: "border-subtle", zhDesc: "弱分隔线", enDesc: "Subtle divider" },
			{ token: "border-default", zhDesc: "常规边框", enDesc: "Default border" },
			{ token: "border-strong", zhDesc: "强调边框/输入聚焦", enDesc: "Strong border / input focus" },
		],
	},
	{
		key: "accent",
		zhTitle: "主色",
		enTitle: "Accent",
		tokens: [
			{ token: "accent", zhDesc: "主色：按钮/链接/选中/开关", enDesc: "Accent: buttons, links, selection" },
			{ token: "accent-soft", zhDesc: "主色浅底（标签、悬浮提示）", enDesc: "Soft accent background" },
			{ token: "accent-strong", zhDesc: "主色深档（悬停加深）", enDesc: "Strong accent (hover deepen)" },
		],
	},
	{
		key: "status",
		zhTitle: "语义状态色",
		enTitle: "Status colors",
		tokens: [
			{ token: "danger", zhDesc: "危险/错误", enDesc: "Danger / error" },
			{ token: "danger-soft", zhDesc: "危险浅底", enDesc: "Soft danger background" },
			{ token: "success", zhDesc: "成功", enDesc: "Success" },
			{ token: "success-soft", zhDesc: "成功浅底", enDesc: "Soft success background" },
			{ token: "success-strong", zhDesc: "成功深档", enDesc: "Strong success" },
			{ token: "warning", zhDesc: "警告", enDesc: "Warning" },
			{ token: "info", zhDesc: "信息", enDesc: "Info" },
		],
	},
	{
		key: "chat",
		zhTitle: "会话气泡/表格",
		enTitle: "Chat bubbles & tables",
		tokens: [
			{ token: "chat-card-bg", zhDesc: "消息卡片底色", enDesc: "Message card background" },
			{ token: "chat-muted-bg", zhDesc: "弱化气泡底色", enDesc: "Muted bubble background" },
			{ token: "chat-control-bg", zhDesc: "气泡内控件底色", enDesc: "In-bubble control background" },
			{ token: "chat-table-bg", zhDesc: "Markdown 表格底色", enDesc: "Markdown table background" },
			{ token: "chat-link", zhDesc: "消息内链接色", enDesc: "Link color in messages" },
		],
	},
	{
		key: "code",
		zhTitle: "代码块",
		enTitle: "Code blocks",
		tokens: [
			{ token: "code-bg", zhDesc: "代码块底色", enDesc: "Code block background" },
			{ token: "code-text", zhDesc: "代码块文字色", enDesc: "Code block text" },
		],
	},
	{
		key: "chips",
		zhTitle: "徽章/标签",
		enTitle: "Chips & badges",
		tokens: [
			{ token: "chip-file", zhDesc: "文件 chip", enDesc: "File chip" },
			{ token: "chip-session", zhDesc: "会话 chip", enDesc: "Session chip" },
			{ token: "chip-skill", zhDesc: "技能 chip", enDesc: "Skill chip" },
		],
	},
	{
		key: "misc",
		zhTitle: "流程标识",
		enTitle: "Timeline markers",
		tokens: [
			{ token: "thinking", zhDesc: "思考中步骤标识色", enDesc: "Thinking step marker" },
			{ token: "tool", zhDesc: "工具调用步骤标识色", enDesc: "Tool-call step marker" },
		],
	},
	{
		key: "brand",
		zhTitle: "供应商徽章五色",
		enTitle: "Provider badge palette",
		tokens: [
			{ token: "brand-green", zhDesc: "徽章绿（Anthropic 系）", enDesc: "Badge green" },
			{ token: "brand-blue", zhDesc: "徽章蓝（OpenAI 系）", enDesc: "Badge blue" },
			{ token: "brand-purple", zhDesc: "徽章紫（Gemini 系）", enDesc: "Badge purple" },
			{ token: "brand-amber", zhDesc: "徽章琥珀", enDesc: "Badge amber" },
			{ token: "brand-rose", zhDesc: "徽章玫红", enDesc: "Badge rose" },
		],
	},
];

/** 白名单内部键集合（无前缀）；外部 JSON 键统一是 `--color-${token}` */
export const CUSTOM_THEME_TOKEN_WHITELIST: readonly string[] = CUSTOM_THEME_TOKEN_GROUPS.flatMap((group) => group.tokens.map((entry) => entry.token));
const TOKEN_SET = new Set(CUSTOM_THEME_TOKEN_WHITELIST);

/** 主题 id：小写字母/数字/连字符，用于文件名（<id>.json），拒绝路径与特殊字符 */
export const CUSTOM_THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * 颜色值白名单：#hex（3/4/6/8 位）或 rgb/rgba/hsl/hsla/oklch/oklab 纯数字参数形式。
 * 参数字符集只允许数字/百分号/逗号/斜杠/空白/#（数值记法），不含标识符 →
 * 天然排除 var()/url()/嵌套函数等引用与注入面（值只进 inline style，双保险）。
 */
const COLOR_VALUE_PATTERN = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|(rgba?|hsla?|oklch|oklab)\(\s*[-#0-9.,%/\s]{1,64}\))$/;

const MAX_TOKENS_PER_SCHEME = CUSTOM_THEME_TOKEN_WHITELIST.length;
export const CUSTOM_THEME_NAME_MAX = 40;
export const CUSTOM_THEME_TEXT_MAX = 200;

/** 校验单档 token 表（外部完整键 → 内部无前缀键）；返回 null 表示整表合法 */
function normalizeTokenScheme(scheme: unknown, schemeLabel: string, errors: string[]): CustomThemeTokenMap | null {
	if (scheme === undefined) return {};
	if (typeof scheme !== "object" || scheme === null || Array.isArray(scheme)) {
		errors.push(`${schemeLabel}: 必须是对象（token → 颜色值）`);
		return null;
	}
	const entries = Object.entries(scheme as Record<string, unknown>);
	if (entries.length === 0) return {};
	if (entries.length > MAX_TOKENS_PER_SCHEME) {
		errors.push(`${schemeLabel}: 条目超过白名单上限 ${MAX_TOKENS_PER_SCHEME}`);
		return null;
	}
	const normalized: CustomThemeTokenMap = {};
	for (const [key, value] of entries) {
		const token = key.startsWith("--color-") ? key.slice("--color-".length) : null;
		if (!token || !TOKEN_SET.has(token)) {
			errors.push(`${schemeLabel}: 未知 token "${key}"（只允许白名单内的 --color-* 变量，见 AI 指南）`);
			continue;
		}
		if (typeof value !== "string" || !COLOR_VALUE_PATTERN.test(value)) {
			errors.push(`${schemeLabel}: "${key}" 的值必须是静态颜色（#hex 或 rgb()/hsl()/oklch() 数值形式），当前为 ${JSON.stringify(value)}`);
			continue;
		}
		normalized[token] = value;
	}
	return errors.length > 0 ? null : normalized;
}

/**
 * 解析并校验主题包 JSON 文本（不可信输入：编辑器保存、目录扫描共用）。
 * 返回 ok:false 时 errors 为面向用户的中文错误清单（渲染层直接展示）。
 */
export function parseCustomThemePackage(raw: string): CustomThemeParseResult {
	const errors: string[] = [];
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		return { ok: false, errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`] };
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return { ok: false, errors: ["顶层必须是 JSON 对象"] };
	}
	const pkg = data as Record<string, unknown>;
	if (pkg.schemaVersion !== 1) {
		errors.push("schemaVersion 必须是 1");
	}
	const id = typeof pkg.id === "string" ? pkg.id : "";
	if (!CUSTOM_THEME_ID_PATTERN.test(id)) {
		errors.push(`id 必须匹配 ${CUSTOM_THEME_ID_PATTERN}（小写字母/数字/连字符，≤40 字符），当前为 ${JSON.stringify(pkg.id)}`);
	}
	const name = typeof pkg.name === "string" ? pkg.name.trim() : "";
	if (name.length === 0 || name.length > CUSTOM_THEME_NAME_MAX) {
		errors.push(`name 必须是 1-${CUSTOM_THEME_NAME_MAX} 字符`);
	}
	const textFields: [keyof CustomThemePackage, string][] = [
		["version", "version"],
		["author", "author"],
		["description", "description"],
	];
	const optionalTexts: Partial<Record<string, string>> = {};
	for (const [field, label] of textFields) {
		const value = pkg[field as string];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.length > CUSTOM_THEME_TEXT_MAX) {
			errors.push(`${label} 必须是不超过 ${CUSTOM_THEME_TEXT_MAX} 字符的字符串`);
		} else {
			optionalTexts[label] = value;
		}
	}
	if (pkg.appearance === undefined || typeof pkg.appearance !== "object" || pkg.appearance === null) {
		errors.push("appearance 必须是对象（含 light/dark 两档）");
		return { ok: false, errors };
	}
	const appearance = pkg.appearance as Record<string, unknown>;
	const light = normalizeTokenScheme(appearance.light, "appearance.light", errors);
	const dark = normalizeTokenScheme(appearance.dark, "appearance.dark", errors);
	if (errors.length > 0) return { ok: false, errors };
	const tokens = { light: light ?? {}, dark: dark ?? {} };
	if (Object.keys(tokens.light).length === 0 && Object.keys(tokens.dark).length === 0) {
		errors.push("appearance.light 与 appearance.dark 至少一档要有 token");
		return { ok: false, errors };
	}
	const theme: CustomThemePackage = {
		schemaVersion: 1,
		id,
		name,
		appearance: { light: Object.fromEntries(Object.entries(tokens.light).map(([token, value]) => [`--color-${token}`, value])), dark: Object.fromEntries(Object.entries(tokens.dark).map(([token, value]) => [`--color-${token}`, value])) },
	};
	if (optionalTexts.version !== undefined) theme.version = optionalTexts.version;
	if (optionalTexts.author !== undefined) theme.author = optionalTexts.author;
	if (optionalTexts.description !== undefined) theme.description = optionalTexts.description;
	return { ok: true, theme, tokens };
}

/** 序列化主题包为编辑器/落盘形态（tab 缩进，与仓库格式一致） */
export function serializeCustomThemePackage(theme: CustomThemePackage): string {
	return `${JSON.stringify(theme, null, "\t")}\n`;
}

/**
 * 清洗设置里的主题快照（SettingsStore.update 用，IPC 入参不可信）：
 * 逐键过滤非法 token/颜色；id/name 非法或两档全空 → 返回 undefined（调用方丢弃该字段）。
 */
export function sanitizeCustomThemeSnapshot(value: unknown): CustomThemeSnapshot | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const input = value as Record<string, unknown>;
	const id = typeof input.id === "string" && CUSTOM_THEME_ID_PATTERN.test(input.id) ? input.id : undefined;
	const name = typeof input.name === "string" && input.name.length > 0 && input.name.length <= CUSTOM_THEME_NAME_MAX ? input.name : undefined;
	if (!id || !name) return undefined;
	const cleanScheme = (scheme: unknown): CustomThemeTokenMap => {
		if (typeof scheme !== "object" || scheme === null) return {};
		const result: CustomThemeTokenMap = {};
		for (const [key, color] of Object.entries(scheme as Record<string, unknown>)) {
			// 快照键约定无前缀；兼容历史/手写时也接受完整变量名
			const token = key.startsWith("--color-") ? key.slice("--color-".length) : key;
			if (TOKEN_SET.has(token) && typeof color === "string" && COLOR_VALUE_PATTERN.test(color)) result[token] = color;
		}
		return result;
	};
	const light = cleanScheme(input.light);
	const dark = cleanScheme(input.dark);
	if (Object.keys(light).length === 0 && Object.keys(dark).length === 0) return undefined;
	return { id, name, light, dark };
}

/**
 * 内置示例主题「莓果夜色 / Berry Night」：
 * 演示覆盖面（表面/文字/边框/主色/会话/代码，亮暗两套完整档），同时充当「复制为新主题」的模板。
 */
export const DEMO_CUSTOM_THEME: CustomThemePackage = {
	schemaVersion: 1,
	id: "berry-night-demo",
	name: "莓果夜色（示例）",
	version: "1.0.0",
	author: "PiDeck",
	description: "内置示例：暖莓色双档主题，复制为新主题后可自由修改。",
	appearance: {
		light: {
			"--color-bg-app": "#faf6f7",
			"--color-bg-sidebar": "#f4eef0",
			"--color-bg-panel": "#fffdfd",
			"--color-bg-popover": "#fffdfd",
			"--color-bg-input": "#f7f2f3",
			"--color-bg-muted": "#efe8ea",
			"--color-bg-hover": "#e9e0e3",
			"--color-bg-active": "#e2d5d9",
			"--color-text-primary": "#33262b",
			"--color-text-secondary": "#6f5a62",
			"--color-text-tertiary": "#9a8790",
			"--color-text-faint": "#b8a8af",
			"--color-border-subtle": "#e8dde0",
			"--color-border-default": "#d9c9ce",
			"--color-border-strong": "#c3acb3",
			"--color-accent": "#b3455f",
			"--color-accent-soft": "#f3dbe1",
			"--color-accent-strong": "#93324a",
			"--color-chat-card-bg": "#fffdfd",
			"--color-chat-muted-bg": "#f4eef0",
			"--color-code-bg": "#f4eef0",
		},
		dark: {
			"--color-bg-app": "#171114",
			"--color-bg-sidebar": "#1d1619",
			"--color-bg-panel": "#221a1e",
			"--color-bg-popover": "#2a2024",
			"--color-bg-input": "#241c20",
			"--color-bg-muted": "#2a2125",
			"--color-bg-hover": "#302529",
			"--color-bg-active": "#392c31",
			"--color-text-primary": "#f2e6ea",
			"--color-text-secondary": "#c9b6bd",
			"--color-text-tertiary": "#9d8a91",
			"--color-text-faint": "#75646b",
			"--color-border-subtle": "#342a2e",
			"--color-border-default": "#463840",
			"--color-border-strong": "#5b4a52",
			"--color-accent": "#e77d97",
			"--color-accent-soft": "#3a2530",
			"--color-accent-strong": "#f2a5b8",
			"--color-chat-card-bg": "#1d1619",
			"--color-chat-muted-bg": "#241c20",
			"--color-code-bg": "#241c20",
		},
	},
};

/** 「新建主题」的空白模板（覆盖最核心的 8 个 token，其余交给用户/AI 扩展） */
export const CUSTOM_THEME_TEMPLATE: CustomThemePackage = {
	schemaVersion: 1,
	id: "my-theme",
	name: "我的主题",
	version: "0.1.0",
	appearance: {
		light: {
			"--color-bg-app": "#f7f6f4",
			"--color-bg-panel": "#ffffff",
			"--color-text-primary": "#2b2b2b",
			"--color-border-default": "#dcdcd8",
			"--color-accent": "#4a7854",
		},
		dark: {
			"--color-bg-app": "#16181a",
			"--color-bg-panel": "#1e2124",
			"--color-text-primary": "#ececec",
			"--color-border-default": "#34383c",
			"--color-accent": "#7fb98a",
		},
	},
};
