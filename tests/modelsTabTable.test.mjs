import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/renderer/src/config/ModelsTab.tsx", "utf8");
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

test("ModelsTab renders model list as shadcn Table (header + body)", () => {
  assert.match(source, /<Table>/);
  assert.match(source, /<TableHeader>/);
  assert.match(source, /<TableBody>/);
  // 常规表头 7 列：id/name/context/maxTokens/thinkingLevels/capabilities/actions；批量模式在最前追加选择列。
  assert.match(source, /<TableHead className="w-48 min-w-0">\{t\("config\.modelId"\)\}/);
  assert.match(source, /<TableHead className="w-24">\{t\("config\.thinkingLevels"\)\}/);
  assert.match(source, /<TableHead className="w-24">\{t\("config\.capabilities"\)\}/);
  assert.match(source, /<TableHead className="w-20 text-right pr-3">\{t\("config\.actions"\)\}<\/TableHead>/);
  // 表头顺序：thinkingLevels 必须在 capabilities 之前
  const headOrder = source.indexOf('t("config.thinkingLevels")');
  const capOrder = source.indexOf('t("config.capabilities")');
  assert.ok(headOrder > -1 && capOrder > -1 && headOrder < capOrder, "thinkingLevels head must precede capabilities head");
  // 旧 CSS grid 布局已移除
  assert.doesNotMatch(source, /config-models-grid-header/);
  assert.doesNotMatch(source, /config-models-grid-row/);
  assert.doesNotMatch(source, /config-checkbox-cell/);
  assert.doesNotMatch(source, /config-input-cell/);
});

