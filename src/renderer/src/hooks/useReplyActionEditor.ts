import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_REPLY_ACTION_RULES } from "../../../shared/replyActions";
import type { ReplyActionRule } from "../../../shared/types/replyActions";
import { t } from "../i18n";
import { mergeReplyActionRules } from "../utils/replyActionRules";
import { showNotice } from "../utils/notice";
import { useReplyActions } from "./useReplyActions";

/**
 * 管理弹框的规则草稿与写盘编排。
 *
 * 与 useQuickMessageEditor 的差异：规则是结构化对象（text + triggers），不存在
 * 「打字合并 400ms」——text 是受控 Input，triggers 是离散点击，任何改动都立即落盘，
 * 界面永远显示文件真实内容（主进程清洗回包），没有可丢失的中间态。
 *
 * 结构性操作（增删/排序/恢复默认/补充内置）走整份保存；主进程负责清洗
 * （坏 trigger 丢弃、按 text 去重、截断到上限）。
 */
export function useReplyActionEditor() {
	const { items, defaults, defaultsAvailable, filePath, loading, error, save, refresh, openFile } = useReplyActions();
	const [merging, setMerging] = useState(false);
	const itemsRef = useRef(items);
	const defaultsRef = useRef({ items: defaults, available: defaultsAvailable });
	itemsRef.current = items;
	defaultsRef.current = { items: defaults, available: defaultsAvailable };

	/** 整份保存；失败走 notice（与快捷消息一致的反馈渠道）。 */
	const commit = useCallback(
		async (rules: ReplyActionRule[]): Promise<boolean> => {
			const ok = await save(rules);
			if (!ok) showNotice(t("settings.replyActionsSaveFailed"));
			return ok;
		},
		[save],
	);

	const setRuleText = useCallback(
		(index: number, text: string) => {
			const current = itemsRef.current;
			if (index < 0 || index >= current.length) return;
			// 空/纯空白文案不落盘：主进程清洗会把空 text 规则整条丢掉，落盘即「行消失」
			// （用户全选删除准备重输时行凭空没）。行保留文件旧文案，UI 侧 RuleRow 用
			// 本地 textDraft 显示空输入；非空输入照旧立即落盘。
			if (text.trim().length === 0) return;
			// 文案只影响这一条；triggers 原样保留（主进程清洗仍会校验 triggers 非空）
			void commit(current.map((rule, i) => (i === index ? { ...rule, text } : rule)));
		},
		[commit],
	);

	const setRuleTriggers = useCallback(
		(index: number, triggers: ReplyActionRule["triggers"]) => {
			const current = itemsRef.current;
			if (index < 0 || index >= current.length) return;
			// triggers 清空成无效规则的中间态由 UI 阻止（至少保留一个），这里不做兜底删除
			void commit(current.map((rule, i) => (i === index ? { ...rule, triggers } : rule)));
		},
		[commit],
	);

	const addRule = useCallback(
		(rule: ReplyActionRule) => {
			const current = itemsRef.current;
			if (current.length >= MAX_REPLY_ACTION_RULES) return;
			// 空文案规则不落盘：主进程清洗会丢弃空 text 条目，落盘即「点了添加没反应」
			// （回包里新行被吞掉）。新增行由弹框作为本地 pending 行展示，文案首次
			// 非空时才调这里真正落盘（与 QuickMessages 新增空行不落盘的语义一致）。
			if (rule.text.trim().length === 0) return;
			void commit([...current, rule]);
		},
		[commit],
	);

	const removeRule = useCallback(
		(index: number) => {
			const current = itemsRef.current;
			if (index < 0 || index >= current.length) return;
			void commit(current.filter((_, i) => i !== index));
		},
		[commit],
	);

	const moveRule = useCallback(
		(index: number, direction: -1 | 1) => {
			const current = itemsRef.current;
			const target = index + direction;
			if (index < 0 || index >= current.length || target < 0 || target >= current.length) return;
			const next = [...current];
			[next[index], next[target]] = [next[target], next[index]];
			void commit(next);
		},
		[commit],
	);

	const reorderRules = useCallback(
		(from: number, to: number) => {
			const current = itemsRef.current;
			if (from === to || from < 0 || from >= current.length || to < 0 || to >= current.length) return;
			const next = [...current];
			const [moved] = next.splice(from, 1);
			next.splice(to, 0, moved);
			void commit(next);
		},
		[commit],
	);

	/** 同步内置清单：同文案条目更新触发条件（内置为准），缺项追加；保留个人顺序与自定义条目。 */
	const mergeDefaults = useCallback(async () => {
		setMerging(true);
		try {
			const snapshot = await refresh();
			if (!snapshot) return;
			// 快照 items 是磁盘最新内容，以此为基线与内置清单合并（受上限约束）
			const merged = mergeReplyActionRules(snapshot.items, defaultsRef.current.items).slice(0, MAX_REPLY_ACTION_RULES);
			const changed = merged.length !== snapshot.items.length || merged.some((rule, i) => rule !== snapshot.items[i]);
			if (!changed) {
				showNotice(t("settings.replyActionsNothingToAdd"));
				return;
			}
			await commit(merged);
		} finally {
			setMerging(false);
		}
	}, [commit, refresh]);

	/** 用内置清单整体替换个人规则。 */
	const resetDefaults = useCallback(async () => {
		setMerging(true);
		try {
			await commit(defaultsRef.current.items);
		} finally {
			setMerging(false);
		}
	}, [commit]);

	return {
		rules: items,
		defaults,
		defaultsAvailable,
		filePath,
		loading,
		error,
		merging,
		atLimit: items.length >= MAX_REPLY_ACTION_RULES,
		addRule,
		removeRule,
		moveRule,
		reorderRules,
		setRuleText,
		setRuleTriggers,
		mergeDefaults,
		resetDefaults,
		refresh,
		openFile,
	};
}
