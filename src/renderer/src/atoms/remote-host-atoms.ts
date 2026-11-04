import { atom } from "jotai";
import type { RemoteHostIdentityIndex } from "../utils/remoteHostIdentity";

/**
 * 远端主机身份 + 连接状态的渲染层快照（侧栏项目行读取）。
 *
 * 为什么进 atom：项目行会随折叠/切 Tab 反复挂载，主机目录也不应该每挂一次就重新查一遍 IPC。
 * 权威仍有两处（主进程的 host store 与连接管理器）；这里只存「最近一次列表 + 最近一次推送」。
 */
export const remoteHostIdentityIndexAtom = atom<RemoteHostIdentityIndex>({});

/**
 * 「当前有没有一台可登记的远端主机」的渲染层缓存（添加项目的远端入口靠它收口）。
 *
 * `undefined` = 还没读到清单（也包含读取失败）：入口按不可见处理，但「读不到」不等于「没有主机」。
 * 写入方只有 useRemoteHostsConfigured。
 */
export const remoteHostsConfiguredAtom = atom<boolean | undefined>(undefined);
