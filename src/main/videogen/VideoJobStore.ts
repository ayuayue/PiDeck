import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { VideoGenProtocolFamily } from "../../shared/videoGenConfig";
import type { VideoGenJobStatus } from "../../shared/types/videogen";

/**
 * 生视频任务持久化（userData/videogen/jobs.json）：重启后轮询恢复的数据源。
 *
 * 设计边界：
 * - 只存恢复轮询必需的字段：taskId/protocol/baseUrl/provider/model/参数/状态/消息 id；
 * - **不存 apiKey**（jobs.json 高频重写，密钥只留在 videogen.json；恢复轮询时按
 *   provider id 回查配置，供应商被删则任务按 notConfigured 失败——诚实且不泄密）；
 * - 终态记录保留（时间线恢复依赖 VideoSessionStore 而非这里，这里只为审计/去重），
 *   超过上限时从最旧的终态开始丢弃；进行中的永不丢弃。
 */

/** 主进程内部任务记录（含恢复轮询所需的全部上下文）。 */
export type VideoJobRecord = {
	jobId: string;
	sessionId: string;
	/** assistant 占位消息 id（渲染层事件回流按它对账；user 消息 id 为 `${messageId}-u`） */
	messageId: string;
	provider: string;
	providerName: string;
	model: string;
	prompt: string;
	resolution?: string;
	duration?: string;
	ratio?: string;
	protocol: VideoGenProtocolFamily;
	/** 提交时刻的网关根（恢复轮询用快照，配置后续修改不影响进行中任务） */
	baseUrl: string;
	/** 上游任务 id */
	taskId: string;
	status: VideoGenJobStatus;
	videoRef?: string;
	errorDetail?: string;
	createdAt: number;
	finishedAt?: number;
};

const MAX_JOBS = 500;

export class VideoJobStore {
	constructor(
		private readonly deps: {
			getJobsPath: () => string;
			log: (message: string, ...args: unknown[]) => void;
		},
	) {}

	/** 读全部任务记录（损坏/缺失返回空表）。 */
	async load(): Promise<VideoJobRecord[]> {
		try {
			const raw = await readFile(this.deps.getJobsPath(), "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			const jobs: VideoJobRecord[] = [];
			for (const item of parsed) {
				if (typeof item !== "object" || item === null) continue;
				const row = item as Record<string, unknown>;
				if (typeof row.jobId !== "string" || typeof row.taskId !== "string" || typeof row.sessionId !== "string") continue;
				jobs.push(row as unknown as VideoJobRecord);
			}
			return jobs;
		} catch {
			return [];
		}
	}

	/** 原子写入任务表（先临时文件再 rename，避免崩在半个 JSON 上）。 */
	async save(jobs: VideoJobRecord[]): Promise<void> {
		const filePath = this.deps.getJobsPath();
		const tmp = join(dirname(filePath), "jobs.json.tmp");
		try {
			await mkdir(dirname(filePath), { recursive: true });
			// 超上限从最旧的终态开始丢：进行中/排队任务永不丢
			const terminal = jobs.filter((job) => isTerminalVideoStatus(job.status)).sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
			const active = jobs.filter((job) => !isTerminalVideoStatus(job.status));
			const kept = [...active, ...terminal.slice(Math.max(0, terminal.length - (MAX_JOBS - active.length)))];
			await writeFile(tmp, JSON.stringify(kept, null, 2), "utf8");
			await rename(tmp, filePath);
		} catch (error) {
			this.deps.log("videogen", "jobs save failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}
}

export function isTerminalVideoStatus(status: VideoGenJobStatus): boolean {
	return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timeout";
}
