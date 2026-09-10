/**
 * 更新源（GitHub Release 镜像）共享契约 —— 主进程与渲染层共用，禁止 import 运行时层。
 *
 * 背景：GitHub provider 的 githubUrl() 只支持 host 覆盖（企业版语义），拼不出
 * 「https://<镜像>/https://github.com/...」前缀代理的路径，因此镜像走 generic
 * provider：把 `镜像前缀 + /ayuayue/PiDeck/releases/latest/download` 整体作为
 * feed baseUrl，latest.yml 与安装包/blockmap 的相对路径都会拼在其后。
 *
 * 镜像可用性变化快：维护者应在发版前实测（curl -L 镜像/releases/latest/download/latest.yml），
 * 死掉的镜像及时从清单移除。设置页的预设列表与主进程 feed URL 生成都读这份清单，
 * 改动两处自动同步（同一事实来源）。
 */

import type { UpdateSourceId } from "./types/settings";

/** 更新所指向的 GitHub 仓库坐标（唯一事实来源，与 main/update/releaseRepo.ts 同源）。 */
export const UPDATE_REPO_OWNER = "ayuayue";
export const UPDATE_REPO = "PiDeck";

/** generic feed 的固定路径段：GitHub 把 `releases/latest/download/<asset>` 302 到当前最新 release。 */
export const RELEASES_LATEST_DOWNLOAD_PATH = "/releases/latest/download";

/** AtomGit 托管根域名。 */
export const ATOMGIT_HOST = "https://atomgit.com";

/**
 * AtomGit OpenAPI 根域名（注意与托管域名不同：api.atomgit.com）。
 *
 * 匿名 `/raw/` 路径已被 GitCode 前端应用接管（返回 SPA HTML 壳 + 易盾验证码 SDK），
 * 程序化取文件内容必须走官方开放接口：
 * `GET {ATOMGIT_API_HOST}/api/v5/repos/:owner/:repo/contents/:path?ref=<branch>`
 * 返回 JSON（content 为 base64），匿名可读公开仓库（实测 5 连发均 ~0.4s 无限速）。
 */
export const ATOMGIT_API_HOST = "https://api.atomgit.com";

/** AtomGit Release 仓库根路径，例如 `https://atomgit.com/ayuayue/PiDeck`。 */
export function atomGitReleasesBase(): string {
  return `${ATOMGIT_HOST}/${UPDATE_REPO_OWNER}/${UPDATE_REPO}`;
}

/** AtomGit Release generic feed baseUrl（latest.yml 与安装包都下载自此路径）。 */
export function atomGitFeedUrl(): string {
  return `${atomGitReleasesBase()}/releases/download/latest`;
}

/** 镜像/非官方更新源清单：保留 AtomGit 作为国内加速源（第一首选）；github 走原生链路。 */
export const UPDATE_SOURCE_MIRRORS: ReadonlyArray<{ id: UpdateSourceId; host: string }> = [
  { id: "atomgit", host: ATOMGIT_HOST },
];

/** GitHub Release 仓库根路径，例如 `https://github.com/ayuayue/PiDeck`。 */
export function gitHubReleasesBase(): string {
  return `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}`;
}

/** 镜像前缀 → generic feed baseUrl。对于 atomgit 直接返回 atomgit feed url。 */
export function buildCustomSourceFeedUrl(host: string): string {
  if (host === ATOMGIT_HOST || host.startsWith(ATOMGIT_HOST)) {
    return atomGitFeedUrl();
  }
  return `${host}/${gitHubReleasesBase()}${RELEASES_LATEST_DOWNLOAD_PATH}`;
}

/**
 * 规范化自定义镜像前缀：trim、去尾斜杠、强制 https/http。非法/空返回 null（UI 实时校验用）。
 */
export function normalizeCustomMirrorHost(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) return null;
    return trimmed;
  } catch {
    return null;
  }
}