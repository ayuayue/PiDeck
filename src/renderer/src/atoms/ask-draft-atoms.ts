import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { AskBatchDraft } from "../utils/askUi";

/**
 * ask 提问卡交互草稿（会话级持久化）。
 *
 * 为什么存在：SessionRuntimeUiOverlay 挂在会话 timeline 里，切换会话 tab /
 * 分屏切换会把整棵组件树卸载重建，组件内 useState 的已选答案/输入随之丢失。
 * 答案与输入是「未提交的中间状态」，必须绑定会话而不是组件生命周期——
 * 用户切走再切回，选择应当还在（用户反馈：「ask 选择中切换 tab，选择没了」）。
 *
 * 生命周期：family key = `${sessionId}:${agentId}:${runtimeGeneration}:${requestId}`。
 * 同一请求内任意次重挂都从 atom 恢复；新请求 / runtime 重启由组件 effect 判定
 * key 不一致后整体重置；换请求时组件显式 remove 旧 key，防 Map 堆积。
 *
 * 结构：single 为单问题卡（select 集中提交的选中项、input/editor 文本、展开态），
 * batch 为批量问答卡（每题答案/标签/自定义标记/输入/当前 tab/展开态）。同一会话
 * 同时只有一个活跃请求，两个字段不会并存，但保留分形结构便于任一侧独立读写。
 */
export type AskSingleDraft = {
	/** select 集中提交模式：当前选中的选项原文（未提交前） */
	selectedOption: string;
	/** input/editor/自定义输入框的当前文本 */
	value: string;
	/** 卡片展开/折叠态 */
	expanded: boolean;
};

export type AskInteractionDraft = {
	/** 本草稿归属的请求 key（＝ family key），用于区分「重挂同请求」与「新请求」 */
	key: string;
	single?: AskSingleDraft;
	batch?: AskBatchDraft;
};

export const askDraftBySessionRequestAtomFamily = atomFamily((key: string) => atom<AskInteractionDraft | undefined>(undefined));
