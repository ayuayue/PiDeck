import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { QUICK_MESSAGE_PAGE_SIZE, filterQuickMessages, paginateQuickMessages } from "../src/renderer/src/components/session/quickMessagePickerModel.ts";

const quickMessages = loadTsCommonJs("src/shared/quickMessages.ts");
const { MAX_QUICK_MESSAGES, MAX_QUICK_MESSAGE_LENGTH, normalizeQuickMessages, sanitizeQuickMessagesFile } = quickMessages;
const { QuickMessageStore } = loadTsCommonJs("src/main/quickmessages/QuickMessageStore.ts");

const i18n = loadTsCommonJs("src/renderer/src/i18n.ts");

/** 随包出厂清单：这是「内置条目」的唯一数据源（代码里不再有清单常量）。 */
const DEFAULT_RESOURCE = "resources/quick-messages.default.json";
const readDefaults = () => JSON.parse(readFileSync(DEFAULT_RESOURCE, "utf8"));

/**
 * 跨 realm 比较：经 vm 加载的模块创建的数组原型与宿主不同，`deepStrictEqual` 会因
 * 原型不同直接报「same structure but are not reference-equal」，这里统一转成宿主普通数组。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * 快捷消息（输入框底栏「快捷消息」弹框 + 设置页维护）。
 *
 * 数据源是配置文件 userData/quick-messages.json（不再是 settings.json 字段、也不是代码常量），
 * 因此这里分四层守卫：出厂资源清单、清洗规则（纯函数）、QuickMessageStore 文件读写、UI 接线契约。
 */

// ── 出厂清单（resources/quick-messages.default.json） ──────────────────

test("随包出厂清单：含用户点名的四条高频指令，且无重复、不超长、不超上限", () => {
	const items = readDefaults().items;
	for (const item of ["继续", "提交", "推送", "提交推送"]) {
		assert.ok(items.includes(item), `出厂清单缺少「${item}」`);
	}
	assert.equal(new Set(items).size, items.length, "出厂清单出现重复条目");
	for (const item of items) {
		assert.ok(item.trim() === item && item.length > 0, `出厂条目不应有首尾空白或为空: ${JSON.stringify(item)}`);
		assert.ok(item.length <= MAX_QUICK_MESSAGE_LENGTH, `出厂条目超长: ${item}`);
	}
	assert.ok(items.length <= MAX_QUICK_MESSAGES, "出厂条数不该超过上限");
});

test("出厂清单必须打进安装包（漏了 extraResources，打包版就没有内置条目）", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const entries = pkg.build?.extraResources ?? [];
	assert.ok(
		entries.some((entry) => typeof entry === "object" && entry.from === DEFAULT_RESOURCE),
		`package.json extraResources 缺少 ${DEFAULT_RESOURCE}`,
	);
});

test("内置条目只存在于配置文件，代码里不留硬编码清单（否则「配置化」又漏一个洞）", () => {
	// 只看具体条目文本，不看「继续」这类词在注释/文案里的正常出现——用出厂清单里最长的两条做探针。
	const probes = readDefaults().items.filter((item) => item.length >= 8);
	assert.ok(probes.length > 0, "出厂清单缺少可用于探针的长条目");
	const sources = ["src/shared/quickMessages.ts", "src/renderer/src/components/session/QuickMessageMenu.tsx", "src/renderer/src/components/app/settings/QuickMessagesSetting.tsx", "src/renderer/src/App.tsx", "src/main/settings/SettingsStore.ts"];
	for (const file of sources) {
		const source = readFileSync(file, "utf8");
		for (const probe of probes) {
			assert.ok(!source.includes(probe), `${file} 里仍硬编码出厂条目「${probe}」`);
		}
	}
});

// ── 清洗规则（主进程读写文件、渲染层增删共用） ─────────────────────────

test("normalize：非数组/缺失一律空数组（出厂清单在资源文件里，不再由代码兜底）", () => {
	assert.deepEqual(plain(normalizeQuickMessages(undefined)), []);
	assert.deepEqual(plain(normalizeQuickMessages(null)), []);
	assert.deepEqual(plain(normalizeQuickMessages({ 0: "继续" })), []);
});

