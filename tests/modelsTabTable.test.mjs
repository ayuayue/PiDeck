import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tabSource = readFileSync("src/renderer/src/config/ModelsTab.tsx", "utf8");
const tableSource = readFileSync("src/renderer/src/config/ModelsTable.tsx", "utf8");
const dialogSource = readFileSync("src/renderer/src/config/AddProviderDialog.tsx", "utf8");
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

test("ModelsTable renders model list as shadcn Table (header + body)", () => {
	// 表格结构已在共享组件 ModelsTable：展开卡片与编辑页共用同一份实现
	assert.match(tableSource, /<Table>/);
	assert.match(tableSource, /<TableHeader>/);
	assert.match(tableSource, /<TableBody>/);
	// 常规表头 7 列：id/name/context/maxTokens/thinkingLevels/capabilities/actions；批量模式在最前追加选择列。
	assert.match(tableSource, /<TableHead className="w-48 min-w-0">\{t\("config\.modelId"\)\}/);
	assert.match(tableSource, /<TableHead className="w-24">\{t\("config\.thinkingLevels"\)\}/);
	assert.match(tableSource, /<TableHead className="w-24">\{t\("config\.capabilities"\)\}/);
	assert.match(tableSource, /<TableHead className="w-20 text-right pr-3">\{t\("config\.actions"\)\}<\/TableHead>/);
	// ID 与名称同宽（用户反馈：不一致时表格看着歪）
	assert.match(tableSource, /<TableHead className="w-48 min-w-0">\{t\("config\.modelId"\)\}<\/TableHead>\s*<TableHead className="w-48 min-w-0">\{t\("config\.modelDisplayName"\)\}<\/TableHead>/);

	// 表头顺序：thinkingLevels 必须在 capabilities 之前
	const headOrder = tableSource.indexOf('t("config.thinkingLevels")');
	const capOrder = tableSource.indexOf('t("config.capabilities")');
	assert.ok(headOrder > -1 && capOrder > -1 && headOrder < capOrder, "thinkingLevels head must precede capabilities head");
	// 旧 CSS grid 布局已移除
	assert.doesNotMatch(tableSource, /config-models-grid-header/);
	assert.doesNotMatch(tableSource, /config-models-grid-row/);
	assert.doesNotMatch(tableSource, /config-checkbox-cell/);
	assert.doesNotMatch(tableSource, /config-input-cell/);
});

