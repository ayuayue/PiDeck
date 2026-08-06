import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerArea = readFileSync(
  "src/renderer/src/components/session/ComposerArea.tsx",
  "utf8",
);
const sessionView = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const rendererUtils = readFileSync(
  "src/renderer/src/rendererUtils.ts",
  "utf8",
);

/**
 * 输入区自适应增高契约：Todo/记忆 widget、图片附件等可变内容渲染在输入区上方，
 * 若 footer 高度固定不变，会挤压 composer-box 导致输入区被压缩、显示不清晰。
 * 这些断言锁定修复路径：
 * 1. ComposerArea 在 useLayoutEffect 中同步测量可变内容额外高度（绘制前完成，
 *    避免内容出现时先压缩再回弹的跳动），图片附件栏紧贴输入框；
 * 2. SessionView 通过 panelRef 命令式 resize：内容需要更高时自动增高、
 *    内容减少时（如图片清空但 widgets 仍在）自动回缩到所需高度；
 * 3. 既有 minSize / composer-box 保底约束不放松。
 */
test("composer measures variable content above the input and reports the extra height", () => {
  // 可变内容（widgets / 队列 / 投递通知）与图片附件栏分层测量
  assert.match(composerArea, /widgetsRef/);
  assert.match(composerArea, /attachmentBarRef/);
  // useLayoutEffect 同步测量：layout effect 中的 setState 在浏览器绘制前 flush，
  // panel.resize 与内容渲染同帧生效，输入区不会被压缩一帧（避免闪烁）
  assert.match(composerArea, /useLayoutEffect\(\(\) => \{\n\s*if \(!mountedRef\.current\) return;/);
  assert.match(composerArea, /const extra = measureExtra\(\);[\s\S]*onHeightChangeRef\.current\(extra\)/);
  // 挂载首帧跳过；mounted 只能在 rAF 内置 true，避免 StrictMode 重放
  // layout effect 时面板仍未注册（Group not found）
  assert.match(
    composerArea,
    /requestAnimationFrame\(\(\) => \{[\s\S]*mountedRef\.current = true;[\s\S]*reportExtra\(\);/,
  );
  // 非受控模式本地增长
  assert.match(composerArea, /extra \+ COMPOSER_DEFAULT_HEIGHT/);
});

test("extras height sync lives in a child that rerenders when variable content changes", () => {
  // ComposerRuntimeIntegrations owns variable-content state. Closing/updating extras rerenders
  // its render-prop subtree, not the outer ComposerArea, so the layout effect must live in a
  // child receiving the extras as props; otherwise the panel only shrinks after the user types
  // and rerenders ComposerArea for an unrelated reason.
  // 注：扩展 widget（Todo/Plan）已迁至 chat-header SessionWidgetChips，composer 内 widgets
  // 槽位固定传 null，测量的可变内容为附件栏/队列/投递通知。
  assert.match(
    composerArea,
    /function ComposerMeasuredExtras[\s\S]*useLayoutEffect/,
  );
  assert.match(
    composerArea,
    /<ComposerMeasuredExtras[\s\S]*widgets=\{null\}/,
  );
  assert.match(composerArea, /<ComposerMeasuredExtras[\s\S]*deliveryNotice=\{/);
  assert.match(composerArea, /<ComposerMeasuredExtras[\s\S]*queuePanel=\{props\.queuePanel\}/);
  const widgetChips = readFileSync(
    "src/renderer/src/components/session/SessionWidgetChips.tsx",
    "utf8",
  );
  assert.match(widgetChips, /isCoherentComposerRuntimeUi/);
});

test("content containers are shrink-proof so panel resizes cannot feedback-loop", () => {
  // widgets 容器与图片栏 shrink-0：面板增高/回缩时容器自身高度不变，
  // 避免「面板调整→容器被压缩→extra 变化→再调整」的同步更新循环
  assert.match(composerArea, /shrink-0/);
  const widgetsSlot = composerArea.indexOf("ref={widgetsRef}");
  const attachmentSlot = composerArea.indexOf("ref={attachmentBarRef}");
  assert.ok(widgetsSlot !== -1 && widgetsSlot < attachmentSlot);
});

test("image attachment bar stays glued to the input box", () => {
  // 测量组件内部顺序固定为 widgets → 图片栏；调用点紧邻 composer-box 之前
  const measuredComponent = composerArea.indexOf("function ComposerMeasuredExtras");
  const widgetsSlot = composerArea.indexOf("ref={widgetsRef}", measuredComponent);
  const attachmentSlot = composerArea.indexOf("ref={attachmentBarRef}", measuredComponent);
  const measuredCall = composerArea.indexOf("<ComposerMeasuredExtras");
  const composerBoxSlot = composerArea.indexOf('className={["composer-box');
  assert.ok(widgetsSlot !== -1 && widgetsSlot < attachmentSlot);
  assert.ok(
    measuredCall !== -1 &&
      measuredCall < composerBoxSlot,
  );
  // 图片栏仅在存在图片时传入：空 div 占位会多出一个 gap，
  // 导致有图/无图时输入区高度不一致
  assert.match(composerArea, /composer\.attachments\.length > 0 \? \(/);
  // gap 实测：Tailwind gap-2 是 rem，随根字号变化，用 rowGap 拿真实 px
  assert.match(composerArea, /getComputedStyle\(footerEl\)\.rowGap/);
  assert.match(composerArea, /imageBarH > 0 \? gapPx : 0/);
});

test("session view grows and shrinks the composer panel with variable content", () => {
  // composer 面板持有命令式 handle，用于程序化 resize
  assert.match(sessionView, /composerPanelRef/);
  assert.match(sessionView, /panelRef=\{composerPanelRef\}/);
  assert.match(sessionView, /onContentHeightChange=\{handleComposerContentHeight\}/);
  // 目标高度 = max(用户手动高度, 默认输入区 + 额外内容)，受 maxSize 约束
  assert.match(sessionView, /Math\.max\(userPreferred, COMPOSER_DEFAULT_HEIGHT \+ extraHeight\)/);
  // 程序化 resize 优先走 Group.setLayout：composer 增高只从 timeline 拿空间，
  // 不再压到 terminal（库默认 panel.resize 会从相邻面板拿空间）；增高预算受
  // timeline 保底线限制。group 未就绪时才回退旧 resize 路径。
  assert.match(sessionView, /group\.setLayout\(next\)/);
  assert.match(sessionView, /growComposerWithinTimelineBudget/);
  assert.match(sessionView, /composerPanelRef\.current\?\.resize\(target\)/);
  // 内容减少时自动回缩：仅当当前高度由内容驱动（未超过内容所需）时回缩，
  // 用户手动拖高的高度不被内容变化回缩
  assert.match(sessionView, /target > current/);
  assert.match(sessionView, /current <= contentDrivenHeightRef\.current/);
  assert.match(sessionView, /contentDrivenHeightRef\.current = Math\.min/);
  // 区分程序 resize 与用户拖拽：时间窗口或内容驱动高度匹配都视为程序化，
  // 避免 maxSize clamp/像素取整/回调延迟导致误判为用户操作
  assert.match(sessionView, /programmaticResizeTargetRef/);
  assert.match(sessionView, /programResizeExpireRef\.current = Date\.now\(\) \+ 200/);
  assert.match(sessionView, /Math\.abs\(px - contentDrivenHeightRef\.current\) <= 2/);
  assert.match(sessionView, /applyComposerHeight\(px, true\)/);
  // 面板未注册到 group 时 setLayout/resize 抛错：try/catch 静默跳过，避免渲染崩溃
  assert.match(sessionView, /try \{[\s\S]*group\.setLayout\(next\)/);
  assert.match(sessionView, /Group not found/);
});

test("auto growth does not relax the existing minimum-size constraints", () => {
  assert.match(rendererUtils, /COMPOSER_DEFAULT_HEIGHT = 160/);
  assert.match(rendererUtils, /COMPOSER_MIN_HEIGHT = 148/);
  // composer 面板的 minSize 仍是 COMPOSER_MIN_HEIGHT，composer-box 仍有 112px 保底
  assert.match(sessionView, /minSize=\{COMPOSER_MIN_HEIGHT\}/);
  assert.match(composerArea, /min-h-0[^\"]*flex-1/);
});