test("normalize：显式空数组保持为空（用户清空 ≠ 回填出厂清单）", () => {
	assert.deepEqual(plain(normalizeQuickMessages([])), []);
});

test("normalize：丢弃空白条目与非字符串项，其余 trim 后保留顺序", () => {
	assert.deepEqual(plain(normalizeQuickMessages(["  继续  ", "", "   ", 42, null, "提交推送"])), ["继续", "提交推送"]);
});

test("normalize：去重按不区分大小写的 trim 后文本：弹框里两条一样的条目只会让人点错", () => {
	assert.deepEqual(plain(normalizeQuickMessages(["继续", " 继续 ", "Review", "review", "REVIEW"])), ["继续", "Review"]);
});

test("normalize：超长按上限截断（而非丢弃），超过条数上限的部分丢弃", () => {
	const long = "字".repeat(MAX_QUICK_MESSAGE_LENGTH + 50);
	const [clipped] = normalizeQuickMessages([long]);
	assert.equal(clipped.length, MAX_QUICK_MESSAGE_LENGTH);

	const many = Array.from({ length: MAX_QUICK_MESSAGES + 5 }, (_, index) => `条目 ${index}`);
	const result = normalizeQuickMessages(many);
	assert.equal(result.length, MAX_QUICK_MESSAGES);
	assert.equal(result[MAX_QUICK_MESSAGES - 1], `条目 ${MAX_QUICK_MESSAGES - 1}`, "超限应丢弃尾部而不是打乱顺序");
});

test("sanitize 文件结构：裸数组与 {items} 都接受，items 为空数组仍是合法配置", () => {
	assert.deepEqual(plain(sanitizeQuickMessagesFile([" 继续 ", "继续", "推送"]).items), ["继续", "推送"]);
	assert.deepEqual(plain(sanitizeQuickMessagesFile({ version: 1, items: ["提交"] }).items), ["提交"]);
	assert.deepEqual(plain(sanitizeQuickMessagesFile({ items: [] }).items), [], "清空后的文件必须能被识别，否则重启会复活出厂清单");
});

test("sanitize 文件结构：不是可识别配置时返回 null（调用方据此重建并备份坏文件）", () => {
	assert.equal(sanitizeQuickMessagesFile(null), null);
	assert.equal(sanitizeQuickMessagesFile(42), null);
	assert.equal(sanitizeQuickMessagesFile("继续"), null);
	assert.equal(sanitizeQuickMessagesFile({ list: ["继续"] }), null, "缺 items 字段应视为不可识别");
	// items 存在但不是数组属于「改坏了」而不是「清空」：必须走备份 + 重建，不能静默变空清单。
	assert.equal(sanitizeQuickMessagesFile({ items: "继续" }), null);
	assert.equal(sanitizeQuickMessagesFile({ items: null }), null);
});

// ── QuickMessageStore（配置文件读写） ──────────────────────────────────

/** 每个用例独立临时目录：配置文件 + 可选的「坏文件 / 遗留 settings 字段」。 */
function makeStore(options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-quickmsg-"));
	const configPath = join(dir, "quick-messages.json");
	if (options.fileContent !== undefined) writeFileSync(configPath, options.fileContent);
	const logs = [];
	const store = new QuickMessageStore({
		getConfigPath: () => configPath,
		getDefaultConfigPath: () => options.defaultPath ?? DEFAULT_RESOURCE,
		getLegacyItems: () => options.legacyItems ?? [],
		log: (scope, message, detail) => logs.push({ scope, message, detail }),
	});
	return { store, configPath, dir, logs };
}

const readConfig = (configPath) => JSON.parse(readFileSync(configPath, "utf8"));

test("store：没有配置文件时用随包清单种子化，并把文件真的落盘（用户可接着手工编辑）", async () => {
	const { store, configPath } = makeStore();
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), plain(readDefaults().items));
	assert.equal(snapshot.seeded, true, "首次生成应标记为种子化");
	assert.equal(snapshot.defaultsAvailable, true);
	assert.equal(snapshot.filePath, configPath);
	assert.deepEqual(plain(readConfig(configPath).items), plain(readDefaults().items), "种子应写进配置文件而不是只留在内存");
	assert.equal(readConfig(configPath).version, quickMessages.QUICK_MESSAGES_FILE_VERSION, "文件带结构版本号，便于将来迁移");
});

