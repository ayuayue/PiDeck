import { UPDATE_REPO, UPDATE_REPO_OWNER } from "../../shared/updateSources";

/**
 * PiDeck 更新所指向的 GitHub 仓库坐标。
 *
 * 坐标的唯一事实来源收敛到 shared/updateSources.ts：这里直接复用，不再手抄字面量
 * （此前两处各写一份、靠人工同步，迟早漂移）。对外仍导出同名常量，消费方无需改动。
 *
 * electron-updater 的 GitHub provider 从 package.json build.publish 读取仓库坐标
 * （无需在此注入）；此常量仅用于非更新链路的 Release 资产 URL（如 DSH runtime 索引）。
 */
export { UPDATE_REPO, UPDATE_REPO_OWNER };

export const RELEASES_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases`;
