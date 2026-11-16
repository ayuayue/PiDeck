/**
 * ACP 会话消息读口与磁盘归档桥接。
 *
 * 从 AcpAgentManager 抽出：读路径的「内存投影 → 磁盘归档 → 内存快照」三级回退与
 * 归档回灌/落盘是同一件事的两端，散在 manager 里最容易改了一边忘了另一边。
 * 这里只拿显式的 runtime 表/快照表/归档入口，不碰通道发布与状态机——
 * manager 保留同名薄包装，会话可用性判定（成败）不在此模块。
 */
import type { ChatMessage } from "../../shared/types/session";
import type { AcpAgentRuntime } from "./acpAgentRuntime";
import type { AcpMessageSnapshotStore } from "./AcpMessageSnapshotStore";
import type { AcpSessionArchive } from "./AcpSessionArchive";

/**
 * 按 agent 侧 sessionId 找消息（**同步读口，只覆盖内存态**）。runtime 在场返回全量投影；
 * 已停止（stop/升级强杀）返回最近一次 flush 的内存快照（cap MESSAGE_SNAPSHOT_LIMIT）——
 * 重入会话时时间线不再空白，激活后 session/load 重放会覆盖为完整历史（无 load 能力
 * 则快照即全部可见历史）。
 *
 * 为什么这里不回退磁盘归档：这是同步契约（重启播种链路与既有回归用例都按同步返回
 * 断言），而归档读取是磁盘 IO，同步读在 Electron 主进程会阻塞事件循环。需要
 * 「内存 miss 时读归档」的异步边界（IPC/Web）用 readMessagesWithArchive。
 */
export function readAcpMessagesBySessionId(runtimes: ReadonlyMap<string, AcpAgentRuntime>, snapshots: AcpMessageSnapshotStore, acpSessionId: string): ChatMessage[] {
	if (!acpSessionId) return [];
	for (const runtime of runtimes.values()) {
		if (runtime.acpSessionId === acpSessionId) return runtime.projection.messages;
	}
	return snapshots.get(acpSessionId) ?? [];
}

/**
 * 按 acpSessionId 读消息（**异步读口**）：runtime 投影 → 磁盘归档 → 内存快照逐级回退
 * （归档在快照之前，理由见方法内注释：快照有 400 条上限，归档才是完整历史）。
 * runtime 在场但投影为空（握手/重连窗口）也走归档兜底——否则激活完成前时间线是空白。
 *
 * 为什么保留两个入口：同步版是既有契约（开机恢复/播种与历史用例按同步断言），只覆盖
 * 内存；归档是磁盘 IO，不能塞进同步路径。归档读失败/文件损坏在 AcpSessionArchive
 * 内部降级为空数组，不抛——跨 IPC 不得把归档异常透给渲染层。
 */
export async function readAcpMessagesWithArchive(runtimes: ReadonlyMap<string, AcpAgentRuntime>, snapshots: AcpMessageSnapshotStore, archive: AcpSessionArchive | undefined, acpSessionId: string): Promise<ChatMessage[]> {
	if (!acpSessionId) return [];
	for (const runtime of runtimes.values()) {
		if (runtime.acpSessionId !== acpSessionId) continue;
		// 投影非空：runtime 在场时内存优先，不碰磁盘（既有契约）。
		if (runtime.projection.messages.length > 0) return runtime.projection.messages;
		// 投影为空 = 握手/重连窗口（session/load 重放尚未到达，或 load 失败回退）：
		// 继续走归档兜底。否则打开一个正在启动的会话会读到空数组，Web/桌面时间线
		// 在激活完成前一片空白（用户反馈的「运行中 ACP 会话切回后空白」）。
		// 归档读不到再回退快照；重放完成后投影恢复，下次读取自动切回内存。
		break;
	}
	// 归档优先于内存快照：归档是结算点写的完整快照（≤2000 条），内存快照只是
	// ≤400 条的流式末段。先读快照会让重开的长会话只剩末尾 400 条（时间线、分页、
	// 会话内查找都被截断）。归档读不到（首次运行/写盘失败）才回退快照。
	const archived = (await archive?.read(acpSessionId)) ?? [];
	if (archived.length > 0) return archived;
	return snapshots.get(acpSessionId) ?? [];
}

/**
 * 从磁盘归档回灌内存快照（仅在内存没有该会话时）。
 * 内存优先的理由：内存快照是本进程最新的投影（归档只在结算点写，可能更旧），
 * 用归档覆盖会回退刚产生的历史。读失败/文件损坏在 AcpSessionArchive 内部降级空数组，
 * 这里不做错误分支——归档不可用等价于「没有历史」，不能影响 create。
 */
export async function restoreAcpArchivedSnapshot(snapshots: AcpMessageSnapshotStore, archive: AcpSessionArchive | undefined, acpSessionId: string | undefined): Promise<void> {
	if (!archive || !acpSessionId) return;
	if (snapshots.get(acpSessionId)) return;
	const archived = await archive.read(acpSessionId);
	if (archived.length === 0) return;
	// 双检：await 期间同会话可能有 runtime 结算并写入更新的快照，别用旧归档盖掉它。
	if (snapshots.get(acpSessionId)) return;
	// setRestored：回灌要完整历史，不能套用流式末段的 400 条裁剪（否则重启后只回灌
	// 末尾 400 条，#415 的「历史可读回」打折）。
	snapshots.setRestored(acpSessionId, archived);
}

/**
 * 把当前投影排队写入归档（失败只记日志，永不外抛）。调用点固定在「回合结算后」与
 * stop()/stopAll()：那里投影已 settle、内容稳定，且是一回合一次的写频率。
 */
export function persistAcpArchive(archive: AcpSessionArchive | undefined, runtime: AcpAgentRuntime): Promise<void> {
	const acpSessionId = runtime.acpSessionId;
	if (!archive || !acpSessionId) return Promise.resolve();
	return archive.enqueueSave(acpSessionId, runtime.projection.messages);
}
