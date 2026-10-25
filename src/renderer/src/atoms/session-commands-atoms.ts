import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import { registerSessionFamilyForDisposal } from "./session-family-registry";
import type { PiCommand } from "../../../shared/types";

/**
 * 每会话的 runtime 命令表，按 sessionId 隔离。
 *
 * 历史消息里 `/命令` chip 的白名单必须跟随「渲染这条消息的会话」而不是全局聚焦会话，
 * 分屏两栏各自读写自己的键，互不串扰（旧实现是 App 级单份 state，非聚焦栏会拿到
 * 聚焦会话的命令表，导致另一栏的命令 chip 渲染错乱/丢失）。
 */
export const sessionCommandsAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => atom<PiCommand[]>([])));

/**
 * runtime 命令表的刷新信号：热重载 `/reload` 后扩展/技能/提示词可能变化，但
 * runtime 的 agentId/generation 不变，普通依赖无法触发重新拉取。递增该 atom
 * 让 composer 的 `/` 建议与时间线命令 chip 白名单重新 `get_commands`。
 */
export const sessionCommandsRefreshTickAtom = atom(0);

/**
 * 正在热重载的会话（composer 发送闸门）。
 *
 * reload 会拆掉 pi 的 extension runtime；期间再发 prompt 可能让 `/reload` 排队到
 * 用户消息之后，或在 reload 中途启动模型回合。composer 的发送入口读这个 atom
 * 直接拒绝并发发送，避免把正在执行的扩展 handler 拆掉。
 */
export const sessionReloadingByIdAtom = atom<Record<string, boolean>>({});
