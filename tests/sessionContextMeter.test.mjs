import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { formatPercent } from "../src/renderer/src/components/session/TimelineFormat.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 与 sessionWidgetChips.test.mjs 相同的 TSX 编译替身模式：只测公开 helper 与源码结构。
function compile(filePath, stubs = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => stubs[specifier] ?? {};
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
  }, { filename: filePath });
  return module.exports;
}

const meterPath = "src/renderer/src/components/session/SessionContextMeter.tsx";
const meterSource = () => readFileSync(meterPath, "utf8");
const bottomBarSource = () =>
  readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const zh = () => readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = () => readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

function loadMeterHelpers() {
  return compile(meterPath, {
    react: {},
    "../../i18n": { t: (key) => key },
    "../../../../shared/types": {},
    "../../../../shared/compactFeedback": loadTsCommonJs("src/shared/compactFeedback.ts"),
    "../ui-shadcn/tooltip": {},
  });
}

test("formatTokens follows the dsh StatsLine compaction", () => {
  const { formatTokens } = loadMeterHelpers();
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1K");
  assert.equal(formatTokens(1234), "1.2K");
  // dsh 语义：≥100 直接取整（123.4K → 123K），不保留小数
  assert.equal(formatTokens(123400), "123K");
  assert.equal(formatTokens(999500), "1000K");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(128_000_000), "128M");
  assert.equal(formatTokens(12_400_000), "12.4M");
});

test("contextOccupancy keeps raw percent and recomputes zero percent from tokens", () => {
  const { contextOccupancy } = loadMeterHelpers();
  const occ = (state) => contextOccupancy(state);
  // vm 跨 realm 对象原型不同，deepEqual 会误判，按字段断言
  const fieldsOf = (state) => {
    const result = occ(state);
    return result === null ? null : `${result.percent}:${result.usedTokens}:${result.contextWindow}`;
  };
  // 常规：percent 保留原始精度（不再四舍五入成整数）
  assert.equal(fieldsOf({ contextPercent: 45.3, contextTokens: 57600, contextWindow: 128000 }), "45.3:57600:128000");
  // 超过 100 不封顶：pi 可能上报未封顶的原始值（缓存超窗），与 CLI footer 同口径
  assert.equal(fieldsOf({ contextPercent: 112, contextTokens: 100, contextWindow: 200 }), "112:100:200");
  // percent 上报为 0 但 tokens 非 0（pi/dsh 取整成 0 或未随 tokens 刷新）：
  // 按 tokens/window 重算，避免「占用 0% 但 ~408 / 1M」的自相矛盾展示
  const recomputed = occ({ contextPercent: 0, contextTokens: 408, contextWindow: 1_000_000 });
  assert.ok(recomputed !== null && Math.abs(recomputed.percent - 0.0408) < 1e-9);
  assert.equal(recomputed.usedTokens, 408);
  // tokens 为 0 时保持 0，不重算
  assert.equal(fieldsOf({ contextPercent: 0, contextTokens: 0, contextWindow: 1000 }), "0:0:1000");
  // 缺任一字段 = 无 capacity（模型切换瞬间），返回 null 不渲染
  assert.equal(occ(undefined), null);
  assert.equal(occ({ contextPercent: 50 }), null);
  assert.equal(occ({ contextTokens: 50, contextWindow: 100 }), null);
  assert.equal(occ({ contextPercent: 50, contextTokens: 50 }), null);
});

test("formatPercent keeps sub-percent precision for small context usage", () => {
  // 1M 窗口下 408 tokens ≈ 0.04%：整数四舍五入会显示成「0%」，必须保留有效数字
  assert.equal(formatPercent(0.0408), "0.04");
  assert.equal(formatPercent(0), "0");
  assert.equal(formatPercent(0.004), "0"); // 两位小数后仍为 0
  assert.equal(formatPercent(0.996), "1");
  assert.equal(formatPercent(1), "1");
  assert.equal(formatPercent(1.26), "1.3");
  assert.equal(formatPercent(9.94), "9.9");
  assert.equal(formatPercent(10), "10");
  assert.equal(formatPercent(45), "45");
  assert.equal(formatPercent(45.3), "45");
  assert.equal(formatPercent(100), "100");
});

