/**
 * 薄包装：删除淡出 + 位移收拢原语已整块迁至 components/removal/RemovalList
 * （智能体市场网格 / 收藏列表与侧栏共用同一套行为），此处仅保留侧栏既有导入路径，
 * 行为零变化（源码整块迁出 + 原文件留薄包装，重构纪律）。
 */
export { RemovalList as SidebarRemovalList, RemovalRow as SidebarRemovalRow } from "../removal/RemovalList";
