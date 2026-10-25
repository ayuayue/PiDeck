/**
 * 应用公告（无服务器拉取模式）共享契约 —— 主进程与渲染层共用，禁止 import 运行时层。
 *
 * 架构：公告源 = PiDeck 仓库根的 announcements.json（git 管理，发公告 = commit）。
 * 主进程 AnnouncementService 按多源 fallback 定时拉取（jsDelivr → 内置镜像代理 →
 * raw），解析校验后写 userData 缓存并向渲染层推送；渲染层只消费已过滤的
 * AnnouncementItem（TTL 过滤、版本门控在主进程做，渲染层不做业务判定）。
 *
 * 发布规则（维护者）：
 * - 每条公告必须有稳定 id + publishedAt + effectiveUntil（拉取模式必须可过期）；
 * - minVersion 可选：仅向低于该版本的客户端展示（引导升级用）；
 * - 下线公告 = 从数组删除该条，或等 effectiveUntil 自然过期（双保险）。
 */

/** 公告级别：info 常规 / warn 需要关注 / critical 强提醒（横幅样式与红点力度区分）。 */
export type AnnouncementLevel = "info" | "warn" | "critical";

/**
 * 公告类别（生命周期 × 打扰策略，决定列表呈现、已读去向与提醒力度）：
 * - flash 临时通知：时点性信息（系统维护/活动截止/一次性提示），时间敏感、强提醒；
 *   未读时计入角标与 toast，读完即从列表移除（时点信息不值得回查）；
 * - notice 公告：正式广播（版本发布/行为变更/重要说明），阅读后折叠进「已读归档」可回查；
 *   未读时计入角标与 toast，toast 尊重「公告通知」总开关；
 * - guide 指南：常驻参考（新手教程/功能说明），始终显示在「使用指南」区，不追踪已读、不打扰。
 * 旧数据缺省按 notice 处理（兼容历史 feed 与缓存；上一版 notice/guide 语义保持不变）。
 */
export type AnnouncementCategory = "flash" | "notice" | "guide";

/** 单条公告（渲染层可见形态，均为校验后的干净数据）。 */
export type AnnouncementItem = {
	/** 稳定唯一 id（发布后不可变更）；渲染层已读去重的 key。 */
	id: string;
	/** 标题（单行短文案）。 */
	title: string;
	/**
	 * 正文（markdown 文本）：列表卡片展示清洗后的短摘要，完整正文在详情弹窗经
	 * MarkdownStream 的 sanitize 管线渲染（与会话消息同一渲染链，不新增注入面）；
	 * markdown 结构可用（加粗/列表/链接等），大小上限 5000 字符（服务端校验）。
	 */
	body: string;
	level: AnnouncementLevel;
	/** 类别：notice 通知（瞬态）/ guide 指南（常驻）；旧数据缺省按 notice。 */
	category: AnnouncementCategory;
	/** 发布时间（ISO 8601）。 */
	publishedAt: string;
	/** 过期时间（ISO 8601）；主进程按本地时间过滤，过期条目不下发。 */
	effectiveUntil: string;
	/**
	 * 可选版本门控：仅当客户端 appVersion < minVersion 时展示（引导升级）。
	 * 缺省 = 对所有版本展示。
	 */
	minVersion?: string;
};

/** announcements.json 的整体 schema（仓库源文件形态）。 */
export type AnnouncementFeed = {
	/** feed 结构版本，保留演进空间；当前解析仅接受 1。 */
	version: number;
	announcements: AnnouncementItem[];
};

/** 主进程下发给渲染层的公告快照（IPC 推送与 list 返回共用）。 */
export type AnnouncementSnapshot = {
	/** 当前有效公告（已按 TTL + 版本门控过滤，按发布时间倒序）。 */
	items: AnnouncementItem[];
	/** 最近一次成功拉取时间戳（ms）；null = 从未成功（可能展示内置兜底公告）。 */
	fetchedAt: number | null;
	/** 本次数据来源："remote" = 远端拉取；"cache" = 上次缓存；"builtin" = 仓库内置兜底。 */
	source: "remote" | "cache" | "builtin";
};

/**
 * 渲染层收到的完整状态（快照本体 + 已读集合 + 已提醒集合）。
 * 未读判定由渲染层按 id 差集计算；两个集合都持久化在主进程 userData。
 */
export type AnnouncementState = AnnouncementSnapshot & {
	readIds: string[];
	/**
	 * 已弹过 toast 的公告 id（与 readIds 独立：用户关掉 toast 不等于看过公告）。
	 * 存在的意义是「每条公告在这台机器上只弹一次」——只靠渲染层内存去重，重启 / 渲染进程
	 * 崩溃自动 reload 都会重置，同一条未读公告会跟着每次启动重放（用户反馈的「一直弹」）。
	 * 必须持久化，且裁剪规则与 readIds 不同：只保留仍在当前 feed 里的 id
	 * （公告下线后这个 id 再无意义，不像 readIds 还要标记归档条目）。
	 */
	notifiedIds: string[];
};
