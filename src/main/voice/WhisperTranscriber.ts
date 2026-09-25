/**
 * 本地 whisper-cli 转写执行器。
 *
 * 渲染层把录音解码成 16kHz 单声道 WAV 后经 IPC 送进来（webm/opus 依赖 whisper.cpp
 * 之外的解码器，Chromium 侧解码零成本）；本模块写临时文件 → spawn 官方 CLI →
 * 收 stdout → 清理。音频只在磁盘短暂存在（与「音频永不持久化」的边界一致，
 * finally 必须删除）。
 *
 * 子进程规范（AGENTS 安全约束）：参数数组传递不拼 shell；env 走注入的清洗函数；
 * Windows 用 windowsHide；超时 killProcessTree 杀整棵树，promise 必 settle。
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VOICE_TRANSCRIPTION_LOCAL_TIMEOUT_MS, VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "../../shared/voiceTranscriptionConfig";
import type { VoiceTranscriptionResult } from "../../shared/types/voiceTranscription";
import type { WhisperModelId } from "../../shared/types/whisperRuntime";
import { killProcessTree } from "../git/gitProcess";
import type { WhisperRuntimeManager } from "./WhisperRuntimeManager";

/** 转写输出文本上限：10 分钟语音的正常输出远小于此，超出视为异常输出。 */
const MAX_STDOUT_BYTES = 1024 * 1024;

export type WhisperTranscriberDeps = {
	manager: Pick<WhisperRuntimeManager, "resolveCliPath" | "modelPath">;
	/** 临时 WAV 的落盘目录（userData/voice-runtime/tmp）。 */
	getTempRoot: () => string;
	/** 子进程环境（注入 PiLocator.createProcessEnv 之类的清洗结果）；未就绪时返回 undefined = 继承默认。 */
	getEnv?: () => NodeJS.ProcessEnv | undefined;
	timeoutMs?: number;
	log: (message: string, details?: Record<string, unknown>) => void;
};

export class WhisperTranscriber {
	private readonly inFlight = new Map<string, number>();
	private readonly cancelled = new Set<string>();

	constructor(private readonly deps: WhisperTranscriberDeps) {}

	async transcribe(input: { requestId: string; audio: ArrayBuffer; mimeType: string; cliPath: string; modelId: WhisperModelId; language: string }): Promise<VoiceTranscriptionResult> {
		const mimeType = input.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		if (mimeType !== "audio/wav" && mimeType !== "audio/x-wav") return { ok: false, error: "invalidRequest" };
		if (input.audio.byteLength === 0 || input.audio.byteLength > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) return { ok: false, error: "invalidRequest" };

		const cliPath = this.deps.manager.resolveCliPath({ cliPath: input.cliPath });
		const modelPath = this.deps.manager.modelPath(input.modelId);
		if (!cliPath || !modelPath) {
			this.deps.log("local engine unavailable", { cliReady: Boolean(cliPath), modelReady: Boolean(modelPath) });
			return { ok: false, error: "engineUnavailable" };
		}

		let wavPath: string | null = null;
		try {
			const tempRoot = this.deps.getTempRoot();
			await mkdir(tempRoot, { recursive: true });
			// requestId 已在 IPC 边界限定 [a-zA-Z0-9-]，可直接作文件名。
			wavPath = join(tempRoot, `rec-${input.requestId}.wav`);
			await writeFile(wavPath, Buffer.from(input.audio));
			const text = await this.runCli(cliPath, wavPath, modelPath, input.requestId, input.language);
			if (text === null) return { ok: false, error: "cancelled" };
			// 只判「有没有输出字符」；`[BLANK_AUDIO]` 这类非语音占位词由
			// VoiceTranscriptionService 统一收口（云端引擎也会吐同样的词，必须同源过滤）。
			return text.trim() ? { ok: true, text: text.trim() } : { ok: false, error: "empty" };
		} catch (error) {
			this.deps.log("local transcription failed", { error: error instanceof Error ? error.message : String(error) });
			return { ok: false, error: "engineUnavailable" };
		} finally {
			if (wavPath) await rm(wavPath, { force: true }).catch(() => undefined);
		}
	}

	/** 用户取消进行中的转写：杀掉 whisper-cli 进程树。 */
	cancel(requestId: string): void {
		const pid = this.inFlight.get(requestId);
		if (pid === undefined) return;
		this.cancelled.add(requestId);
		killProcessTree(pid);
	}

	private runCli(cliPath: string, wavPath: string, modelPath: string, requestId: string, language: string): Promise<string | null> {
		return new Promise((resolvePromise, rejectPromise) => {
			const args = ["-m", modelPath, "-f", wavPath, "-nt", "--no-prints"];
			// 空语言 = 交给 whisper 自动检测（--language auto 在部分版本行为不一致，直接省略最稳）。
			if (language.trim()) args.push("-l", language.trim());
			const child = spawn(cliPath, args, {
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				env: this.deps.getEnv?.(),
			});
			let stdout = "";
			let stdoutBytes = 0;
			let overflowed = false;
			let settled = false;
			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				if (child.pid !== undefined) this.inFlight.delete(requestId);
				fn();
			};
			const timeout = setTimeout(() => {
				if (child.pid !== undefined) killProcessTree(child.pid);
				settle(() => rejectPromise(new Error("whisper-cli timeout")));
			}, this.deps.timeoutMs ?? VOICE_TRANSCRIPTION_LOCAL_TIMEOUT_MS);
			timeout.unref?.();

			if (child.pid !== undefined) this.inFlight.set(requestId, child.pid);
			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > MAX_STDOUT_BYTES) overflowed = true;
				else if (!overflowed) stdout += chunk.toString("utf8");
			});
			child.stderr?.on("data", () => {
				/* whisper-cli 把加载日志打到 stderr，不需要消费 */
			});
			child.on("error", (error) => {
				clearTimeout(timeout);
				settle(() => rejectPromise(error));
			});
			child.on("close", (code) => {
				clearTimeout(timeout);
				// cancel() 先杀进程树；close 里用标志区分「取消」与「失败」。
				if (this.cancelled.delete(requestId)) return settle(() => resolvePromise(null));
				if (overflowed) return settle(() => rejectPromise(new Error("whisper-cli output exceeded limit")));
				if (code !== 0) return settle(() => rejectPromise(new Error(`whisper-cli exited with ${code}`)));
				settle(() => resolvePromise(stdout));
			});
		});
	}
}
