import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./mock-pi-fixture";

const SOURCE_TURNS = [
  "scroll-anchor-source-one",
  "scroll-anchor-source-two",
  "scroll-anchor-source-three",
  "scroll-anchor-source-four",
  "scroll-anchor-source-five",
  "scroll-anchor-source-six",
  "scroll-anchor-source-seven",
];
// 早期轮：只有主动扩窗后才会出现在 DOM。共 7 轮而扩窗后只挂 6 轮，
// 使「恢复期全量、complete 后收缩」必然改变锚点上方高度，永久覆盖该回归。
const ANCHOR_TEXT = SOURCE_TURNS[2];
// 轮次尾部：始终处于基础 3 轮窗口，用于验证同一任务的滚动 + 切换不会保存错误窗口。
const TAIL_WINDOW_ANCHOR_TEXT = SOURCE_TURNS[6];
// 保留原有滚轮回归的 5 轮工作集；选择其尾部用户轮，避免该用例偶发耦合扩窗节流。
const WHEEL_ANCHOR_TEXT = SOURCE_TURNS[4];

async function openChatSession(window: Page) {
  const newSession = window.getByRole("button", { name: "新建会话", exact: true }).first();
  await expect(newSession).toBeVisible({ timeout: 15_000 });
  await newSession.click();
  const composer = window.locator(".composer .rich-input");
  await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
  return composer;
}

async function approveProjectTrustIfRequested(window: Page) {
  const trust = window.getByRole("button", { name: "本次信任", exact: true });
  if (await trust.isVisible().catch(() => false)) {
    await trust.click();
  }
}

async function sendTurn(window: Page, prompt: string) {
  const composer = window.locator(".composer .rich-input");
  await composer.fill(prompt);
  await expect(composer).toContainText(prompt);
  // Draft activation can surface the project trust gate after the composer is
  // already interactive. Resolve it before targeting the underlying send button.
  await window.waitForTimeout(250);
  await approveProjectTrustIfRequested(window);
  const sendButton = window.getByRole("button", { name: "发送", exact: true });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(window.locator(".message-timeline"))
    .toContainText(`Mock 回复：「${prompt}」流式渲染验证完成`, { timeout: 20_000 });
}

async function startSlowStreamingTurn(window: Page, prompt: string, responseText = `Mock 回复：「${prompt}」`) {
  const composer = window.locator(".composer .rich-input");
  await composer.fill(prompt);
  await expect(composer).toContainText(prompt);
  const sendButton = window.getByRole("button", { name: "发送", exact: true });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(window.locator(".message-timeline"))
    .toContainText(responseText, { timeout: 10_000 });
}

async function returnToLiveEdge(window: Page) {
  const moveToLatest = window.getByRole("button", { name: "移动到最新", exact: true });
  if (await moveToLatest.isVisible().catch(() => false)) {
    await moveToLatest.click();
    await window.waitForTimeout(300);
  }
}

/** 展开一批已加载轮次，让较早锚点进入当前 DOM 窗口。 */
async function expandTurnWindow(window: Page) {
  const loadMore = window.getByRole("button", { name: "加载更多对话", exact: true });
  await expect(loadMore).toBeVisible({ timeout: 10_000 });
  // 常规 click 会先把顶部按钮滚入视口，进而触发 near-top 自动扩窗并使按钮
  // 在 click 前卸载。直接触发其已验证的用户点击 handler，避免测试自身改变窗口状态。
  await loadMore.dispatchEvent("click");
}

async function constrainTimelineViewport(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    window.setBounds({ width: 1000, height: 560 });
  });
}

async function scrollThenOpenNewSession(
  window: Page,
  anchorText: string,
  desiredOffset: number,
): Promise<number> {
  return window.evaluate(({ targetText, requestedOffset }) => {
    const timeline = document.querySelector<HTMLElement>(".message-timeline");
    const anchor = Array.from(document.querySelectorAll<HTMLElement>("article.user-turn"))
      .find((element) => element.textContent?.includes(targetText));
    // 明确使用侧栏控制，而不是依赖侧栏与 Tab 栏两个同名按钮的 DOM 顺序。
    const sidebar = document.querySelector<HTMLElement>('[aria-label="搜索"]');
    const newSession = sidebar?.querySelector<HTMLElement>('button[aria-label="新建会话"]');
    if (!timeline || !anchor || !newSession) throw new Error("immediate switch target is not mounted");
    const currentOffset = anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
    timeline.scrollTop += currentOffset - requestedOffset;
    const placedOffset = anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
    timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
    // Click in the same task: React commits the target session before the
    // rAF-based scroll sampler gets another opportunity to run.
    newSession.click();
    return placedOffset;
  }, { targetText: anchorText, requestedOffset: desiredOffset });
}

