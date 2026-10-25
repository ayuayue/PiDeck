/**
 * userData 目录更名迁移（pi-desktop → PiDeck）的一次性启动提示。
 * 主进程启动早期完成迁移，渲染层首挂载经 `user-data-migration:consume-notice` 领取一次
 * （领取后即清空，只提示一次），用于 toast 告知用户历史数据已迁移到新位置。
 */
export type UserDataNameMigrationNotice = {
	/** 旧数据目录绝对路径（%APPDATA%/pi-desktop 等） */
	oldPath: string;
	/** 新数据目录绝对路径（.../PiDeck） */
	newPath: string;
	/** 迁移的 pi 会话 encoded 目录数（默认聊天目录会话在其中） */
	migratedSessionDirCount: number;
};