test("store：迁移优先级——settings.json 遗留字段优先于随包清单（升级不能丢用户改过的条目）", async () => {
	const { store, configPath } = makeStore({ legacyItems: ["  我自己的口令  ", "我自己的口令"] });
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), ["我自己的口令"], "遗留字段清洗后应作为种子");
	assert.deepEqual(plain(readConfig(configPath).items), ["我自己的口令"]);
});

test("store：已有配置文件时完全以文件为准（手工编辑立刻生效，不被出厂清单覆盖）", async () => {
	const { store } = makeStore({ fileContent: JSON.stringify({ version: 1, items: ["只属于我的条目"] }) });
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), ["只属于我的条目"]);
	assert.equal(snapshot.seeded, false, "直接读到文件不应标记为种子化");
});

test("store：文件里的空数组是合法状态（清空后重启不复活出厂清单）", async () => {
	const { store } = makeStore({ fileContent: JSON.stringify({ version: 1, items: [] }) });
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), []);
	assert.equal(snapshot.seeded, false);
});

test("store：坏文件先备份成 .bak 再重建（用户手工编辑仍能找回）", async () => {
	const broken = "{ 这不是 JSON";
	const { store, configPath } = makeStore({ fileContent: broken });
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), plain(readDefaults().items), "无法识别时用出厂清单重建");
	assert.equal(readFileSync(`${configPath}.bak`, "utf8"), broken, "坏文件内容必须原样备份");
});

test("store：结构不对（缺 items）同样按不可识别处理，不静默吞掉用户内容", async () => {
	const { store, configPath } = makeStore({ fileContent: JSON.stringify({ items: "继续" }) });
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), plain(readDefaults().items));
	assert.ok(existsSync(`${configPath}.bak`), "结构异常也应留下备份");
});

test("store：save 先清洗再原子落盘，返回的快照与磁盘一致", async () => {
	const { store, configPath } = makeStore();
	await store.getSnapshot();
	const result = await store.save(["  提交推送 ", "提交推送", "", "   ", "推送"]);
	assert.equal(result.ok, true);
	assert.deepEqual(plain(result.snapshot.items), ["提交推送", "推送"]);
	assert.deepEqual(plain(readConfig(configPath).items), ["提交推送", "推送"]);
	assert.equal(result.snapshot.seeded, false, "保存后的回读应来自文件本身");
	assert.ok(!existsSync(`${configPath}.tmp`), "原子写的临时文件不应残留");
});

test("store：save 接受空数组（用户清空），且非法入参不会写坏文件", async () => {
	const { store, configPath } = makeStore();
	await store.save(["先有一条"]);
	assert.equal((await store.save([])).ok, true);
	assert.deepEqual(plain(readConfig(configPath).items), []);
	// 渲染层来的数据一律不可信：结构非法时按「空清单」处理，而不是抛错留半截文件。
	assert.equal((await store.save("继续")).ok, true);
	assert.deepEqual(plain(readConfig(configPath).items), []);
});

test("store：随包清单缺失时告警并给出空清单（刻意不用代码兜底）", async () => {
	const { store, logs } = makeStore({ defaultPath: join(tmpdir(), "不存在的清单.json") });
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), []);
	assert.equal(snapshot.defaultsAvailable, false);
	assert.ok(
		logs.some((entry) => entry.message === "default resource unreadable"),
		"资源缺失必须留下日志",
	);
});

test("store：读配置失败时不覆盖磁盘（权限/占用场景下只撑住本次界面）", async () => {
	// 用目录冒充配置文件：readFile 会以 EISDIR 失败，正好模拟「读不动」而不是「不存在」。
	const dir = mkdtempSync(join(tmpdir(), "pideck-quickmsg-dir-"));
	const configPath = join(dir, "quick-messages.json");
	mkdirSync(configPath);
	const store = new QuickMessageStore({
		getConfigPath: () => configPath,
		getDefaultConfigPath: () => DEFAULT_RESOURCE,
		getLegacyItems: () => [],
		log: () => undefined,
	});
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), plain(readDefaults().items), "读失败用出厂清单撑住界面");
	assert.ok(statSync(configPath).isDirectory(), "读失败不应试图写盘覆盖");
});

