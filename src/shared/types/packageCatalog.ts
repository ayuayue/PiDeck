/**
 * pi.dev 扩展商店（Package Catalog）的跨进程契约。
 *
 * pi.dev 目前没有公开 JSON API（`/api/packages` 返回 501 "reserved for future features"），
 * 因此数据从 `https://pi.dev/packages` 的 SSR HTML 页面解析：每页 50 张卡片，
 * 支持 `?page=&name=&type=&sort=` 服务端过滤，卡片内嵌机器可读的 data-* 属性。
 * 主进程负责 fetch + 解析 + 缓存（10 分钟 TTL），渲染层只消费本文件定义的结构。
 */

/** 商店列表中的单个包（来自 pi.dev 目录卡片）。 */
export type PiPackageCatalogItem = {
	/** npm 包名，如 "@scope/pkg" 或 "pi-web-access"。 */
	name: string;
	description: string;
	/** 作者（展示名，非 npm 用户名）。 */
	author?: string;
	/** 包声明的资源类型，如 ["extension", "skill"]。 */
	types: string[];
	/** 月下载量（pi.dev 统计口径）。 */
	downloadsPerMonth?: number;
	/** 发布时间（epoch 毫秒）。 */
	publishedAt?: number;
	/** npm 包详情页。 */
	npmUrl?: string;
	/** GitHub 仓库页。 */
	githubUrl?: string;
	/** 目录页提供的搜索文本（名称+描述+作者+类型），供客户端过滤。 */
	searchText: string;
	/** 可直接传给 pi install 的安装源，如 "npm:pi-web-access"。 */
	installSource: string;
	/** pi.dev 上的包详情页。 */
	pageUrl: string;
};

/** 商店某一页的完整响应。 */
export type PiPackageCatalog = {
	/** 数据生成时间（epoch 毫秒）。 */
	generatedAt: number;
	/** 是否来自主进程内存缓存（true = 未发新请求）。 */
	fromCache: boolean;
	items: PiPackageCatalogItem[];
	/** 产生 items 的页码（1-based）。 */
	page: number;
	/** 该页实际条数（目录页报告的 range 跨度）。 */
	pageSize: number;
	/** 当前查询条件下的匹配总数（目录页报告）。 */
	total: number;
	/** 最后一页页码。 */
	lastPage: number;
};

/** 商店查询参数（主进程 IPC 入参）。 */
export type PiPackageCatalogQuery = {
	/** 页码，1-based；默认 1。 */
	page?: number;
	/** 搜索关键词（对应目录页 name 参数）。 */
	query?: string;
	/** 资源类型过滤：extension / skill / theme / prompt；空 = 全部。 */
	type?: string;
	/** 排序：downloads（默认，按下载量）| recent（按发布时间）。 */
	sort?: "downloads" | "recent";
	/** 跳过缓存强制刷新。 */
	refresh?: boolean;
};
