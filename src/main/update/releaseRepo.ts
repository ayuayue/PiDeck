/**
 * PiDeck 更新所指向的 GitHub 仓库坐标（唯一事实来源）。
 * 仓库已由 pi-desktop 更名为 PiDeck：旧坐标目前只能靠 GitHub 改名重定向工作，
 * 一旦重定向失效（旧名被他人注册/回收）更新检查会直接 404，禁止再回填旧名。
 *
 * electron-updater 的 GitHub provider 从 package.json build.publish 读取仓库坐标
 * （无需在此注入）；此常量仅用于非更新链路的 Release 资产 URL（如 DSH runtime 索引）。
 */
export const UPDATE_REPO_OWNER = "ayuayue";
export const UPDATE_REPO = "PiDeck";

export const RELEASES_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases`;