test("model row uses TableRow/TableCell with edit controls", () => {
  assert.match(source, /<TableRow[\s\S]*?key=\{`\$\{name\}-\$\{i\}`\}[\s\S]*?data-state=\{isModelBatchMode/);
  // 7 个常规数据单元格；批量模式额外增加一个选择列。
  const cellCount = (source.match(/<TableCell/g) ?? []).length;
  assert.ok(cellCount >= 8, `expected >= 8 TableCells, got ${cellCount}`);
  assert.match(source, /<Input[\s\S]*?placeholder="model-id"[\s\S]*?className="h-8 min-w-0"/);
  // ID 和名称是受控输入框，必须把键盘输入写回 modelsData；否则 React 会把它们渲染成只读。
  assert.match(source, /value=\{m\.id\}[\s\S]*?onChange=\{\(e\) => props\.onUpdateModel\(name, i, "id", e\.target\.value\)\}/);
  assert.match(source, /value=\{m\.name \?\? ""\}[\s\S]*?onChange=\{\(e\) => props\.onUpdateModel\(name, i, "name", e\.target\.value\)\}/);
  // 容量输入框不允许硬编码数值 hint（1000000/128000）：未匹配到目录时应显示为空，
  // 否则用户误以为已匹配（实际 Pi 按 128k 回退）。留空 = 交给 Pi 默认。
  assert.doesNotMatch(source, /placeholder="1000000"/);
  assert.doesNotMatch(source, /placeholder="128000"/);
  assert.match(source, /value=\{m\.contextWindow \?\? ""\}/);
  assert.match(source, /value=\{m\.maxTokens \?\? ""\}/);
  // 删除按钮在操作列
  assert.match(source, /onDeleteModel\(name, i\)/);
});

test("collapsed provider card keeps model count and usage in the header", () => {
  // 折叠态不再另开 h-9 底栏：模型数徽章贴在名称后，用量走卡头 inline（有数据才渲染）。
  assert.match(source, /config\.count\.models/);
  assert.match(source, /ProviderUsageInline\s+provider=\{name\}\s+variant="card"/);
  assert.doesNotMatch(source, /ProviderUsageRow/);
  assert.doesNotMatch(source, /leading=/);
});

test("model batch mode uses a tri-state select column and one confirmation callback", () => {
  assert.match(source, /onDeleteModels: \(providerName: string, indexes: number\[\]\) => void;/);
  assert.match(source, /t\("common\.deleteBatch"\)/);
  assert.match(source, /t\("common\.deleteSelected"\)/);
  assert.match(source, /t\("config\.modelBatchSelected"/);
  assert.match(source, /t\("config\.selectAllModels"\)/);
  assert.match(source, /t\("config\.selectModel"/);
  assert.match(source, /toggleAllModelIndexes/);
  assert.match(source, /checked=\{modelSelectionState === "checked"[\s\S]*?"indeterminate"/);
  assert.match(source, /onDeleteModels\(name, \[\.\.\.selectedModelIndexes\]\)/);
  assert.match(source, /clearModelBatch\(\);/);
});

test("adaptive auto-fill writes fields directly, no capability card", () => {
  // 自适应只把值填进对应输入框，不再展示“匹配到什么/来源/能力清单”解释卡
  assert.doesNotMatch(source, /ModelCapabilityCard/);
  assert.doesNotMatch(source, /modelCapabilitySpecs/);
  assert.doesNotMatch(source, /modelCapabilitySpec\b/);
});

test("reset-to-adaptive button lives in the model actions column", () => {
  // 操作列：RotateCcw 重置按钮（显式刷 endpoint）在计费按钮之前
  assert.match(source, /onClick=\{\(\) => props\.onResetModel\(name, i\)\} disabled=\{props\.resettingModelKey === getModelInputKey\(name, i\)\}/);
  assert.match(source, /<RotateCcw className="size-3\.5" aria-hidden="true" \/>/);
  assert.match(source, /title=\{t\("config\.modelResetAdaptive"\)\}/);
  assert.match(source, /onResetModel: \(providerName: string, index: number\) => void;/);
  assert.match(source, /resettingModelKey: string \| null;/);
});

test("reasoning and image checkboxes share one capabilities column", () => {
  // 同列堆叠（flex flex-col），不再各占一列
  assert.match(source, /<div className="flex flex-col gap-1">/);
  assert.match(source, /<span>\{t\("config\.reasoning"\)\}<\/span>/);
  assert.match(source, /<span>\{t\("config\.inputTypeImage"\)\}<\/span>/);
  assert.doesNotMatch(source, /<TableCell className="p-2 text-center">[\s\S]*?config\.reasoning/);
  // 图片勾选逻辑保留（input 数组 text/image 切换）
  assert.match(source, /const base = m\.input \?\? \["text", "image"\]/);
});

test("thinking levels open in a Popover from a single button", () => {
  // 一个按钮（摘要 + Brain 图标），点击弹 Popover 内两个下拉
  assert.match(source, /<Popover>/);
  assert.match(source, /<PopoverTrigger asChild>/);
  assert.match(source, /<Brain className="size-3\.5 shrink-0 opacity-60"/);
  assert.match(source, /xhighValue \|\| maxValue \? \[xhighValue, maxValue\]\.filter\(Boolean\)\.join\(" \/ "\) : t\("config\.xhighOff"\)/);
  assert.match(source, /<PopoverContent align="start" className="w-48 p-2">/);
  // 两个级别仍是 ConfigSelect + 白名单收窄（项目禁 as 强转）
  const selectCount = (source.match(/<ConfigSelect/g) ?? []).length;
  assert.ok(selectCount >= 2, `expected >= 2 ConfigSelect, got ${selectCount}`);
  assert.match(source, /if \(v === "" \|\| v === "xhigh" \|\| v === "max"\)/);
  assert.match(source, /onUpdateModelThinkingLevel\(name, i, key, v\)/);
  // 不再有行内两组三按钮
  assert.doesNotMatch(source, /config-thinking-levels-segmented/);
  assert.doesNotMatch(source, /config-thinking-level-option/);
  assert.doesNotMatch(source, /aria-pressed=\{value === option\}/);
});

test("cost config opens in a Dialog per model", () => {
  // 计费按钮（Coins 图标）触发受控 Dialog，不再占整行子行
  assert.match(source, /costDialogKey === `\$\{name\}-\$\{i\}`/);
  assert.match(source, /<Coins className="size-3\.5" aria-hidden="true" \/>/);
  assert.match(source, /<Dialog open=\{costDialogKey ===/);
  // 计费弹窗加宽（sm:max-w-2xl）以容纳梯度计费表格，Dialog 内两列排布
  assert.match(source, /<DialogContent className="sm:max-w-3xl">/);
  assert.match(source, /config\.modelCost/);
  assert.match(source, /config\.advancedPreservedModel/);
  // 计费输入框保持原 field 布局 class（CSS 保留），Dialog 内两列排布
  assert.match(source, /<div className="grid grid-cols-2 gap-2">/);
  assert.match(source, /config-model-cost-field/);
  // 不再有 colSpan 子行
  assert.doesNotMatch(source, /-cost`\} className="hover:bg-transparent">/);
  assert.doesNotMatch(source, /<TableCell colSpan=\{8\} className="p-0 px-3 pb-2">/);
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
  assert.match(source, /provider\.models\.length === 0 && \(/);
  assert.match(source, /<TableRow className="hover:bg-transparent">[\s\S]*?colSpan=\{isModelBatchMode \? 8 : 7\}[\s\S]*?config\.emptyModels/);
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
