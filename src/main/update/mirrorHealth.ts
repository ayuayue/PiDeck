/**
 * 更新镜像健康探测 —— 设置页「更新源」的自动体检。
 *
 * 为什么做：镜像域名可用性/速度波动大（实测 ghproxy.net 慢至 0.16MB/s、ghfast 曾
 * 整体抽风），人工维护不可行。每次打开设置页自动对内置镜像做轻量探测，把结果
 * 分级标记（ok/slow/broken）展示在 UI，用户切换前即可判断该镜像当前是否可用。
 *
 * 探测协议（对齐 electron-updater generic provider 的真实请求序列）：
 *   1. GET <base>/latest.yml          —— 检测：200 + 能解析出版本号才算通
 *   2. GET <base>/<setup>.exe Range  —— 下载预检：206 + 测速（256KB 首段）
 * 探测本身不下载完整安装包，单次约 256KB × 镜像数，开销可忽略。
 *
 * fetch 以参数注入，便于单测（不依赖真实网络）；生产用全局 fetch（Electron 主进程）。
 */

import { UPDATE_SOURCE_MIRRORS, buildCustomSourceFeedUrl } from "../../shared/updateSources";
import type { MirrorHealthResult, MirrorHealthStatus, UpdateSourceId } from "../../shared/types/settings";

/** 类型定义在 shared/types/settings.ts（主/渲染共用），此处 re-export 保持导入路径不变。 */
export type { MirrorHealthResult, MirrorHealthStatus };

/** 下载预检分片大小：256KB 足够测速又不浪费流量。 */
export const PROBE_RANGE_BYTES = 256 * 1024;
/** 单请求超时：探测分支不得拖慢整个设置页（并行探测，最坏 ≈ 超时时间）。 */
export const PROBE_TIMEOUT_MS = 10_000;
/**
 * 慢镜像阈值（KB/s）：小于该值标 slow。依据 2026-09-04 实测——
 * ghfast ≈380KB/s（分片段）与 cxkpro >1MB/s 均判 ok；ghproxy.net ≈230KB/s 判 slow。
 */
export const SLOW_THRESHOLD_KBPS = 300;

/** 探测用的安装包文件名——只取头部字节测速，不关心真实内容（latest.yml 里才有真名）。 */
const PROBE_FILE = "PiDeck-0.7.3-setup.exe";

/** 单个镜像探测；fetchImpl 注入便于测试。超时/非预期响应一律收成 broken，不向外抛。 */
export async function probeMirrorHealth(
  fetchImpl: typeof fetch,
  mirror: { id: UpdateSourceId; host: string },
  now: () => number = Date.now,
): Promise<MirrorHealthResult> {
  const base = buildCustomSourceFeedUrl(mirror.host);
  const checkedAt = now();
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    // ── 1. 检测：latest.yml ──
    const start = now();
    const ymlRes = await fetchImpl(`${base}/latest.yml`, { signal: timeout });
    const latencyMs = now() - start;
    const ymlText = await ymlRes.text();
    if (!ymlRes.ok || !/^version:\s*\S+/m.test(ymlText)) {
      return {
        id: mirror.id,
        status: "broken",
        latencyMs,
        speedKBps: 0,
        error: `latest.yml ${ymlRes.ok ? "格式异常" : `HTTP ${ymlRes.status}`}`,
        checkedAt,
      };
    }

    // ── 2. 下载预检：Range 分片（206 + 测速）──
    const dlStart = now();
    const dlRes = await fetchImpl(`${base}/${PROBE_FILE}`, {
      signal: timeout,
      headers: { Range: `bytes=0-${PROBE_RANGE_BYTES - 1}` },
    });
    // 注意：fetch 会自动跟随 302（GitHub releases/latest 先跳到具体版本）；分片是否保留取决于镜像
    const bytes = await dlRes.arrayBuffer();
    const dlMs = now() - dlStart;
    const speedKBps = dlMs > 0 ? Math.round(bytes.byteLength / dlMs) : 0;
    if (dlRes.status !== 206 || bytes.byteLength < 1024) {
      return {
        id: mirror.id,
        status: "broken",
        latencyMs,
        speedKBps,
        error: `安装包下载预检失败（HTTP ${dlRes.status}）`,
        checkedAt,
      };
    }

    return {
      id: mirror.id,
      status: speedKBps >= SLOW_THRESHOLD_KBPS ? "ok" : "slow",
      latencyMs,
      speedKBps,
      checkedAt,
    };
  } catch (error) {
    // 超时/中止判定不看 instanceof（vm 测试沙箱与生产 realm 不同会误判），
    // 用错误对象 name：AbortSignal.timeout → TimeoutError、手动 abort → AbortError。
    const errName =
      error && typeof error === "object" && "name" in error ? String(error.name) : "";
    return {
      id: mirror.id,
      status: "broken",
      latencyMs: 0,
      speedKBps: 0,
      error: /timeout|abort/i.test(errName) ? "连接超时" : "连接失败",
      checkedAt,
    };
  }
}

/** 探测所有内置镜像（并行，任一失败不影响其它）。 */
export async function probeAllMirrors(fetchImpl: typeof fetch = fetch): Promise<MirrorHealthResult[]> {
  return Promise.all(UPDATE_SOURCE_MIRRORS.map((mirror) => probeMirrorHealth(fetchImpl, mirror)));
}