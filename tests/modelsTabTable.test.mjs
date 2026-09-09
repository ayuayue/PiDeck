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
  assert.match(formSource, /config\.field\.baseUrl/);
  assert.match(formSource, /config\.field\.apiType/);
  assert.match(formSource, /config\.field\.apiKey/);
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
  assert.match(tableSource, /onDeleteSelected\?:/);
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

test("reasoning and image checkboxes share one capabilities column", () => {
  // 同列堆叠（flex flex-col），不再各占一列
  assert.match(tableSource, /<div className="flex flex-col gap-1">/);
  assert.match(tableSource, /<span>\{t\("config\.reasoning"\)\}<\/span>/);
  assert.match(tableSource, /<span>\{t\("config\.inputTypeImage"\)\}<\/span>/);
  assert.doesNotMatch(tableSource, /<TableCell className="p-2 text-center">[\s\S]*?config\.reasoning/);
  // 图片勾选逻辑保留（input 数组 text/image 切换）
  assert.match(tableSource, /const base = m\.input \?\? \["text", "image"\]/);
});

test("thinking levels open in a Popover from a single button", () => {
  // 一个按钮（摘要 + Brain 图标），点击弹 Popover 内两个下拉
  assert.match(tableSource, /<Popover>/);
  assert.match(tableSource, /<PopoverTrigger asChild>/);
  assert.match(tableSource, /<Brain className="size-3\.5 shrink-0 opacity-60"/);
  assert.match(tableSource, /xhighValue \|\| maxValue \? \[xhighValue, maxValue\]\.filter\(Boolean\)\.join\(" \/ "\) : t\("config\.xhighOff"\)/);
  assert.match(tableSource, /<PopoverContent align="start" className="w-48 p-2">/);
  // 两个级别仍是 ConfigSelect + 白名单收窄（项目禁 as 强转）；源码中一处字面量经 map 渲染两行
  assert.match(tableSource, /<ConfigSelect/);
  assert.match(tableSource, /if \(v === "" \|\| v === "xhigh" \|\| v === "max"\)/);
  assert.match(tableSource, /onUpdateModelThinkingLevel\(i, key, v\)/);
  // 不再有行内两组三按钮
  assert.doesNotMatch(tableSource, /config-thinking-levels-segmented/);
  assert.doesNotMatch(tableSource, /config-thinking-level-option/);
  assert.doesNotMatch(tableSource, /aria-pressed=\{value === option\}/);
});

test("cost config opens in a Dialog per model", () => {
  // 计费按钮（Coins 图标）触发受控 Dialog（组件内部以 index 定位打开行），不再占整行子行
  assert.match(tableSource, /costDialogIndex === i/);
  assert.match(tableSource, /<Coins className="size-3\.5" aria-hidden="true" \/>/);
  assert.match(tableSource, /<Dialog open=\{costDialogIndex ===/);
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
  // 保留：计费字段布局 / 图片 label / 级别行与 key 样式（Popover 内使用）
  assert.doesNotMatch(surfaces, /\.config-model-cost \{/);
  assert.match(surfaces, /\.config-model-cost-field \{/);
  assert.match(surfaces, /\.config-input-option \{/);
  assert.match(surfaces, /\.config-thinking-levels-cell \{/);
  assert.match(surfaces, /\.config-thinking-levels-row \.config-select-trigger > span/);
});