test("meter ring follows the dsh geometry: 14px viewBox, r=5.5, 2px stroke, top-start fill", () => {
  const source = meterSource();
  // 几何常量与 svg 结构（dsh ContextMeter 逐字节移植）
  assert.match(source, /const RADIUS = 5\.5/);
  assert.match(source, /CIRCUMFERENCE = 2 \* Math\.PI \* RADIUS/);
  assert.match(source, /viewBox="0 0 14 14" width="14" height="14"/);
  assert.match(source, /strokeDasharray=\{`\$\{CIRCUMFERENCE \* percent \/ 100\} \$\{CIRCUMFERENCE\}\`\}/);
  assert.match(source, /transform="rotate\(-90 7 7\)"/);
  // 28px 圆形点击区（与附件按钮同族）+ 无 capacity 时渲染 0% 占位环常驻
  assert.match(source, /size-7 flex-none place-items-center rounded-full/);
  assert.match(source, /const percent = context\?\.percent \?\? 0;/);
  assert.match(source, /t\("sessionContext\.unavailable"\)/);
  // 打开期间挂 document 监听（外点/Escape 关闭）
  assert.match(source, /addEventListener\("pointerdown", onPointerDown\)/);
  assert.match(source, /addEventListener\("keydown", onKeyDown\)/);
});

test("contextSegments prefers host breakdown and falls back to estimate split", () => {
  const { contextSegments } = loadMeterHelpers();
  const seg = (state) => {
    const result = contextSegments(state);
    if (result === null) return null;
    return result.kind === "breakdown"
      ? `breakdown:${result.system}:${result.tools}:${result.conversation}`
      : `estimate:${result.conversation}:${result.systemTools}`;
  };
  // host contextBreakdown 投影（dsh）：系统/工具/对话三段直接可用，0 也是有效值
  assert.equal(
    seg({ contextSystemTokens: 2400, contextToolsTokens: 1800, contextMessageTokens: 57600 }),
    "breakdown:2400:1800:57600",
  );
  assert.equal(seg({ contextSystemTokens: 0, contextToolsTokens: 0, contextMessageTokens: 0 }), "breakdown:0:0:0");
  // 无投影（pi）：对话 = 消息估算 token，系统+工具 = 反推余量
  assert.equal(seg({ contextTokens: 128000, contextMessageTokens: 57600 }), "estimate:57600:70400");
  // 估算超过总量时对话封顶，系统+工具为 0（不出现负数）
  assert.equal(seg({ contextTokens: 1000, contextMessageTokens: 5000 }), "estimate:1000:0");
  // 缺任一字段 = 无估算（渲染单段条）
  assert.equal(seg(undefined), null);
  assert.equal(seg({ contextTokens: 128000 }), null);
  assert.equal(seg({ contextMessageTokens: 100 }), null);
  assert.equal(seg({ contextTokens: 0, contextMessageTokens: 100 }), null);
});

test("meter panel shows the localized reading and ~used/window figures", () => {
  const source = meterSource();
  // 面板 320px：style.width 与定位回退共用 PANEL_WIDTH，避免首帧 offsetWidth=0 时按旧 264 错位
  assert.match(source, /const PANEL_WIDTH = 320/);
  assert.match(source, /width: PANEL_WIDTH/);
  assert.match(source, /panel\.offsetWidth \|\| PANEL_WIDTH/);
  assert.doesNotMatch(source, /w-\[264px\]/);
  assert.match(source, /t\("sessionContext\.used", \{ percent: formatPercent\(percent\) \}\)/);
  assert.match(source, /formatTokens\(context\.usedTokens!\)\} \/ \$\{formatTokens\(context\.contextWindow!\)\}/);
  // 面板占用条：4px 圆角条，宽度按 percent
  assert.match(source, /h-1 overflow-hidden rounded-full bg-muted/);
  assert.match(source, /width: `\$\{percent\}%`/);
  assert.match(source, /data-testid="session-context-meter"/);
});

test("panel adds dsh-style segments legend when message estimate exists", () => {
  const source = meterSource();
  // 三段（host breakdown）与两段（估算）图例共用色：对话蓝、工具紫、系统蓝灰
  assert.match(source, /COLOR_CONVERSATION = "var\(--color-context-conversation, #2563eb\)"/);
  assert.match(source, /COLOR_SYSTEM_TOOLS = "var\(--color-context-system-tools, rgb\(167, 139, 250\)\)"/);
  assert.match(source, /COLOR_TOOLS = "var\(--color-context-tools, rgb\(167, 139, 250\)\)"/);
  assert.match(source, /COLOR_SYSTEM = "var\(--color-context-system, #94a3b8\)"/);
  // host breakdown 三段条：宽度 = percent × 份额 / breakdownTotal（dsh-web 同宽算法）
  assert.match(source, /breakdownSegments/);
  assert.match(source, /percent \* part\.tokens\) \/ breakdownTotal/);
  // 估算两段条：宽度按占 contextWindow 比例（与单段总占用条同一容器；
  // context 可能为 null（占位环）时 ?? 1 兜底，避免除零）
  assert.match(source, /segments\.conversation \/ \(context\?\.contextWindow \?\? 1\)/);
  assert.match(source, /segments\.systemTools \/ \(context\?\.contextWindow \?\? 1\)/);
  // 图例行：swatch + 文案 + 右侧 ~tokens（dsh rows 形态）
  assert.match(source, /t\("sessionContext\.conversation"\)/);
  assert.match(source, /t\("sessionContext\.systemTools"\)/);
  assert.match(source, /t\("sessionContext\.system"\)/);
  assert.match(source, /t\("sessionContext\.tools"\)/);
  assert.match(source, /size-2 flex-none rounded-\[2px\]/);
  assert.match(source, /~\{formatTokens\(segments\.conversation\)\}/);
  assert.match(source, /~\{formatTokens\(segments\.system\)\}/);
});

test("input/output token row drops arrows and keeps values on one line", () => {
  const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
  const meter = meterSource();
  // 标签已是「输入/输出 tokens」，数值不再套 ↑/↓（箭头加长字符串，且 `/ ↓` 会在窄面板折行）
  assert.match(
    surface,
    /label: t\("ctx\.detail\.tokens"\),\s*value: `\$\{formatCompact\(state\.inputTokens\)\} \/ \$\{formatCompact\(state\.outputTokens\)\}`,/,
  );
  assert.doesNotMatch(surface, /↑ \$\{formatCompact\(state\.inputTokens\)\} \/ ↓/);
  // 详情数值禁止折行：tooltip 与上下文面板共用同一 builder 文案，窄宽下必须 nowrap
  assert.match(
    surface,
    /min-w-0 whitespace-nowrap text-right font-mono font-semibold tabular-nums text-popover-foreground/,
  );
  assert.match(
    meter,
    /min-w-0 whitespace-nowrap text-right font-mono font-semibold tabular-nums text-foreground/,
  );
});

test("panel reuses the SessionStatus detail builder and keeps compact action", () => {
  const source = meterSource();
  // 详情复用会话头部 SessionStatus 的构建器：两处明细语义一致（首字/耗时/tps 等）
  assert.match(source, /import \{ buildSessionStatusDetail \} from "\.\/SurfaceComponents"/);
  assert.match(source, /const detail = buildSessionStatusDetail\(\s*props\.state,/);
  assert.match(source, /props\.state\?\.cacheHitAveragePercent \?\? undefined,/);
  // 明细行与「最近一次回复」性能组分开渲染（不混读为会话均值）；
  // 输入/输出 token 与最新缓存命中率已常驻输入框下方（ComposerStatsLine），
  // 圆环面板消费前过滤这两行，避免重复展示
  assert.match(source, /panelDetailRows\.map\(/);
  assert.match(source, /row\.label !== t\("ctx\.detail\.tokens"\) && row\.label !== t\("ctx\.detail\.hitLatest"\)/);
  assert.match(source, /detail\.replyPerfRows\.map\(/);
  assert.match(source, /t\("ctx\.detail\.lastReply"\)/);
  // DSH 会话统计组（host sessionStats 投影；回合/墙钟/平均首字/生成速度）
  assert.match(source, /detail\.sessionStatRows\.map\(/);
  assert.match(source, /t\("ctx\.detail\.sessionStats"\)/);
  assert.match(source, /row\.emphasis \? " mt-1 border-t border-border\/70 pt-1\.5" : ""/);
  // 旧的自实现三行（命中率/输入输出/费用）已删除，避免与 builder 重复
  assert.doesNotMatch(source, /sessionContext\.cacheHit/);
  assert.doesNotMatch(source, /sessionContext\.inputOutput/);
  assert.doesNotMatch(source, /sessionContext\.cost/);
  // 压缩按钮：从右上角紧凑徽章迁入面板底部；门槛/紧急色走 compactUiState
  assert.match(source, /t\("sessionContext\.compact"\)/);
  assert.match(source, /t\("sessionContext\.compacting"\)/);
  assert.match(source, /t\("sessionContext\.compactNotReady"\)/);
  assert.match(source, /compactUi\.urgency === "danger" \? "text-destructive/);
  assert.match(source, /compactUi\.urgency === "warn" \? "text-amber-500/);
  assert.match(source, /disabled=\{compactDisabled\}/);
  assert.match(source, /onClick=\{props\.onCompact\}/);
  assert.match(source, /showCompact = props\.onCompact !== undefined/);
  assert.match(source, /data-testid="session-context-compact"/);
});

test("panel re-anchors on scroll instead of closing during streaming", () => {
  const source = meterSource();
  // 定位逻辑抽成 positionPanel 供 layout effect 与滚动/resize 复用
  assert.match(source, /const positionPanel = useCallback\(\(\) => \{\s*const trigger = triggerRef\.current;/);
  // 滚动监听回调不再是「关闭面板」（旧行为：任何滚动/缩放都 setOpen(false)，
  // 流式渲染追底滚动会反复点开即关）
  assert.doesNotMatch(source, /const onViewportChange = \(\): void => setOpen\(false\);/);
  assert.doesNotMatch(source, /addEventListener\("scroll", onViewportChange, true\)/);
  // 改为重新锚定：capture 滚动 + rAF 合并 + 位置未变不重复 setState
  // （流式追底滚动每帧触发 scroll，trigger 固定时避免每帧 re-render）
  assert.match(source, /addEventListener\("scroll", reanchor, true\)/);
  assert.match(source, /requestAnimationFrame\(positionPanel\)/);
  assert.match(source, /setPlacement\(\(prev\) =>\s*prev !== null && prev\.left === left && prev\.top === top \? prev : \{ left, top \},\s*\);/);
  // 外点 / Escape 仍是唯一关闭途径（监听保持）
  assert.match(source, /addEventListener\("pointerdown", onPointerDown\)/);
  assert.match(source, /addEventListener\("keydown", onKeyDown\)/);
});

test("bottom bar wires the meter next to send controls and merges model + thinking into one chip", () => {
  const source = bottomBarSource();
  // ContextMeter 挂在右侧组（git 分支之前、发送控件同组）
  assert.match(source, /import \{ SessionContextMeter \} from "\.\/SessionContextMeter"/);
  assert.match(source, /<SessionContextMeter\s*state=\{props\.state\}\s*onCompact=\{props\.onCompact\}\s*backend=\{usageBackend\}\s*\/\/ [^\n]+\n\s*fallbackProvider=\{modelProvider\}/);
  assert.match(source, /composer-bottom-right ml-auto flex shrink-0 items-center gap-2/);
  // 模型/思考合并 chip：模型名 · 思考档位 + chevron（dsh ModelSelect trigger 形态）
  assert.match(source, /composer-bar-btn model-thinking/);
  assert.match(source, /\{modelValue\}<\/span>\s*<span className="flex-none text-muted-foreground\/70" aria-hidden="true">·<\/span>/);
  assert.match(source, /<ChevronDown\s*size=\{12\}/);
  assert.match(source, /rotate-180/);
  // root 菜单两行 drill-in：模型/思考 + 当前值 + 右 chevron，点击复用既有 Dialog
  assert.match(source, /t\("app\.model"\)/);
  assert.match(source, /t\("app\.think"\)/);
  assert.match(source, /<ChevronRight size=\{14\}/);
  assert.match(source, /drillIn\(props\.onPickModel\)/);
  assert.match(source, /drillIn\(props\.onPickThinking\)/);
  // 旧的分离按钮（绿色思考、斜体模型）不再存在
  assert.doesNotMatch(source, /composer-bar-btn model flex h-7/);
  assert.doesNotMatch(source, /composer-bar-btn thinking h-7 max-w-\[10rem\]/);
});

test("context meter copy is present in both locale dictionaries", () => {
  assert.match(zh(), /"sessionContext\.used": "上下文已用 \{percent\}%"/);
  assert.match(en(), /"sessionContext\.used": "\{percent\}% of context used"/);
  for (const locale of [zh(), en()]) {
    assert.match(locale, /"sessionContext\.figures": "~\{used\} \/ \{window\}"/);
    assert.match(locale, /"sessionContext\.conversation":/);
    assert.match(locale, /"sessionContext\.systemTools":/);
    // host breakdown 三段图例文案（系统/工具/对话）
    assert.match(locale, /"sessionContext\.system":/);
    assert.match(locale, /"sessionContext\.tools":/);
    // 会话统计组文案（DSH sessionStats 投影）
    assert.match(locale, /"ctx\.detail\.sessionStats":/);
    assert.match(locale, /"ctx\.detail\.turnsSteps":/);
    assert.match(locale, /"ctx\.detail\.llmDuration":/);
    assert.match(locale, /"ctx\.detail\.toolDuration":/);
    assert.match(locale, /"ctx\.detail\.ttftAverage":/);
    // 命中/输入输出/费用行已并入共享明细构建器（ctx.detail.*），面板不再单独占用文案 key
    assert.doesNotMatch(locale, /"sessionContext\.cacheHit":/);
    assert.doesNotMatch(locale, /"sessionContext\.cacheHitAvg":/);
    assert.doesNotMatch(locale, /"sessionContext\.inputOutput":/);
    assert.doesNotMatch(locale, /"sessionContext\.cost":/);
    assert.match(locale, /"sessionContext\.compact":/);
    assert.match(locale, /"sessionContext\.compacting":/);
    assert.match(locale, /"sessionContext\.compactNotReady":/);
    assert.match(locale, /"sessionContext\.compactNotReadyHint":/);
  }
});

test("usage block is delegated to the shared ProviderUsageDetails with settings deep-link on failure", () => {
  const source = meterSource();
  // 圆球面板用量区块 = 共享 ProviderUsageDetails（与模型卡片/选择器徽标同一份数据源与视觉，
  // 本组件只决定「是否渲染」与「失败跳转」，不再自持 fetch/缓存/展示逻辑）
  assert.match(source, /import \{ ProviderUsageDetails \} from "\.\.\/app\/ProviderUsageDetails"/);
  assert.match(source, /<ProviderUsageDetails provider=\{provider\} backend=\{props\.backend\} onConfigureUsage=\{onConfigureUsage\} \/>/);
  // 失败态入口 = 跳「设置 → 配置管理 → 模型」并定位该供应商（openSettingsAtom 深链）
  assert.match(source, /openSettingsAtom/);
  assert.match(source, /configTab: "models", provider \}/);
  // 旧的「装 skill + 预填输入框」链路已整体删除（配置唯一入口在模型页）
  assert.doesNotMatch(source, /onInsertUsageProbePrompt/);
  assert.doesNotMatch(source, /installUsageSkill/);
  assert.doesNotMatch(source, /usageCache/);
});

test("picker rows and provider cards use the cc-switch style inline usage", () => {
  const picker = bottomBarSource();
  // 选择器分组行：trailing 插槽挂 inline（不往 label 里塞元素），打开时批量 TTL 去重查询；
  // backend 随会话后端透传（DSH 会话的分组行走 dsh 链路，不误查 pi 的 usage-probes.json）。
  assert.match(picker, /trailing=\{<ProviderUsageInline provider=\{provider\} variant="row" backend=\{props\.backend\} \/>\}/);
  assert.match(picker, /useProviderUsageBatchRefresh/);
  // command-picker 提供 trailing 插槽（渲染在 label 与 count 之间）
  const commandPicker = readFileSync("src/renderer/src/components/ui-shadcn/command-picker.tsx", "utf8");
  assert.match(commandPicker, /trailing\?: ReactNode/);
  // Pi 模型页：折叠卡片不再另开 h-9 底栏——模型数徽章 + 用量（时间+数值+刷新）都收进标题行。
  const modelsTab = readFileSync("src/renderer/src/config/ModelsTab.tsx", "utf8");
  assert.match(modelsTab, /ProviderUsageInline\s+provider=\{name\}\s+variant="card"/);
  assert.match(modelsTab, /config\.count\.models/);
  assert.doesNotMatch(modelsTab, /ProviderUsageRow/);
  assert.doesNotMatch(modelsTab, /leading=/);
  // 模型页/认证页/DSH 三处用量均已收进卡头 inline（variant=card），底部行组件已全部删除。
  const inlineSource = readFileSync("src/renderer/src/components/app/ProviderUsageInline.tsx", "utf8");
  assert.match(inlineSource, /variant: "row" \| "card"/);
  assert.doesNotMatch(inlineSource, /export function ProviderUsageFooter/);
  assert.doesNotMatch(inlineSource, /export function ProviderUsageRow/);
  assert.doesNotMatch(inlineSource, /provider-usage-configure-icon/);
  // 「用量查询」按钮收敛到共享组件 UsageQueryEntryButton（内置支持的供应商零配置自动生效，不渲染）
  const entryButton = readFileSync("src/renderer/src/components/app/UsageQueryEntryButton.tsx", "utf8");
  assert.match(entryButton, /useProviderUsageRecognized/);
  assert.match(entryButton, /provider-usage-configure-icon/);
  // 认证页：用量/余额也收进标题行（与模型页同布局，刷新点击不误触折叠），不再单独占 h-9 底栏。
  const authTab = readFileSync("src/renderer/src/config/AuthTab.tsx", "utf8");
  assert.match(authTab, /<ProviderUsageInline provider=\{name\} variant="card" \/>/);
  assert.doesNotMatch(authTab, /ProviderUsageRow/);
  assert.match(authTab, /UsageQueryEntryButton/);
  // DSH 页：模型数徽章（badges）+ 用量/余额都收进卡片标题行，不再单独 h-9 底栏（动态目录 + 官方 DeepSeek 两处）。
  const dshCards = readFileSync("src/renderer/src/config/DshProviderCards.tsx", "utf8");
  assert.match(dshCards, /<ProviderUsageInline provider=\{entry\.key\} backend="dsh" variant="card" \/>/);
  assert.match(dshCards, /<ProviderUsageInline provider="deepseek" backend="dsh" variant="card" \/>/);
  assert.match(dshCards, /config\.dsh\.modelsCount/);
  assert.doesNotMatch(dshCards, /ProviderUsageRow/);
  assert.match(dshCards, /UsageQueryEntryButton/);
  const modelsTab2 = readFileSync("src/renderer/src/config/ModelsTab.tsx", "utf8");
  assert.match(modelsTab2, /UsageQueryEntryButton/);
  // 旧胶囊徽标组件已删除（cc-switch 风格无胶囊）
  assert.equal(existsSync("src/renderer/src/components/app/ProviderUsageBadge.tsx"), false);
});

test("provider usage inline stays silent when usage is not enabled", () => {
  const source = readFileSync("src/renderer/src/components/app/ProviderUsageInline.tsx", "utf8");
  // 未开启/失败/不支持 → 不渲染任何文案（查不到就不显示），底部行组件已删除、无空占位。
  assert.doesNotMatch(source, /provider-usage-not-enabled/);
  assert.doesNotMatch(source, /provider-usage-footer-configure/);
  assert.doesNotMatch(source, /空占位/);
});

test("recognized usage badge keeps its label separated from the hint", () => {
  const source = readFileSync("src/renderer/src/config/UsageProbeConfigDialog.tsx", "utf8");
  const badgeSection = source.match(/\{hintKey && \([\s\S]*?\n\s*\)\}/)?.[0] ?? "";
  // 徽标文字按单行盒渲染，并与下一行说明保持明确间距，避免高字号/主题切换时叠字。
  assert.match(badgeSection, /flex flex-col gap-2/);
  assert.match(badgeSection, /text-micro leading-none tracking-wide/);
});

test("provider usage inline keeps no bottom row footprint", () => {
  const source = readFileSync("src/renderer/src/components/app/ProviderUsageInline.tsx", "utf8");
  // 底部行组件（ProviderUsageRow）已随三处页面迁移删除：无 justify-end/h-9 底栏残留。
  assert.doesNotMatch(source, /export function ProviderUsageRow/);
  assert.doesNotMatch(source, /justify-end/);
  assert.doesNotMatch(source, /h-9/);
});

test("usage probe dialog separates title from enable row", () => {
  const source = readFileSync("src/renderer/src/config/UsageProbeConfigDialog.tsx", "utf8");
  // 标题与启用开关是两个视觉层级，标题下必须保留稳定的呼吸间距。
  assert.match(source, /<DialogHeader className="px-5 pt-4 pb-2">/);
});

test("usage probe dialog lives outside all TabsContent (tab switch must not unmount it)", () => {
  // 回归契约：弹窗曾放在 config:models TabsContent 内，Radix Tabs 默认卸载非激活内容，
  // 导致切到认证 tab / DSH 页时弹窗被卸载、点击柱状图按钮「没反应」。
  const configModal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
  assert.match(
    configModal,
    /<\/TabsContent>\s*<\/Tabs>\s*\{\/\* 用量查询配置弹窗[\s\S]*?<UsageProbeConfigDialog/,
    "用量查询弹窗必须挂在最外层 Tabs（Pi/DSH 分页）之外",
  );
});

test("ProviderUsageDetails renders each usage window as a labeled progress row", () => {
  const source = readFileSync("src/renderer/src/components/app/ProviderUsageDetails.tsx", "utf8");
  // 多窗口分支优先命中（windows.length > 0 在普通 credits 分支之前）
  assert.match(source, /windows\.length > 0 \? \(/);
  // 每个窗口一行：label（5h/周）+ 进度条 + 百分比 + 剩余小字
  // 窗口 label 走 providerUsageDisplay.usageWindowLabelText 统一映射
  // （与 inline 多段行同源；内置 key 统一 i18n，未知 key 原样展示）
  assert.match(source, /usageWindowLabelText\(window\.key, t\)/);
  assert.match(source, /t\("sessionContext\.usageWindowRemaining", \{ n: formatAmount\(remaining\) \}\)/);
  // 用超封顶 100、≥90% 红字警示（与 periods 同判断）
  assert.match(source, /Math\.min\(100, Math\.round\(\(used \/ total\) \* 100\)\)/);
  assert.match(source, /pct != null && pct >= 90/);
});

test("usage windows copy is present in both locale dictionaries", () => {
  for (const locale of [zh(), en()]) {
    assert.match(locale, /"sessionContext\.usageWindowFiveHour":/);
    assert.match(locale, /"sessionContext\.usageWindowWeekly":/);
    assert.match(locale, /"sessionContext\.usageWindowRemaining":/);
  }
  assert.match(zh(), /"sessionContext\.usageWindowFiveHour": "5小时"/);
  assert.match(en(), /"sessionContext\.usageWindowFiveHour": "5h"/);
});

// 圆环常驻：无 capacity 数据（会话未运行/模型切换瞬间）也渲染 0% 占位环，
// 面板内容降级为「暂不可用」，不再整环隐藏（用户要求非激活会话也要常驻）。
test("meter stays visible without capacity: placeholder ring + unavailable panel", () => {
  const source = meterSource();
  // percent 兜底 0：环照画（strokeDasharray 按 percent 计算），不 return null
  assert.match(source, /const percent = context\?\.percent \?\? 0;/);
  assert.doesNotMatch(source, /if \(context === null\) return null/);
  // 面板标题走 reading（占位时显示 unavailable 文案），figures 仅在可用时渲染
  assert.match(source, /<span className="text-text-tertiary">\{reading\}<\/span>/);
  assert.match(source, /\{available && figures !== undefined && \(/);
  // 不再因 capacity 消失自动关闭面板
  assert.doesNotMatch(source, /if \(!available && open\) setOpen\(false\)/);
  // 面板定位/外点/滚动监听不再受可用性限制
  assert.doesNotMatch(source, /if \(!open \|\| !available\) return;/);
  // 占用条/图例在无可用时隐藏；压缩按钮因 percent=0 自动禁用（compactUiState not ready）
  assert.match(source, /\{available && segments !== null && \(/);
  assert.match(source, /t\("sessionContext\.unavailable"\)/);
});

test("placeholder copy is present in both locale dictionaries", () => {
  assert.match(zh(), /"sessionContext\.unavailable": "上下文数据暂不可用"/);
  assert.match(en(), /"sessionContext\.unavailable": "Context data unavailable"/);
});

test("usage provider falls back to session/default model so idle sessions can still probe usage", () => {
  const meterSource = readFileSync(meterPath, "utf8");
  // 非激活会话没有 runtime state，组件用会话记录/默认 model 推导的 provider 兜底查用量
  assert.match(meterSource, /fallbackProvider\?: string/);
  assert.match(
    meterSource,
    /const provider = props\.state\?\.provider\?\.trim\(\) \|\| props\.fallbackProvider\?\.trim\(\) \|\| undefined;/
  );
  // 用量查询不依赖 agent 运行（注释里明示设计意图）
  assert.match(meterSource, /用量查询不依赖 agent 运行/);
});
