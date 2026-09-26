/**
 * 桥贡献的配置页（落点 `config.page`）—— 配置页域的状态与命令。
 *
 * 从 `ConfigModal.tsx` 抽出来（PR 评审 §3：三千行的配置弹窗只该消费结果，
 * 「桥配置页注册」这类业务逻辑不该长在装配组件里）。本 hook 负责三件事：
 *
 * 1. 取会话 id：应用级落点由**当前聚焦会话**的 pi 进程供给，不做任何回落
 *    （没有聚焦会话就没有内容，与 pi TUI 里扩展 UI 随会话生灭一致）；
 * 2. 落点 id ↔ Tabs section id 的映射（`guiPageSectionId`，纯函数，可单测）；
 * 3. 停在某个贡献页时贡献消失（扩展卸载 / pi 没跑）→ 通知调用方回退，不留空白页。
 */

import { useEffect } from "react";
import { useBridgeSessionId, useGuiContributions } from "../components/bridge/BridgeSlot";
import type { BridgeUINode } from "../../../shared/types/bridge";

/** 一个桥贡献的配置页：完整落点 id + 归属 + 节点树。 */
export type BridgeConfigPage = { key: string; owner: string; targetId: string; node: BridgeUINode };

/**
 * `config.page` 贡献的完整落点 id → section id（Tabs value 也用它）。
 *
 * 必须**去掉 `:`** —— `parseSectionTabValue` 按 `:` 切 section/tab，
 * 而落点 id 的形态是 `gui:<slot>:<owner>@<key>`，自带两个冒号。
 */
export function guiPageSectionId(targetId: string): `page.${string}` {
	return `page.${targetId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/**
 * 订阅桥贡献的配置页。
 *
 * `activeSection` 是当前停留的 section（`page.*` 表示停在贡献页上）；
 * 该页消失时调用 `onPageMissing()`，由调用方决定退回哪个原生 section。
 */
export function useBridgeConfigPages(input: { activeSection: string; onPageMissing: () => void }): { sessionId: string | undefined; pages: BridgeConfigPage[] } {
	const sessionId = useBridgeSessionId();
	const pages = useGuiContributions(sessionId, "config.page");
	const { activeSection, onPageMissing } = input;
	useEffect(() => {
		if (!activeSection.startsWith("page.")) return;
		if (pages.some((page) => guiPageSectionId(page.targetId) === activeSection)) return;
		onPageMissing();
	}, [activeSection, onPageMissing, pages]);
	return { sessionId, pages };
}