async function readAnchorOffset(window: Page, anchorText = ANCHOR_TEXT): Promise<number> {
  return window.evaluate((targetText) => {
    const timeline = document.querySelector<HTMLElement>(".message-timeline");
    const anchor = Array.from(document.querySelectorAll<HTMLElement>("article.user-turn"))
      .find((element) => element.textContent?.includes(targetText));
    if (!timeline || !anchor) throw new Error("scroll anchor is not mounted");
    return anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
  }, anchorText);
}

/** 等待 rAF 恢复真实落位，再由调用方断言后续窗口/流式变化不会二次漂移。 */
async function waitForAnchorRestore(
  window: Page,
  anchorText: string,
  expectedOffset: number,
) {
  await expect.poll(
    async () => Math.abs((await readAnchorOffset(window, anchorText)) - expectedOffset),
    { timeout: 5_000, intervals: [100, 250, 500] },
  ).toBeLessThanOrEqual(28);
}

async function placeAnchorInViewport(
  window: Page,
  desiredOffset: number,
  anchorText = ANCHOR_TEXT,
): Promise<number> {
  await window.evaluate(({ targetText, desiredOffset: requestedOffset }) => {
    const timeline = document.querySelector<HTMLElement>(".message-timeline");
    const anchor = Array.from(document.querySelectorAll<HTMLElement>("article.user-turn"))
      .find((element) => element.textContent?.includes(targetText));
    if (!timeline || !anchor) throw new Error("scroll anchor is not mounted");
    const currentOffset = anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
    timeline.scrollTop += currentOffset - requestedOffset;
    timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, { targetText: anchorText, desiredOffset });
  await window.waitForTimeout(350);
  return readAnchorOffset(window, anchorText);
}

test("session switch restores a historical viewport after turn-window expansion", async ({ app, window }) => {
  test.setTimeout(180_000);
  await constrainTimelineViewport(app);
  await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

  const sourceComposer = await openChatSession(window);
  await expect(sourceComposer).toHaveAttribute("contenteditable", "true");
  for (const prompt of SOURCE_TURNS) {
    await sendTurn(window, prompt);
  }

  const timeline = window.locator(".message-timeline");
  // 数据首开可达 9 轮，但 DOM 基础窗口仍为尾部 3 轮；先走真实的本地扩窗入口。
  await expandTurnWindow(window);
  const anchorRow = timeline.locator("article.user-turn", { hasText: ANCHOR_TEXT }).first();
  await expect(anchorRow).toBeVisible({ timeout: 10_000 });

  const beforeOffset = await placeAnchorInViewport(window, 96);
  expect(beforeOffset).toBeGreaterThanOrEqual(40);
  expect(beforeOffset).toBeLessThanOrEqual(150);

  // A new empty Chat session switches the solo pane without creating a second
  // mock runtime. Selecting A again exercises the same session restoration path
  // used by sidebar and tab selection.
  await openChatSession(window);
  const sourceTab = window.locator('.session-tab[aria-selected="false"]').first();
  await expect(sourceTab).toBeVisible({ timeout: 10_000 });
  await sourceTab.click();
  await expect(anchorRow).toBeVisible({ timeout: 15_000 });
  // 等待异步恢复真正落位，而非把「旧 DOM 已可见」误认为恢复完成；随后再等一帧
  // 窗口/动画结算，验证 complete 后不会因裁剪高度变化发生第二次漂移。
  await waitForAnchorRestore(window, ANCHOR_TEXT, beforeOffset);
  await window.waitForTimeout(700);
  const afterOffset = await readAnchorOffset(window);
  expect(Math.abs(afterOffset - beforeOffset)).toBeLessThanOrEqual(28);
});

test("a streaming agent does not pull restored historical reading position to the bottom", async ({ app, window }) => {
  test.setTimeout(180_000);
  await constrainTimelineViewport(app);
  await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

  await openChatSession(window);
  for (const prompt of SOURCE_TURNS) {
    await sendTurn(window, prompt);
  }

  const timeline = window.locator(".message-timeline");
  await expandTurnWindow(window);
  // 流式新增一轮会把扩展窗口再向尾部推进；选用稳定处于尾部 cohort 的锚点，
  // 使本用例只验证「流式不能重新贴底」，不耦合另一个历史扩窗策略。
  const anchorRow = timeline.locator("article.user-turn", { hasText: TAIL_WINDOW_ANCHOR_TEXT }).first();
  await expect(anchorRow).toBeVisible({ timeout: 10_000 });

  // The source Agent is now actively generating. Scrolling far enough away from
  // the live edge must escape follow mode before its growing output can race a
  // later session restoration.
  await startSlowStreamingTurn(window, "SLOW active-scroll-anchor");
  await expect(anchorRow).toBeVisible({ timeout: 10_000 });
  const beforeOffset = await placeAnchorInViewport(window, 96, TAIL_WINDOW_ANCHOR_TEXT);
  expect(beforeOffset).toBeGreaterThanOrEqual(40);
  expect(beforeOffset).toBeLessThanOrEqual(150);

  await openChatSession(window);
  const sourceTab = window.locator('.session-tab[aria-selected="false"]').first();
  await expect(sourceTab).toBeVisible({ timeout: 10_000 });
  await sourceTab.click();
  await expect(anchorRow).toBeVisible({ timeout: 15_000 });
  await waitForAnchorRestore(window, TAIL_WINDOW_ANCHOR_TEXT, beforeOffset);

  const restoredOffset = await readAnchorOffset(window, TAIL_WINDOW_ANCHOR_TEXT);
  expect(Math.abs(restoredOffset - beforeOffset)).toBeLessThanOrEqual(28);
  // Let more streamed content arrive after restoration. The reader remains
  // escaped from the live edge, so a growing final run cannot re-pin the view.
  await window.waitForTimeout(1200);
  const stableOffset = await readAnchorOffset(window, TAIL_WINDOW_ANCHOR_TEXT);
  expect(Math.abs(stableOffset - beforeOffset)).toBeLessThanOrEqual(28);
});

test("a reader can escape the live edge with gradual wheel scrolling while an agent streams", async ({ app, window }) => {
  test.setTimeout(180_000);
  await constrainTimelineViewport(app);
  await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

  await openChatSession(window);
  for (const prompt of SOURCE_TURNS.slice(0, 5)) {
    await sendTurn(window, prompt);
  }
  // Previous settled-turn positioning may intentionally leave the viewport above
  // the tail. Return to the live edge so this test begins in the same locked
  // state as a reader who starts scrolling while output is arriving.
  await returnToLiveEdge(window);

  const timeline = window.locator(".message-timeline");
  await startSlowStreamingTurn(
    window,
    "SLOW MDEMO active-wheel-anchor",
    "以下是渲染元素巡检：",
  );
  const anchorRow = timeline.locator("article.user-turn", { hasText: WHEEL_ANCHOR_TEXT }).first();
  await timeline.hover();
  // Trackpad-like deltas exercise the reader's real gradual path rather than
  // teleporting scrollTop directly to the historical target.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await window.mouse.wheel(0, -40);
    await window.waitForTimeout(90);
  }
  await expect(anchorRow).toBeVisible({ timeout: 10_000 });

  const beforeOffset = await placeAnchorInViewport(window, 96, WHEEL_ANCHOR_TEXT);

  // This is the reported path: a running Agent is read through normal wheel
  // navigation, then the user opens another session before returning through
  // the existing session tab.
  await openChatSession(window);
  const sourceTab = window.locator('.session-tab[aria-selected="false"]').first();
  await expect(sourceTab).toBeVisible({ timeout: 10_000 });
  await sourceTab.click();
  await expect(anchorRow).toBeVisible({ timeout: 15_000 });
  await waitForAnchorRestore(window, WHEEL_ANCHOR_TEXT, beforeOffset);
  const restoredOffset = await readAnchorOffset(window, WHEEL_ANCHOR_TEXT);
  expect(Math.abs(restoredOffset - beforeOffset)).toBeLessThanOrEqual(28);

  await window.waitForTimeout(650);
  const afterGrowthOffset = await readAnchorOffset(window, WHEEL_ANCHOR_TEXT);
  expect(Math.abs(afterGrowthOffset - beforeOffset)).toBeLessThanOrEqual(28);
});

