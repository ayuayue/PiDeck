import { createVoicePcmProcessorModuleUrl } from "./voicePcmProcessor";

/**
 * 流式识别的采集路径：AudioWorklet 把麦克风重采样成 16kHz、量化成 16bit，按定长帧回传。
 *
 * 与本地引擎的分段采集（`useVoiceTranscription` 里的 `startLocalPcmCapture`）同构但不同处理器：
 * 帧的切分规则在 worklet 里（见 `voicePcmProcessor.ts` 的 `pideck-voice-frame-processor`），
 * 这里只负责建图与生命周期——静音切段那套阈值逻辑对流式是有害的，服务端本来就会自己断句。
 */
export type VoiceStreamCaptureHandle = {
	context: AudioContext;
	worklet: AudioWorkletNode;
	/** 让 worklet 吐出不足一帧的尾巴并回 `flushed`；真正的释放由调用方在收到回调后做。 */
	requestFlush: () => void;
	/** 断开音频图、撤销 Blob URL、停掉麦克风轨道。 */
	stop: () => void;
};

export async function startVoiceStreamCapture(stream: MediaStream, input: { onFrame: (pcm: ArrayBuffer) => void; onFlushed: () => void }): Promise<VoiceStreamCaptureHandle> {
	const context = new AudioContext({ latencyHint: "interactive" });
	let source: MediaStreamAudioSourceNode | null = null;
	let worklet: AudioWorkletNode | null = null;
	let moduleUrl: string | null = null;
	try {
		if (!context.audioWorklet) throw new Error("AudioWorklet unavailable");
		moduleUrl = createVoicePcmProcessorModuleUrl();
		await context.audioWorklet.addModule(moduleUrl);
		source = context.createMediaStreamSource(stream);
		worklet = new AudioWorkletNode(context, "pideck-voice-frame-processor", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
		worklet.port.onmessage = (event: MessageEvent<{ type: "frame"; pcm: ArrayBuffer } | { type: "flushed" }>) => {
			if (event.data.type === "flushed") input.onFlushed();
			else input.onFrame(event.data.pcm);
		};
		// worklet 必须接到 destination 才会被调度；用 0 增益的旁路保证监听的麦克风不会被回放成回音。
		const mute = context.createGain();
		mute.gain.value = 0;
		source.connect(worklet);
		worklet.connect(mute);
		mute.connect(context.destination);
		if (context.state === "suspended") await context.resume();
		const activeWorklet = worklet;
		const activeSource = source;
		let revoked = false;
		const release = () => {
			if (revoked) return;
			revoked = true;
			activeWorklet.port.onmessage = null;
			activeWorklet.port.close();
			activeWorklet.disconnect();
			activeSource.disconnect();
			if (moduleUrl) URL.revokeObjectURL(moduleUrl);
			if (context.state !== "closed") void context.close().catch(() => undefined);
			for (const track of stream.getTracks()) track.stop();
		};
		return {
			context,
			worklet: activeWorklet,
			requestFlush: () => activeWorklet.port.postMessage("flush"),
			stop: release,
		};
	} catch (error) {
		worklet?.port.close();
		worklet?.disconnect();
		source?.disconnect();
		if (moduleUrl) URL.revokeObjectURL(moduleUrl);
		if (context.state !== "closed") await context.close().catch(() => undefined);
		throw error;
	}
}