test("store：ensureFile 让「打开配置文件」在文件还没生成时也能打开", async () => {
	const { store, configPath } = makeStore();
	assert.ok(!existsSync(configPath));
	await store.ensureFile();
	assert.ok(existsSync(configPath), "ensureFile 之后文件必须存在（shell 打不开不存在的路径）");
});

// ── 装配与 IPC 边界 ───────────────────────────────────────────────────

test("主进程装配：配置文件来自 userData、出厂清单来自随包 resources（两个磁盘根同源）", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.match(source, /new QuickMessageStore\(\{/);
	assert.match(source, /QUICK_MESSAGES_FILE_NAME/);
	assert.match(source, /getLegacyItems:[\s\S]{0,120}?settingsStore\.get\(\)\.quickMessages/, "遗留字段是迁移种子，装配处必须传");
	assert.match(source, /QUICK_MESSAGES_DEFAULT_RESOURCE_NAME/);
});

test("IPC 行为：get 回快照、save 只收数组、open-file 先建文件再交给系统打开", async () => {
	// 用真实 handler 跑一遍（而不只是看源码里有校验）：这是渲染层与文件之间唯一的入口。
	const handlers = new Map();
	const opened = [];
	let openResult = "";
	const { registerQuickMessagesIpc } = loadTsCommonJs("src/main/ipc/quickMessagesIpc.ts", {
		stubs: {
			electron: {
				ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
				shell: { openPath: async (path) => (opened.push(path), openResult) },
			},
		},
	});
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const { store, configPath } = makeStore();
	registerQuickMessagesIpc(store, () => undefined);

	const snapshot = await handlers.get(ipcChannels.quickMessagesGet)();
	assert.deepEqual(plain(snapshot.items), plain(readDefaults().items));

	// 非数组入参：拒绝且不落盘（渲染层数据不可信）。
	const before = readFileSync(configPath, "utf8");
	assert.deepEqual(plain(await handlers.get(ipcChannels.quickMessagesSave)(null, "继续")), { ok: false, error: "invalid payload" });
	assert.equal(readFileSync(configPath, "utf8"), before, "非法入参不该改动文件");

	// 合法入参：清洗后落盘。
	const saved = await handlers.get(ipcChannels.quickMessagesSave)(null, ["  提交推送 ", "提交推送"]);
	assert.equal(saved.ok, true);
	assert.deepEqual(plain(saved.snapshot.items), ["提交推送"]);

	// 打开配置文件：先确保文件存在（否则 shell 报错，用户看到的却是「点了没反应」）。
	await handlers.get(ipcChannels.quickMessagesOpenFile)();
	assert.deepEqual(opened, [configPath]);
	assert.ok(existsSync(configPath));

	// shell.openPath 用字符串报错：必须抛给前端才能提示，而不是静默失败。
	openResult = "No application found";
	await assert.rejects(() => handlers.get(ipcChannels.quickMessagesOpenFile)(), /No application found/);
});

// ── UI 接线契约（防漂移：改一处漏一处会静默失效） ───────────────────────

const readSource = (file) => readFileSync(file, "utf8");

test("底栏接线：安全控制位右侧渲染 props.quickMessagesControl，且生图模式一并屏蔽", () => {
	const source = readSource("src/renderer/src/components/session/ComposerComponents.tsx");
	assert.match(source, /quickMessagesControl\?: ReactNode/);
	// 生图模式没有对话 runtime，两个控制位都不该出现；分开判断是为了防止将来只屏蔽一个。
	assert.match(source, /isImageGenMode \? null : \(\s*<>\s*\{props\.securityControl\}\s*\{props\.quickMessagesControl\}/);
});

test("ComposerArea：把 controller 的 pickers/delivery 接进快捷消息入口", () => {
	const source = readSource("src/renderer/src/components/session/ComposerArea.tsx");
	assert.match(source, /quickMessagesControl=\{[\s\S]{0,400}?<QuickMessageMenu/);
	assert.match(source, /onInsert=\{composer\.pickers\.insertQuickMessage\}/);
	assert.match(source, /onSend=\{composer\.delivery\.sendQuickMessage\}/);
	assert.match(source, /sendDisabled=\{!composer\.delivery\.canSendQuickMessage\}/);
});

test("直发契约：overrideText 不消费草稿/附件，也不清空或回填草稿", () => {
	const source = readSource("src/renderer/src/hooks/useSessionSend.ts");
	assert.match(source, /sendSessionPrompt\(streamingBehavior\?: "steer" \| "followUp", overrideText\?: string\)/);
	assert.match(source, /const keepDraft = overrideText !== undefined;/);
	// 草稿快照与附件快照都必须走 keepDraft 分支
	assert.match(source, /const rawDraft = overrideText \?\?/);
	assert.match(source, /keepDraft \? \[\] :/);
	// 清空/回填都要被 keepDraft 挡住
	assert.match(source, /function clearComposerSnapshot\(targetSessionId: string, keepDraft: boolean\) \{\s*if \(keepDraft\) return;/);
	assert.match(source, /function restoreRejectedPrompt\([\s\S]{0,120}?keepDraft: boolean[\s\S]{0,120}?\) \{\s*if \(keepDraft\) return;/);
});

test("弹框：清单来自配置文件（useQuickMessages），不再订阅 settings 快照", () => {
	const source = readSource("src/renderer/src/components/session/QuickMessageMenu.tsx");
	assert.match(source, /const \{ items, loading, error, openFile[^}]*\} = useQuickMessages\(\)/);
	assert.ok(!/quickMessagesAtom/.test(source), "弹框不该再读 settings 派生的 atom");
	assert.match(source, /openFile\(\)/, "弹框里要有「打开配置文件」出口");
});

test("弹框：每次打开都从磁盘重读（手工编辑配置文件后无需重启应用）", () => {
	const source = readSource("src/renderer/src/components/session/QuickMessageMenu.tsx");
	assert.match(source, /onOpenChange=\{[\s\S]{0,200}?if \(next\) void refresh\(\)/, "打开弹框时应重读文件");
	const hook = readSource("src/renderer/src/hooks/useQuickMessages.ts");
	assert.match(hook, /const refresh = useCallback\(async \(\) => \{/);
	assert.match(readSource("src/renderer/src/hooks/useQuickMessageEditor.ts"), /await refresh\(\);/, "「重新读取」要真的重读磁盘（同步外部编辑）");
	assert.match(readSource("src/renderer/src/components/app/settings/QuickMessagesDialog.tsx"), /onClick=\{\(\) => void editor\.reload\(\)\}/, "设置弹框里要能手动重新读取");
});

test("弹框形状：Popover + 紧凑表格 + 搜索 + 分页（不再是一列铺到底的菜单）", () => {
	const menu = readSource("src/renderer/src/components/session/QuickMessageMenu.tsx");
	assert.match(menu, /<PopoverContent[\s\S]{0,260}?<QuickMessagePicker/, "浮层内容是专用组件");
	assert.ok(!/from "\.\.\/ui-shadcn\/dropdown-menu"/.test(menu), "条目多时菜单会顶穿窗口：不该再引 DropdownMenu 做长清单");
	// 「管理」入口仍要直达设置页那一行（锚点由 settingsFieldAnchors 索引 + SettingRow.anchor 提供）
	assert.match(menu, /openSettings\(\{ tab: "common", section: "common-quick-messages" \}\)/);

	const picker = readSource("src/renderer/src/components/session/QuickMessagePicker.tsx");
	assert.match(picker, /placeholder=\{t\("app\.quickMessagesSearch"\)\}/, "顶部要有搜索框");
	assert.match(picker, /<Pagination page=\{paged\.page\} totalPages=\{paged\.totalPages\}/, "页脚复用共享分页控件");
	assert.match(picker, /paginateQuickMessages\(filtered, page\)/);
	assert.match(picker, /<Table className="table-fixed">/, "固定表格布局：长条目截断，不把弹框撑宽");
});

test("弹框条目：插入与直发是两个独立按钮，不会一次点击触发两个动作", () => {
	const picker = readSource("src/renderer/src/components/session/QuickMessagePicker.tsx");
	assert.match(picker, /onClick=\{\(\) => props\.onInsert\(text\)\}/);
	assert.match(picker, /onClick=\{\(\) => props\.onSend\(text\)\}/);
	assert.ok(!/<TableRow[^>]*onClick=/.test(picker), "行级点击会让插入与直发叠在一起（旧版靠菜单 stopPropagation 才行）");
	assert.match(picker, /disabled=\{props\.sendDisabled\}/);
});

test("弹框交互：回车插入首条，且放过中文输入法组字（isComposing）", () => {
	const picker = readSource("src/renderer/src/components/session/QuickMessagePicker.tsx");
	assert.match(picker, /if \(event\.key !== "Enter" \|\| event\.nativeEvent\.isComposing\) return;/);
	assert.match(picker, /const first = paged\.items\[0\];/);
});

test("设置页：只留一行预览 + 配置更多入口，清单编辑搬到弹框（不再把 16 行铺进设置页）", () => {
	const row = readSource("src/renderer/src/components/app/settings/QuickMessagesSetting.tsx");
	assert.match(row, /anchor="common-quick-messages"/);
	assert.match(row, /<QuickMessagesDialog open=\{dialogOpen\}/);
	assert.match(row, /t\("settings\.quickMessagesConfigure"\)/);
	// 行里不该再有逐条输入/排序控件：那正是把设置页撑长一屏半的原因
	for (const leaked of ["<Input", "ArrowUp", "Trash2", "commitSoon", "save("]) {
		assert.ok(!row.includes(leaked), `设置行不该包含 ${leaked}`);
	}
	// 预览只取前几条（用户要求「只显示几个」）
	assert.match(row, /const preview = items\.slice\(0, PREVIEW_COUNT\)/);

	const dialog = readSource("src/renderer/src/components/app/settings/QuickMessagesDialog.tsx");
	assert.match(dialog, /max-h-\[min\(52vh,420px\)\][^"]*overflow-y-auto/, "弹框里的列表要自己滚，高度不随条数增长");
});

test("设置页：即时保存配置文件（打字合并 + 结构性操作立即 + 关闭时补写）", () => {
	const editor = readSource("src/renderer/src/hooks/useQuickMessageEditor.ts");
	assert.match(editor, /const \{ [^}]*save,[^}]*refresh,[^}]*openFile \} = useQuickMessages\(\)/);
	// 打字合并写盘 + 结构性操作立刻写盘：两条路径都必须真的落到 save()
	assert.match(editor, /void save\(next\);/);
	assert.match(editor, /const ok = await save\(next\);/);
	// 卸载时补写：否则「敲完直接关弹框」会丢掉最后几个字
	assert.match(editor, /useEffect\(\(\) => \(\) => flushPending\(\), \[flushPending\]\)/);
	// 组件不再接收 draft props（否则又会被卷进全局保存）
	assert.ok(!/props\.value|props\.onChange/.test(editor), "维护区应自持状态，不接收 draft props");

	const commonTab = readSource("src/renderer/src/components/app/settings/CommonTab.tsx");
	assert.match(commonTab, /<QuickMessagesSetting \/>/);
	const summary = readSource("src/renderer/src/components/app/settings/unsavedChangesSummary.ts");
	assert.ok(!/field: "quickMessages"/.test(summary), "即时保存的项不该出现在「未保存改动」汇总里");
});

test("设置页：遗留字段不再被渲染层直接读写（App 也不再往 atom 同步 settings）", () => {
	const app = readSource("src/renderer/src/App.tsx");
	assert.ok(!/quickMessagesAtom/.test(app), "App 不该再同步 settings.quickMessages");
	const hook = readSource("src/renderer/src/hooks/useQuickMessages.ts");
	assert.match(hook, /desktopApi\.quickMessages\s*\.get\(\)/);
	assert.match(hook, /desktopApi\.quickMessages\.save\(items\)/);
});

test("文案：入口/设置项关键 key 中英都有（缺一个界面就露出 key 名）", () => {
	const keys = [
		"app.quickMessagesTitle",
		"app.quickMessagesHint",
		"app.quickMessagesSearch",
		"app.quickMessagesNoMatch",
		"app.quickMessagesCount",
		"app.quickMessagesSend",
		"app.quickMessagesManage",
		"app.quickMessagesEmpty",
		"app.quickMessagesLoading",
		"settings.quickMessages",
		"settings.quickMessagesSection",
		"settings.quickMessagesDesc",
		"settings.quickMessagesConfigure",
		"settings.quickMessagesPreviewEmpty",
		"settings.quickMessagesDone",
		"settings.quickMessagesAdd",
		"settings.quickMessagesReset",
		"settings.quickMessagesSaved",
		"settings.quickMessagesLoading",
		"settings.quickMessagesOpenFile",
		"settings.quickMessagesReload",
		"settings.quickMessagesReloadHint",
		"settings.quickMessagesFileHint",
		"settings.quickMessagesDefaultsUnavailable",
	];
	for (const locale of ["zh-CN", "en-US"]) {
		i18n.setI18nLocale(locale);
		for (const key of keys) {
			const text = i18n.t(key);
			assert.ok(text && text !== key, `${locale} 缺文案: ${key}`);
		}
	}
});

// ── 弹框视图模型（搜索 + 分页，纯函数） ──────────────────────────────

test("搜索过滤：空词/纯空白返回全量，大小写不敏感，只做子串匹配（不做模糊）", () => {
	assert.deepEqual(filterQuickMessages(["继续", "Continue", "提交推送"], ""), ["继续", "Continue", "提交推送"]);
	assert.deepEqual(filterQuickMessages(["继续", "Continue"], "   "), ["继续", "Continue"]);
	assert.deepEqual(filterQuickMessages(["继续", "Continue"], "cont"), ["Continue"]);
	// 「提交」命中两条含该子串的条目，顺序保持配置顺序
	assert.deepEqual(filterQuickMessages(["提交", "提交推送", "推送"], "提交"), ["提交", "提交推送"]);
	// 模糊子序列（「提推」不是任何条目的连续子串）不该命中，否则短词会搜出一堆无关条目
	assert.deepEqual(filterQuickMessages(["提交推送"], "提推"), []);
});

test("分页：按页大小切片，totalPages 向上取整", () => {
	const items = Array.from({ length: 16 }, (_, index) => `item-${index}`);
	const first = paginateQuickMessages(items, 1);
	assert.equal(first.totalPages, 2);
	assert.equal(first.page, 1);
	assert.deepEqual(first.items, items.slice(0, 8));
	assert.deepEqual(paginateQuickMessages(items, 2).items, items.slice(8, 16));
});

test("分页：页码越界夹紧、非数字回第 1 页（搜索截短后不会渲染空页）", () => {
	// 只剩 2 条却停在旧的第 9 页：夹紧回第 1 页并给出内容
	assert.equal(paginateQuickMessages(["a", "b"], 9, 8).page, 1);
	assert.deepEqual(paginateQuickMessages(["a", "b"], 9, 8).items, ["a", "b"]);
	assert.equal(paginateQuickMessages(["a"], 0).page, 1);
	assert.equal(paginateQuickMessages(["a"], Number.NaN).page, 1);
	// 空清单是「1 页空内容」而不是 0 页：界面上不该出现「第 0 页」
	assert.equal(paginateQuickMessages([], 3).totalPages, 1);
	assert.equal(paginateQuickMessages([], 3).page, 1);
	assert.deepEqual(paginateQuickMessages([], 3).items, []);
});

test("分页：非法页大小收敛为 1 条/页（不会得到 Infinity 页）", () => {
	assert.equal(paginateQuickMessages(["a", "b"], 1, 0).totalPages, 2);
	assert.equal(paginateQuickMessages(["a", "b"], 1, Number.NaN).totalPages, 2);
	assert.deepEqual(paginateQuickMessages(["a", "b"], 1, 0).items, ["a"]);
});

test("分页：页大小与出厂条目数对齐（16 条出厂量正好两页，弹框高度可控）", () => {
	assert.equal(QUICK_MESSAGE_PAGE_SIZE, 8);
	assert.equal(paginateQuickMessages(readDefaults().items, 1).totalPages, 2);
});
