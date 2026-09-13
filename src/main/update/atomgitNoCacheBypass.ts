/**
 * AtomGit/GitCode 镜像源 noCache 参数修复（main/update 域）。
 *
 * 背景：AtomGit（及同平台域名 gitcode.com）的 `releases/download` 路由对
 * **任何 query string 都返回 404**（实测 atomgit.com / gitcode.com、latest 别名 /
 * 具体 tag 全中招）。而 electron-updater 检查更新时会在 URL 上无条件附加
 * `?noCache=<时间戳36进制>`（configureRequestUrl 写死，无配置开关），导致
 * 切到 AtomGit 镜像源后「检查更新」永远 404（安装包/blockmap 下载不带 query，
 * 不受影响）。
 *
 * 修复方式：不能改 electron-updater（无开关），改走 Electron session 级
 * `webRequest` 拦截 —— 把镜像下载路径请求中的 noCache 参数剥掉后重定向。
 *
 * ⚠️ 关键：electron-updater 的请求**不走 defaultSession**。它的
 * ElectronHttpExecutor.createRequest（electron-updater/out/electronHttpExecutor.js）
 * 显式 `net.request({ ..., session: session.fromPartition("electron-updater", { cache: false }) })`
 * 用独立 partition 发请求，因此拦截器必须注册在同一个 partition session 上，
 * 注册到 defaultSession 会永远拦不到（0.7.5 曾因此漏修）。
 * `fromPartition` 同名幂等，此处拿到的与 updater 内部缓存的是同一实例。
 * api.atomgit.com（公告/扩展/探针）不在拦截前缀内，不受影响。
 *
 * 注意：webRequest 监听注册后不可移除，本模块使用幂等注册（与 PetWindow CSP
 * 安装同一模式），防止重复调用累积监听。
 */

// 仅类型导入，运行时无 electron 依赖（node --test 可直接加载本模块测纯函数）
import type { Session } from "electron";

/**
 * electron-updater 发起请求所用的 partition 名，与 electron-updater 源码中的
 * NET_SESSION_NAME（"electron-updater"）保持一致；`fromPartition` 同名幂等，
 * 注册 webRequest 必然命中 updater 的真实请求 session。
 */
export const UPDATER_PARTITION_NAME = "electron-updater";

/**
 * 需要剥除 noCache 的下载路径前缀。
 * AtomGit 资产 browser_download_url 会 302 到 gitcode.com，两个 host 都拦。
 */
export const ATOMGIT_DOWNLOAD_PATH_PREFIXES: readonly string[] = [
  "https://atomgit.com/ayuayue/PiDeck/releases/download/",
  "https://gitcode.com/ayuayue/PiDeck/releases/download/",
];

/**
 * 从 URL 中剥离 noCache 参数（electron-updater 的缓存穿透参数，AtomGit 平台
 * 不识别任何 query）。其余参数保留；URL 非法/无该参数时原样返回。
 */
export function stripNoCacheQuery(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.delete("noCache");
    return parsed.toString();
  } catch {
    // 非 URL（理论不会发生）直接放行，让原请求自然失败而不是吞掉错误
    return rawUrl;
  }
}

/**
 * 该请求是否值得剥除 noCache：命中镜像下载前缀 **且** 确实携带 noCache 参数。
 * 快速路径（includes）先过滤掉绝大多数无关请求，减少 URL 解析开销。
 */
export function shouldStripNoCache(rawUrl: string): boolean {
  if (!rawUrl.includes("noCache=")) return false;
  return ATOMGIT_DOWNLOAD_PATH_PREFIXES.some((prefix) => rawUrl.startsWith(prefix));
}

/** webRequest filter 的 urls 模式：`*` 尾部可匹配完整 URL（含 query）。 */
export const ATOMGIT_DOWNLOAD_URL_PATTERNS: readonly string[] =
  ATOMGIT_DOWNLOAD_PATH_PREFIXES.map((prefix) => `${prefix}*`);

// 幂等标记：webRequest 监听不可移除，重复注册会累积（见模块头注释）
let bypassInstalled = false;

/**
 * 安装 AtomGit 镜像下载请求的 noCache 剥除器（幂等）。
 * 必须在 electron-updater 首次发起请求前调用（index.ts 装配 updateService 时）。
 * @param getUpdaterSession 惰性取 electron-updater 的请求 session
 *   （`session.fromPartition(UPDATER_PARTITION_NAME, { cache: false })`），
 *   避免模块加载期访问 electron；不得传 defaultSession（updater 不用它）。
 */
export function installAtomgitNoCacheBypass(getUpdaterSession: () => Session): void {
  if (bypassInstalled) return;
  bypassInstalled = true;
  const updaterSession = getUpdaterSession();
  updaterSession.webRequest.onBeforeRequest(
    { urls: [...ATOMGIT_DOWNLOAD_URL_PATTERNS] },
    (details, callback) => {
      if (!shouldStripNoCache(details.url)) {
        callback({});
        return;
      }
      // 重定向到剥离 noCache 的 URL：新请求重新走拦截器，命中后放行，无循环风险
      callback({ redirectURL: stripNoCacheQuery(details.url) });
    },
  );
}