test("model row uses TableRow/TableCell with edit controls", () => {
	assert.match(tableSource, /<TableRow[\s\S]*?key=\{rowKey\}[\s\S]*?data-state=\{batchMode/);
	// 7 个常规数据单元格；批量模式额外增加一个选择列。
	const cellCount = (tableSource.match(/<TableCell/g) ?? []).length;
	assert.ok(cellCount >= 8, `expected >= 8 TableCells, got ${cellCount}`);
	assert.match(tableSource, /<Input[\s\S]*?placeholder="model-id"[\s\S]*?className="h-8 min-w-0"/);
	// ID 和名称是受控输入框，必须把键盘输入写回（index 定位回调）；否则 React 会把它们渲染成只读。
	assert.match(tableSource, /value=\{m\.id\}[\s\S]*?onChange=\{\(e\) => props\.onUpdateModel\(i, "id", e\.target\.value\)\}/);
	assert.match(tableSource, /value=\{m\.name \?\? ""\}[\s\S]*?onChange=\{\(e\) => props\.onUpdateModel\(i, "name", e\.target\.value\)\}/);
	// 容量输入框不允许硬编码数值 hint（1000000/128000）：未匹配到目录时应显示为空，
	// 否则用户误以为已匹配（实际 Pi 按 128k 回退）。留空 = 交给 Pi 默认。
	assert.doesNotMatch(tableSource, /placeholder="1000000"/);
	assert.doesNotMatch(tableSource, /placeholder="128000"/);
	assert.match(tableSource, /value=\{m\.contextWindow \?\? ""\}/);
	assert.match(tableSource, /value=\{m\.maxTokens \?\? ""\}/);
	// 删除按钮在操作列（index 定位）
	assert.match(tableSource, /onClick=\{\(\) => props\.onDeleteModel\(i\)\}/);
});

test("ModelsTab and AddProviderDialog both reuse the shared ModelsTable", () => {
	// 展开卡片与编辑页共用同一表格：改一处两处生效，不允许各自造一套
	assert.match(tabSource, /<ModelsTable/);
	assert.match(dialogSource, /<ModelsTable/);
});

test("provider card keeps model count + inline usage in the header, drops the usage details block, and expands on whole-row click", () => {
	// 折叠态不再另开 h-9 底栏：模型数徽章 + 卡头用量徽标（时间+数值+刷新）都收进标题行；
	// 展开体里的「用量」明细块（ProviderUsageDetails）按要求移除——卡头徽标已覆盖展示。
	assert.match(tabSource, /config\.count\.models/);
	assert.match(tabSource, /ProviderUsageInline\s+provider=\{name\}\s+variant="card"/);
	// 卡头用量查询配置入口保留（内置支持的供应商零配置自动生效，不渲染）。
	assert.match(tabSource, /UsageQueryEntryButton/);
	// 上游新增：整行点击展开/收起（右侧操作区 stopPropagation）。
	assert.match(tabSource, /cursor-pointer/);
	assert.match(tabSource, /onClick=\{\(\) => props\.onToggleProvider\(name\)\}/);
	assert.doesNotMatch(tabSource, /ProviderUsageDetails/);
	assert.doesNotMatch(tabSource, /ProviderUsageRow/);
	assert.doesNotMatch(tabSource, /leading=/);
});

test("both provider entries share ProviderConnectionForm (no per-entry divergence)", () => {
	const formSource = readFileSync("src/renderer/src/config/ProviderConnectionForm.tsx", "utf8");
	// 连接字段 + 测试连接 + 兼容性：两处入口都复用同一组件，不再各写一套
	assert.match(tabSource, /<ProviderConnectionForm/);
	assert.match(dialogSource, /<ProviderConnectionForm/);
	const endpointsSource = readFileSync("src/renderer/src/config/ProviderEndpointFields.tsx", "utf8");
	const dshDialogSource = readFileSync("src/renderer/src/config/AddDshProviderDialog.tsx", "utf8");
	// 连接字段由 Pi/DSH 共用子组件持有；Pi 的测试/兼容性仍留在原表单。
	assert.match(formSource, /<ProviderEndpointFields\s/);
	assert.match(dshDialogSource, /<ProviderEndpointFields\s/);
	assert.match(endpointsSource, /config\.field\.baseUrl/);
	assert.match(endpointsSource, /config\.field\.apiType/);
	assert.match(endpointsSource, /config\.field\.apiKey/);
	assert.match(endpointsSource, /config\.dsh\.baseUrlHint/);
	assert.match(formSource, /config\.field\.userAgent/);
	assert.match(formSource, /config\.compatibility/);
	assert.match(formSource, /config\.testModel/);
	assert.match(formSource, /config\.testProxy/);
	// 代理选择右侧的说明小字按要求去掉（保存界面干净），组件内不得再渲染代理 URL 提示
	assert.doesNotMatch(formSource, /proxyModeHint/);
	assert.doesNotMatch(formSource, /proxyUrlUnset/);
	assert.doesNotMatch(tabSource, /proxyModeHint/);
});

test("edit-provider page reaches feature parity with the expanded card", () => {
	// 添加/编辑供应商页与展开卡片共用同一套模型表格能力（重置自适应 / 失焦补全 / 批量删除 / 手动添加）
	assert.match(dialogSource, /onResetModel=\{handleResetModelToAdaptive\}/);
	assert.match(dialogSource, /onBlurAutoFill=\{applyModelSpecAutoFill\}/);
	assert.match(dialogSource, /batchMode=\{modelBatchMode\}/);
	assert.match(dialogSource, /removeSelectedModelIndexes\(prev, selectedModelIndexes\)/);
	assert.match(dialogSource, /t\("common\.deleteSelected"\)/);
	assert.match(dialogSource, /t\("config\.addModelManual"\)/);
	assert.match(dialogSource, /focusModelKey=\{pendingModelFocusKey\}/);
	// 保存勾选的获取结果时同样按 pi-ai 目录补全（与卡片流程一致）
	assert.match(dialogSource, /computeModelSpecPatches\(m, results\[i\]\)/);
	assert.match(dialogSource, /config\.modelsSavedWithSpecs/);
	// 上移/下移 / 隐藏 / 逐模型 UA / 每模型默认档位 / Pi 探测这些行内操作，两条入口的完整 prop
	// 集合由 tests/modelTableEntryParity.test.mjs 做集合级对齐断言（新增操作必须两条入口同时接线）。
});

test("model batch mode uses a tri-state select column and one confirmation callback", () => {
	// 批量回调契约在 ModelsTab props；批量按钮区也留在 ModelsTab（表格只负责选择列与全选）
	assert.match(tabSource, /onDeleteModels: \(providerName: string, indexes: number\[\]\) => void;/);
	assert.match(tabSource, /t\("common\.deleteBatch"\)/);
	assert.match(tabSource, /t\("common\.deleteSelected"\)/);
	assert.match(tabSource, /onDeleteModels\(name, \[\.\.\.selectedModelIndexes\]\)/);
	assert.match(tabSource, /clearModelBatch\(\);/);
	// 三态选择列（全选）与行勾选在共享表格组件内，经回调上抛
	assert.match(tableSource, /checked=\{selectionState === "checked"[\s\S]*?"indeterminate"/);
	assert.match(tableSource, /t\("config\.selectAllModels"\)/);
	assert.match(tableSource, /t\("config\.selectModel"/);
	assert.match(tableSource, /onToggleAll\?\.\(models\.length\)/);
});

test("adaptive auto-fill writes fields directly, no capability card", () => {
	// 失焦自动补全仍由 ModelsTab 持有（需要 providerName 上下文），经 onBlurAutoFill 传入共享表格
	assert.match(tabSource, /onBlurAutoFill=\{\(i, modelId\) => void applyModelSpecAutoFill\(name, i, modelId\)\}/);
	assert.match(tableSource, /onBlurAutoFill\?:/);
	assert.match(tableSource, /onBlur=\{\(e\) => props\.onBlurAutoFill\?\.\(i, e\.target\.value\)\}/);
	// 自适应只把值填进对应输入框，不再展示“匹配到什么/来源/能力清单”解释卡
	assert.doesNotMatch(tabSource, /ModelCapabilityCard/);
	assert.doesNotMatch(tabSource, /modelCapabilitySpecs/);
	assert.doesNotMatch(tabSource, /modelCapabilitySpec\b/);
});

test("reset-to-adaptive button lives in the model actions column", () => {
	// 操作列：RotateCcw 重置按钮（显式刷 endpoint）在计费按钮之前；编辑页不传 onResetModel 则隐藏
	assert.match(tableSource, /onClick=\{\(\) => props\.onResetModel!\(i\)\} disabled=\{props\.resettingModelKey === rowKey\}/);
	assert.match(tableSource, /<RotateCcw className="size-3\.5" aria-hidden="true" \/>/);
	assert.match(tableSource, /title=\{t\("config\.modelResetAdaptive"\)\}/);
	assert.match(tableSource, /onResetModel\?: \(index: number\) => void;/);
	assert.match(tableSource, /resettingModelKey\?: string \| null;/);
	assert.match(tabSource, /onResetModel=\{\(i\) => props\.onResetModel\(name, i\)\}/);
});

test("两个 token 数字列宽度一致且加宽一档（数字不再被裁）", () => {
	// 用户反馈：这两列的数字常被右侧原生步进器挤掉 → 只加宽列，输入框样式保持原生不动。
	assert.match(tableSource, /<TableHead className="w-28">\{t\("config\.contextWindow"\)\}<\/TableHead>\s*<TableHead className="w-28">\{t\("config\.maxTokens"\)\}<\/TableHead>/);
	// 输入框是最初的写法：原生 type=number + 原始样式（不自定义箭头、不加内边距）
	assert.match(tableSource, /value=\{m\.contextWindow \?\? ""\}[\s\S]{0,300}className="h-8 min-w-0"/);
	assert.match(tableSource, /value=\{m\.maxTokens \?\? ""\}[\s\S]{0,300}className="h-8 min-w-0"/);
	// 不留自绘步进器 / 自定义样式常量的痕迹
	assert.doesNotMatch(tableSource, /TOKEN_NUMBER_INPUT_CLASS|ConfigNumberInput/);
});

test("reasoning and image checkboxes share one capabilities column", () => {
	// 同列堆叠（flex flex-col），不再各占一列
	assert.match(tableSource, /<div className="flex flex-col gap-1">/);
	assert.match(tableSource, /<span>\{t\("config\.reasoning"\)\}<\/span>/);
	assert.match(tableSource, /<span>\{t\("config\.inputTypeImage"\)\}<\/span>/);
	assert.doesNotMatch(tableSource, /<TableCell className="p-2 text-center">[\s\S]*?config\.reasoning/);
	// 图片勾选逻辑保留（input 数组 text/image 切换）
	assert.match(tableSource, /const base = m\.input \?\? \["text", "image"\]/);
});

test("thinking levels are picked with checkboxes over Pi's canonical levels", () => {
	// 一个按钮（范围摘要 + Brain 图标），点击弹 Popover：档位勾选列表 + 每模型默认档位
	assert.match(tableSource, /<Popover>/);
	assert.match(tableSource, /<PopoverTrigger asChild>/);
	assert.match(tableSource, /<Brain className="size-3\.5 shrink-0 opacity-60"/);
	// 勾选列表：Pi 的 7 个规范档位逐个 Checkbox；勾选态由共享纯函数判定（不在行内重写 pi 的可用档位规则）
	assert.match(tableSource, /thinkingLevelOptions\s*=\s*MODEL_THINKING_LEVELS\.map\(\(level\) => \(\{ level, state: modelThinkingLevelState\(m, level\) \}\)\)/);
	assert.match(tableSource, /const\s+enabledThinkingLevels\s*=\s*enabledModelThinkingLevels\(m\)/);
	assert.match(tableSource, /thinkingLevelOptions\.map\(\(\{ level, state \}\)[\s\S]*?<Checkbox[\s\S]*?checked=\{state\.enabled\}[\s\S]*?onUpdateModelThinkingLevel\(i, level, enabled\)/);
	// 非恒等上游值（目录补全 / 手改配置）只读展示为 `→ 值`；旧的两个 xhigh/max ConfigSelect 已被勾选取代
	assert.match(tableSource, /state\.wireValue/);
	assert.match(tableSource, /t\("config\.thinkingLevelsWireValue"\)/);
	assert.doesNotMatch(tableSource, /config-thinking-levels-cell/);
	assert.doesNotMatch(tableSource, /config\.xhighOff/);
	// 单元格摘要 = 范围折叠（CC Switch 风格，如 `off → max`），全部未勾选时回落「未设置」
	assert.match(tableSource, /const\s+thinkingSummary\s*=\s*enabledThinkingLevels\.length > 0 \? formatModelThinkingLevelsSummary\(enabledThinkingLevels\) : t\("config\.thinkingLevelsNotSet"\)/);
	// 悬停补充完整清单 + 每模型默认档位（单元格只放得下摘要）
	assert.match(tableSource, /title=\{thinkingSummaryTitle\}/);
	// 弹层加宽以容纳勾选列表
	assert.match(tableSource, /<PopoverContent align="start" className="w-64 p-2">/);
	// 旧的 xhigh/max 取值变量与行内两组三按钮都不再存在
	assert.doesNotMatch(tableSource, /xhighValue/);
	assert.doesNotMatch(tableSource, /maxValue/);
	assert.doesNotMatch(tableSource, /config-thinking-levels-segmented/);
	assert.doesNotMatch(tableSource, /config-thinking-level-option/);
	assert.doesNotMatch(tableSource, /aria-pressed=\{value === option\}/);
});

test("per-model default thinking level is edited from the same Popover", () => {
	// 每模型默认档位（settings.json 的 modelThinkingLevels）：写入口在思考级别 Popover 底部，
	// 与档位勾选同处一弹层（不新开列，不撑行高）。
	assert.match(tableSource, /onUpdateModelThinkingLevelDefault\?: \(index: number, value: string\) => void;/);
	assert.match(tableSource, /getModelThinkingLevelDefault\?: \(index: number\) => string;/);
	assert.match(tableSource, /const\s+canEditThinkingDefault\s*=\s*Boolean\(props\.onUpdateModelThinkingLevelDefault\s*&&\s*props\.getModelThinkingLevelDefault\)/);
	assert.match(tableSource, /t\("config\.thinkingLevelDefault"\)/);
	assert.match(tableSource, /t\("config\.thinkingLevelDefaultInherit"\)/);
	assert.match(tableSource, /t\("config\.thinkingLevelDefaultHint"\)/);
	assert.match(tableSource, /props\.onUpdateModelThinkingLevelDefault!\(i, v\)/);

	// 候选档位 = 已勾选档位（默认档位必须落在可用档位里）；一个都没勾时禁用编辑。当前值不在候选里时
	// 由 ConfigSelect 的「自定义」项兜底展示（不丢用户旧值）。
	assert.match(tableSource, /const\s+thinkingDefaultOptions\s*=\s*\[\{ value: "", label: t\("config\.thinkingLevelDefaultInherit"\) \}, \.\.\.enabledThinkingLevels\.map\(\(level\) => \(\{ value: level, label: level \}\)\)\]/);
	assert.match(tableSource, /const\s+thinkingDefaultDisabled\s*=\s*enabledThinkingLevels\.length === 0/);
	assert.match(tableSource, /<ConfigSelect value=\{thinkingDefaultValue\} options=\{thinkingDefaultOptions\} onChange=\{\(v\) => props\.onUpdateModelThinkingLevelDefault\!\(i, v\)\} disabled=\{thinkingDefaultDisabled\}/);
	// 取消勾选的档位正是当前默认档位时一并清掉（否则默认档位指向不可用档位，pi 只能 clamp）。
	assert.match(tableSource, /if \(!enabled && canEditThinkingDefault && thinkingDefaultValue === level\) props\.onUpdateModelThinkingLevelDefault\!\(i, ""\)/);
	// Pi 的探测结果只读展示（未知 / 权威空 / 范围折叠），不再充当默认档位的候选来源。
	assert.match(tableSource, /t\("config\.thinkingLevelsProbed", \{ levels: formatModelThinkingLevelsSummary\(orderModelThinkingLevels\(availableThinkingLevels\)\) \}\)/);

	// ModelsTab 经能力目录（provider/modelId 键）取该行模型的可用档位，并把回调收敛到 provider 上下文。
	assert.match(tabSource, /const availableThinkingLevels = useAvailableThinkingLevels\(\);/);
	assert.match(tabSource, /availableThinkingLevels\.get\(modelThinkingLevelsKey\(name, model\.id\)\)/);
	// 逐模型设置按 modelId（不是行下标）建键：卡片负责把行下标翻译成 provider.models[i].id 再交给父级。
	assert.match(tabSource, /onUpdateModelThinkingLevelDefault=\{props\.onUpdateModelThinkingLevelDefault && props\.getModelThinkingLevelDefault \? \(i, value\) => props\.onUpdateModelThinkingLevelDefault!\(name, provider\.models\[i\]\?\.id \?\? "", value\) : undefined\}/);
	assert.match(tabSource, /getModelThinkingLevelDefault=\{props\.onUpdateModelThinkingLevelDefault && props\.getModelThinkingLevelDefault \? \(i\) => props\.getModelThinkingLevelDefault!\(name, provider\.models\[i\]\?\.id \?\? ""\) : undefined\}/);
	// 档位勾选回调按 provider 上下文透传（level + enabled，不再是 xhigh/max 的白名单值）
	assert.match(tabSource, /onUpdateModelThinkingLevel=\{\(i, level, enabled\) => props\.onUpdateModelThinkingLevel\(name, i, level, enabled\)\}/);
});

test("cost config opens in a Dialog per model", () => {
	// 计费按钮（Coins 图标）触发受控 Dialog（组件内部以 index 定位打开行），不再占整行子行
	assert.match(tableSource, /costDialogIndex === i/);
	assert.match(tableSource, /<Coins className="size-3\.5" aria-hidden="true" \/>/);
	// Dialog 的 open 表达式可能被格式化换行：\s* 容忍。
	assert.match(tableSource, /<Dialog\s+open=\{costDialogIndex ===/);
	// 计费弹窗加宽（sm:max-w-3xl）以容纳梯度计费表格，Dialog 内两列排布
	assert.match(tableSource, /<DialogContent className="sm:max-w-3xl">/);
	assert.match(tableSource, /config\.modelCost/);
	assert.match(tableSource, /config\.advancedPreservedModel/);
	// 计费输入框保持原 field 布局 class（CSS 保留），Dialog 内两列排布
	assert.match(tableSource, /<div className="grid grid-cols-2 gap-2">/);
	assert.match(tableSource, /config-model-cost-field/);
	// 不再有 colSpan 子行
	assert.doesNotMatch(tableSource, /-cost`\} className="hover:bg-transparent">/);
	assert.doesNotMatch(tableSource, /<TableCell colSpan=\{8\} className="p-0 px-3 pb-2">/);
});

test("popover z-index follows project variable so it stays above ConfigModal Dialog", () => {
	// 项目弹层体系：--z-dialog 950（Dialog overlay/content）、--z-popover 960（Select/Dropdown/Tooltip）。
	// Popover 曾写死 z-50 被 Dialog 盖住（思考级别下拉“跑弹框后面”），现统一走 --z-popover。
	const popover = readFileSync("src/renderer/src/components/ui-shadcn/popover.tsx", "utf8");
	assert.match(popover, /z-\(--z-popover\) w-72/);
	assert.doesNotMatch(popover, /"z-50 w-72/);
	const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
	assert.match(foundation, /--z-dialog: 950;/);
	assert.match(foundation, /--z-popover: 960;/);
});

test("empty state is a colSpan row inside TableBody", () => {
	assert.match(tableSource, /models\.length === 0 && \(/);
	assert.match(tableSource, /<TableRow className="hover:bg-transparent">[\s\S]*?colSpan=\{batchMode \? 8 : 7\}[\s\S]*?config\.emptyModels/);
});

test("dead CSS rules removed, kept rules intact", () => {
	assert.doesNotMatch(surfaces, /\.config-models-grid-header/);
	assert.doesNotMatch(surfaces, /\.config-models-grid-row/);
	assert.doesNotMatch(surfaces, /\.config-checkbox-cell/);
	assert.doesNotMatch(surfaces, /\.config-input-cell/);
	assert.doesNotMatch(surfaces, /\.config-xhigh-cell/);
	assert.doesNotMatch(surfaces, /\.config-thinking-levels-segmented/);
	assert.doesNotMatch(surfaces, /\.config-thinking-level-option/);
	assert.doesNotMatch(surfaces, /\.config-cost-cell/);
	// 思考档位改勾选列表后，xhigh/max 两行下拉留下的 legacy 样式全部下线
	assert.doesNotMatch(surfaces, /\.config-thinking-levels/);
	// 保留：计费字段布局 / 图片 label
	assert.doesNotMatch(surfaces, /\.config-model-cost \{/);
	assert.match(surfaces, /\.config-model-cost-field \{/);
	assert.match(surfaces, /\.config-input-option \{/);
});

test("逐模型 UA 不再占独立列，改由操作列图标 + 弹框编辑", () => {
	// 回归（2026-09 用户反馈）：每行摊一个 w-40 空输入框太占宽度，改成
	// 操作列指纹图标（已配置时高亮）+ Dialog 内的 ConfigComboboxInput。
	assert.doesNotMatch(tableSource, /<TableHead[^>]*>\{t\("config\.modelUserAgent"\)\}/, "表头不应再有 UA 列");
	assert.doesNotMatch(tableSource, /showUaColumn/, "旧的列开关变量应已移除");

	// 图标按钮：两个回调都在时才渲染；已配置（非空）时用强调色高亮（代替独立列的「一眼可见」）
	assert.match(tableSource, /\{hasUserAgentOverride && \(\s*<Button[\s\S]*?className=\{userAgentOverride \? "size-7 text-\[color:var\(--color-accent\)\]" : "size-7"\}[\s\S]*?setUaDialogIndex\(i\)[\s\S]*?<Fingerprint/);

	// 弹框：每行一个受控 Dialog，内含解释、UA 下拉与「清除覆盖」
	assert.match(tableSource, /<Dialog\s*open=\{uaDialogIndex === i\}[\s\S]*?<DialogDescription>\{t\("config\.modelUserAgentDialogDesc"\)\}[\s\S]*?<ConfigComboboxInput value=\{userAgentOverride\}[\s\S]*?config\.modelUserAgentClear/);

	// 值的读写在行内收拢：空串 = 继承供应商级 UA
	assert.match(tableSource, /const userAgentOverride = hasUserAgentOverride \? props\.getModelUserAgentOverride!\(i\) : "";/);
	assert.match(tableSource, /onChange=\{\(value\) => props\.onUpdateModelUserAgent!\(i, value\)\}/);
});
