import type { DshHomeSharingState } from "../../../../shared/types/dshHome";

export type DshStatus = {
	started: boolean;
	homeDir: string;
	/** 最近一次 host boot 失败的真实原因（host-error 详情/stderr 尾部）；无失败为 null。 */
	bootError?: string | null;
	/** DSH_HOME 共享/冲突状态（issue #189）；旧主进程未回传时缺省。 */
	sharing?: DshHomeSharingState;
	/** 用户是否手动停止了 host（true 时不会自动启动）；旧主进程未回传时缺省。 */
	manuallyStopped?: boolean;
};
export type CredentialState = {
	configured: boolean;
	source?: string;
	writable: boolean;
};