test("an immediate session switch captures the latest historical scroll anchor", async ({ app, window }) => {
  test.setTimeout(180_000);
  await constrainTimelineViewport(app);
  await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

  await openChatSession(window);
  for (const prompt of SOURCE_TURNS) {
    await sendTurn(window, prompt);
  }

  const timeline = window.locator(".message-timeline");
  const anchorRow = timeline.locator("article.user-turn", { hasText: TAIL_WINDOW_ANCHOR_TEXT }).first();
  await expect(anchorRow).toBeVisible({ timeout: 10_000 });

  const beforeOffset = await scrollThenOpenNewSession(window, TAIL_WINDOW_ANCHOR_TEXT, 96);
  const sourceTab = window.locator('.session-tab[aria-selected="false"]').first();
  await expect(sourceTab).toBeVisible({ timeout: 10_000 });
  await sourceTab.click();
  await expect(anchorRow).toBeVisible({ timeout: 15_000 });
  // 同一任务内的 scroll 事件必须先同步快照；恢复完成后也不能发生二次漂移。
  await waitForAnchorRestore(window, TAIL_WINDOW_ANCHOR_TEXT, beforeOffset);
  await window.waitForTimeout(700);

  const restoredOffset = await readAnchorOffset(window, TAIL_WINDOW_ANCHOR_TEXT);
  expect(Math.abs(restoredOffset - beforeOffset)).toBeLessThanOrEqual(28);
});
