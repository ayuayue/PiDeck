/**
 * 公告提醒「每条只弹一次」的契约回归测试。
 *
 * 曾现 bug（用户反馈「公告会一直弹，不是一次性的」）：toast 去重只存在渲染层组件的
 * ref（`shownIdsRef`）里，而「已读」的唯一入口是打开公告中心。用户点 toast 的 X 或等它
 * 自动消失都不写任何状态，于是同一条未读公告在**每次启动**和**每次渲染进程崩溃自动
 * reload** 后都会重弹一次；若一次积压多条未读，还会以 4s 间隔逐条排队弹出。
 *
 * 契约（本测试守护的不变量）：
 * 1. 去重状态必须持久化在主进程（AnnouncementState.notifiedIds），渲染层 ref 只能当
 *    周期内即时去重，不能是唯一判据；
 * 2. 关掉 toast ≠ 已读：markNotified 与 markRead 分离，不得合并成一个动作；
 * 3. 一轮只弹 1 条，且被压制的旧条目也要记为已提醒（否则顺位成下一轮的「最新」，
 *    攒 N 条就弹 N 轮，等于没压住）；
 * 4. 开关必须在每个 tick 内重读，运行中关闭后立刻停止弹出（只在挂载时读一次的话，
 *    已启动的轮询会继续弹，用户关开关看似无效）。
 *
 * 用源码文本断言（与 announcementDetailDrawerIsolation.test.mjs 同风格）：这些约束
 * 是跨文件的调用契约，单测纯函数覆盖不到「谁调用了谁」。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const notifier = readFileSync("src/renderer/src/hooks/useAnnouncementNotifier.ts", "utf8");
const policy = readFileSync("src/renderer/src/utils/announcementNotifyPolicy.ts", "utf8");
const atoms = readFileSync("src/renderer/src/atoms/announcement-atoms.ts", "utf8");
const service = readFileSync("src/main/announcements/AnnouncementService.ts", "utf8");
const ipc = readFileSync("src/main/ipc/announcementIpc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const channels = readFileSync("src/shared/ipc.ts", "utf8");
const types = readFileSync("src/shared/types/announcement.ts", "utf8");

test("去重状态持久化在主进程：notifiedIds 贯穿契约 → 服务 → 缓存 → IPC → preload", () => {
	// 契约：渲染层收到的状态必须带 notifiedIds（否则渲染层无从判断「历史上弹过没」）
	assert.match(types, /notifiedIds: string\[\]/);
	assert.match(types, /AnnouncementState = AnnouncementSnapshot & \{[\s\S]*?readIds: string\[\];?[\s\S]*?notifiedIds: string\[\]/);
	// 服务：内存态初始化 + 缓存读回 + 原子写盘 + pruneNotifiedIds 裁剪
	assert.match(service, /notifiedIds: \[\],\n\t\};/);
	assert.match(service, /notifiedIds: this\.pruneNotifiedIds/);
	assert.match(service, /notifiedIds: this\.state\.notifiedIds,/);
	assert.match(service, /private pruneNotifiedIds\(ids: string\[\]\): string\[\]/);
	// 缓存字段可选 → 旧缓存兼容（缺省空集，代价最多再弹一次）
	assert.match(service, /notifiedIds\?: string\[\];/);
	// IPC 通道 + 处理器 + 边界校验（元素级校验在 service，IPC 只筛数组）
	assert.match(channels, /announcementMarkNotified: "announcement:mark-notified"/);
	assert.match(ipc, /ipcChannels\.announcementMarkNotified/);
	assert.match(ipc, /if \(!Array\.isArray\(ids\)\) return false;/);
	// preload 暴露给渲染层的方法
	// 声明与调用可能被格式化到同一行：用 \s* 容忍换行。
	assert.match(preload, /markNotified: \(ids: readonly string\[\]\) =>\s*ipcRenderer\.invoke\(ipcChannels\.announcementMarkNotified, ids\)/);
});

test("notifier 必须用持久化的 notifiedIds 判重，不能退回只靠内存 ref", () => {
	// 读主进程快照里的 notifiedIds 一起参与过滤
	assert.match(notifier, /const alreadyNotified = new Set\(\[[\s\S]*?announcementStateAtom[\s\S]*?notifiedIds[\s\S]*?sessionShownIdsRef\.current[\s\S]*?\]\);/);
	// 弹之前必须落盘（先记后弹：弹完立刻崩溃也不会重播）
	assert.match(notifier, /markNotified\(consumed\.map\(\(item\) => item\.id\)\)/);
	// ref 只能当周期内即时去重（注释里必须保留这个定位，防止后人当成唯一判据）
	assert.match(notifier, /sessionShownIdsRef/);
	assert.doesNotMatch(notifier, /shownIdsRef/, "旧的仅内存去重变量不应再出现");
});

test("关掉 toast ≠ 已读：markNotified 与 markRead 分离，不得顺手标已读", () => {
	// notifier 只允许调 markNotified（打开公告中心那处除外，它本来就走 markAllRead）
	assert.match(notifier, /desktopApi\.announcements\s*\n?\s*\.markNotified/);
	assert.doesNotMatch(notifier, /markRead\(/, "弹提醒时顺手标已读会让红点与归档一起消失，用户只是瞥了一眼公告");
	// 服务层两个方法必须独立存在（不能合并成一个动作）
	assert.match(service, /markNotified\(ids: readonly unknown\[\]\): void/);
	assert.match(service, /markRead\(id: string\): void/);
});

test("一轮只弹 1 条，且被压制的旧条目同样记为已提醒", () => {
	// 策略：上限常量 + 显式切分（supressed 也要被消费，否则会顺位重弹）
	assert.match(policy, /export const ANNOUNCEMENT_TOAST_BURST_LIMIT = 1;/);
	assert.match(policy, /export function pickAnnouncementBatch<T>\(/);
	assert.match(policy, /const cut = Math\.max\(0, limit\);/);
	// notifier：shown + suppressed 合并成 consumed 一起标记，且只弹 shown[0]
	assert.match(notifier, /const \{ shown, suppressed \} = pickAnnouncementBatch\(pending\);/);
	assert.match(notifier, /const consumed = \[\.\.\.shown, \.\.\.suppressed\];/);
	assert.match(notifier, /const item = shown\[0\];/);
});

test("开关在每个 tick 内重读（运行中关闭立刻生效）", () => {
	// 检查必须位于 tick 函数体内，且轮询 effect 的依赖数组为空——
	// 若挪回 effect 顶部（挂载时读一次），已启动的轮询会继续弹，关开关看似无效
	assert.match(notifier, /const tick = \(\) => \{[\s\S]*?if \(!getDefaultStore\(\)\.get\(announcementNotificationEnabledAtom\)\) return;/);
	assert.match(notifier, /\}, \[\]\);\n\}/);
	// 关掉开关弹窗也要收起（避免重新开启后残留 open=true 自动弹开）
	const appTsx = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(appTsx, /store\.set\(announcementCenterOpenAtom, false\);/);
});

test("未读语义（红点）与已提醒语义（toast）分离，注释保留区分", () => {
	// unreadAnnouncementsAtom 是「未读」不是「未提醒」：弹过 toast 的条目仍在其中
	assert.match(atoms, /这里是「未读」，不是「未提醒」/);
	assert.match(atoms, /const read = new Set\(state\.readIds\);/);
	// guide 指南不参与未读/红点/提醒（常驻参考，不打扰）
	assert.match(atoms, /item\.category !== "guide"/);
});
