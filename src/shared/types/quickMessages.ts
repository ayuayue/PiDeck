/**
 * 快捷消息（composer 底栏弹框）跨进程契约。
 *
 * 数据源是用户配置文件 `userData/quick-messages.json`，主进程 QuickMessageStore 读写；
 * 渲染层只拿快照、只提交条目数组，不碰文件路径拼接（路径由主进程解析，防注入）。
 */
export type QuickMessagesSnapshot = {
	/** 当前生效的条目（顺序即弹框顺序）；空数组 = 用户清空，不是「没读到」 */
	items: string[];
	/** 出厂清单（随包资源 quick-messages.default.json），供设置页「恢复默认」使用 */
	defaults: string[];
	/** 用户配置文件绝对路径，设置页展示与「打开配置文件」用 */
	filePath: string;
	/**
	 * 本次读取是否刚生成/重置过配置文件：
	 * true = 文件此前不存在、内容不可识别或已损坏（损坏件会先备份为 .bak）。
	 * 设置页据此提示「已生成配置文件」，避免用户以为自己的手工编辑被吞了。
	 */
	seeded: boolean;
	/** 出厂资源文件是否可读；false 时 defaults 为空，设置页提示安装包可能不完整 */
	defaultsAvailable: boolean;
};

export type QuickMessagesSaveResult = { ok: true; snapshot: QuickMessagesSnapshot } | { ok: false; error: string };
