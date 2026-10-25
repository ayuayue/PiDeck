/**
 * 存量 DSH 用户的 runtime 迁移提示（AgentRuntimeProvider 阶段 2）。
 *
 * 背景：runtime 外置后，升级上来的用户可能带着 dsh 会话/配置，但本地没有 runtime
 * （要么是新装、要么 runtime 被回收）。此时 DSH 相关 UI 处于门控态，用户会看到
 * 「会话打不开 / 设置页变成安装引导」而不知道发生了什么。
 *
 * 因此：确认存在 dsh 痕迹（session catalog 里有 dsh 会话）且 runtime 不可用时，
 * 主动提示一次并给出直达入口。「一次」跨重启持久化（settings.dshRuntimeMigrationNoticeShown）：
 * 只用内存闩的话每次重启都会重弹，提示变成骚扰（#317）。错过 toast 的用户仍可从
 * 设置页 DSH 安装引导进入，不为此保持打扰。
 *
 * 判定规则在 shouldShowDshRuntimeMigrationNotice（shared 纯函数，可单测），本 hook 只做收集与展示。
 */
import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { shouldShowDshRuntimeMigrationNotice } from "../../../shared/types/dshRuntime";
import { dshRuntimeStatusAtom } from "../atoms/dsh-atoms";
import { sessionRecordsAtom } from "../atoms/session-atoms";
import { openSettingsAtom } from "../atoms/app-ui-atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

/** 打开「配置管理」页并落在 DSH 后端分页（runtime 未装时概览页即安装引导）。 */
function useOpenConfigPane() {
	const openSettings = useSetAtom(openSettingsAtom);
	return () => openSettings({ tab: "common", pane: "config", backendPane: "dsh" });
}

export function useDshRuntimeMigrationNotice(): void {
	const status = useAtomValue(dshRuntimeStatusAtom);
	const store = useStore();
	const openConfigPane = useOpenConfigPane();
	// 进程内闩：settings.update 是异步 IPC，落盘/回读生效前 status 流可能再触发本 effect，
	// 不能依赖设置回读防重。
	const promptedRef = useRef(false);

	useEffect(() => {
		// checking 期间不判断：状态未定，避免拿中间态误报。
		if (status.state === "checking" || status.state === "installed") return;
		if (promptedRef.current) return;
		const records = store.get(sessionRecordsAtom);
		const hasDshSessions = Object.values(records).some((record) => record.backend === "dsh");
		if (!hasDshSessions) return;
		let cancelled = false;
		void desktopApi.settings
			.get()
			.then((settings) => {
				if (cancelled || promptedRef.current) return;
				if (!shouldShowDshRuntimeMigrationNotice({ state: status.state, hasDshSessions, alreadyShown: settings.dshRuntimeMigrationNoticeShown === true })) return;
				promptedRef.current = true;
				// 先落盘闩再展示：即使写入与 toast 有竞争，重启后也不会再弹。
				void desktopApi.settings.update({ dshRuntimeMigrationNoticeShown: true }).catch(() => undefined);
				showNotice(t("dsh.runtime.migrationNotice"), 8000, "info", undefined, {
					action: { label: t("dsh.runtime.migrationAction"), onClick: openConfigPane },
				});
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [status.state, store, openConfigPane]);
}
