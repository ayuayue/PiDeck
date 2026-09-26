import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

// 该模块 import 了 voiceWavEncoder（静音预检用），必须按源文件目录解析相对依赖，
// 所以用统一沙箱加载器而不是手写 vm 片段。
const load = createTsSandbox();
const lifecycle = load("src/renderer/src/utils/voiceRecorderLifecycle.ts");
const { canCancelVoiceRecording, canStartVoiceRecording, hasSpeakableAudio, isVoiceTranscriptionConfigured, releaseVoiceRecordingResources, resolveVoiceStartBlockedReason, shouldRequestVoiceMicrophone } = lifecycle;

test("only idle can start; recording and transcribing can both be cancelled", () => {
	assert.equal(canStartVoiceRecording("idle"), true);
	assert.equal(canStartVoiceRecording("requesting"), false);
	assert.equal(canStartVoiceRecording("recording"), false);
	assert.equal(canStartVoiceRecording("transcribing"), false);
	assert.equal(canCancelVoiceRecording("recording"), true);
	assert.equal(canCancelVoiceRecording("requesting"), false);
	// 回归：转写中必须可打断。本地 whisper 可能跑数秒，不能取消就只能干等它插入文本。
	assert.equal(canCancelVoiceRecording("transcribing"), true);
});

test("按钮可见只看总开关；申请麦克风才叠加「引擎就绪」判据", () => {
	// 可见性：enabled 决定（设置里「开启才显示」）。引擎未就绪也先显示按钮，点了再提示补全。
	assert.equal(isVoiceTranscriptionConfigured({ enabled: true, runtimeReady: true }), true);
	assert.equal(isVoiceTranscriptionConfigured({ enabled: true, runtimeReady: false }), true);
	assert.equal(isVoiceTranscriptionConfigured({ enabled: false, runtimeReady: true }), false);
	assert.equal(isVoiceTranscriptionConfigured({ enabled: false, runtimeReady: false }), false);
	// 录音前置：必须 enabled 且 runtimeReady，避免开了开关但引擎没装好就弹权限/录音。
	assert.equal(shouldRequestVoiceMicrophone({ enabled: true, runtimeReady: true }), true);
	assert.equal(shouldRequestVoiceMicrophone({ enabled: true, runtimeReady: false }), false);
	assert.equal(shouldRequestVoiceMicrophone({ enabled: false, runtimeReady: false }), false);
	const hookSource = readFileSync("src/renderer/src/hooks/useVoiceTranscription.ts", "utf8");
	// 配置探测随「设置页版本号」重跑：开启/关闭开关即时刷新按钮，无需切会话或重启。
	assert.match(hookSource, /\[scopeKey,\s*voiceConfigRevision\]/);
	// 先读脱敏配置判就绪，再申请麦克风（未就绪应提前返回，不弹权限）。
	assert.ok(hookSource.indexOf("voiceTranscription.getConfig()") < hookSource.indexOf("requestMicrophone(navigator.mediaDevices"));
	assert.ok(hookSource.indexOf("streamRef.current = stream") < hookSource.indexOf("new MediaRecorder(stream"));
	// 渲染层入口由配置就绪控制：ComposerArea 在未配置时不渲染录音控件
	const composerSource = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	// formatter 会去掉单元素三元的包裹括号：用 \(? 容忍。
	assert.match(composerSource, /composer\.voice\.configured \? \(?/);
});

test("cleanup detaches recorder handlers and stops every microphone track", () => {
	let stopped = 0;
	const recorder = {
		ondataavailable: () => {},
		onerror: () => {},
		onstop: () => {},
	};
	const stream = {
		getTracks: () => [
			{
				stop: () => {
					stopped += 1;
				},
			},
			{
				stop: () => {
					stopped += 1;
				},
			},
		],
	};
	releaseVoiceRecordingResources({ recorder, stream });
	assert.equal(recorder.ondataavailable, null);
	assert.equal(recorder.onerror, null);
	assert.equal(recorder.onstop, null);
	assert.equal(stopped, 2);
});

test("hasSpeakableAudio 挡掉静音与过短录音，放行正常口述", () => {
	const encoder = load("src/renderer/src/utils/voiceWavEncoder.ts");
	const rate = encoder.VOICE_WAV_SAMPLE_RATE;
	const tone = (seconds, amplitude) =>
		encoder.encodeWavPcm(
			Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin(i * 0.1)),
			rate,
		);
	assert.equal(hasSpeakableAudio(tone(1, 0.2)), true, "1 秒、正常音量的语音应放行");
	assert.equal(hasSpeakableAudio(tone(1, 0.0005)), false, "房间噪声 floor 不能当成说话");
	assert.equal(hasSpeakableAudio(tone(0.1, 0.4)), false, "过短录音交给 whisper 只会产生幻觉文本");
});

test("启动受阻要按缺失项报错，不能一律说「未配置」", () => {
	const base = { enabled: true, runtimeReady: false, baseUrl: "https://api.example.com/v1", model: "whisper-1", hasApiKey: true };
	// 回归：开关明明是开的，却提示「请先去配置」——用户在设置页里根本找不到问题。
	assert.equal(resolveVoiceStartBlockedReason({ ...base, enabled: false }), "disabled", "总开关关闭要说「已关闭」");
	assert.equal(resolveVoiceStartBlockedReason({ ...base, engine: "local" }), "localRuntime", "本地引擎缺的是 whisper 运行时");
	const cloud = { ...base, engine: "cloud" };
	assert.equal(resolveVoiceStartBlockedReason({ ...cloud, hasApiKey: false }), "cloudMissingKey", "云端缺 Key 要指向 Key 输入框");
	assert.equal(resolveVoiceStartBlockedReason({ ...cloud, baseUrl: "" }), "cloudMissingEndpoint", "云端缺地址/模型要指向接口配置");
	assert.equal(resolveVoiceStartBlockedReason({ ...cloud, model: "" }), "cloudMissingEndpoint");
	// 已就绪时不该被判为受阻（调用方只在 !shouldRequestVoiceMicrophone 时才取原因）。
	assert.equal(resolveVoiceStartBlockedReason({ ...cloud, runtimeReady: true }), "unknown");
});

test("每种受阻原因都要有中英文案，且不再复用同一句提示", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const reason of ["disabled", "cloudMissingKey", "cloudMissingEndpoint", "localRuntime", "unknown"]) {
		assert.match(zh, new RegExp(`"voice\.error\.blocked\.${reason}":`), `zh 缺 voice.error.blocked.${reason}`);
		assert.match(en, new RegExp(`"voice\.error\.blocked\.${reason}":`), `en 缺 voice.error.blocked.${reason}`);
	}
	// 读取配置失败是另一回事，不能跟「用户没配置」共用文案。
	assert.match(zh, /"voice\.error\.configReadFailed":/);
	assert.match(en, /"voice\.error\.configReadFailed":/);
	// hook 里不得再对「已开启但未就绪」统一弹 notConfigured。
	const hookSource = readFileSync("src/renderer/src/hooks/useVoiceTranscription.ts", "utf8");
	assert.match(hookSource, /voice\.error\.blocked\.\$\{resolveVoiceStartBlockedReason\(config\)\}/);
});

test("录音态只能由 stop() 进入 transcribing，且不得被分段完成回退", () => {
	const hookSource = readFileSync("src/renderer/src/hooks/useVoiceTranscription.ts", "utf8");
	// 回归（bug：未手动停止却自动转写完并结束）：分段转写完成后回退到 recording，
	// 会让状态在录音/转写间反复横跳，并让随后点击的 stop() 因「不是 recording」被吞掉。
	assert.doesNotMatch(hookSource, /updateState\("recording"\)[^;]*activeRequestCountRef/, "分段收尾不得把状态退回 recording");
	assert.doesNotMatch(hookSource, /stateRef\.current === "recording"\) updateState\("transcribing"\)/, "录音中收到分段不得切成 transcribing");
	// 必须仍然保留：stop() 是唯一进入 transcribing 的入口（下面注释里的关键词用于定位真实语句）。
	assert.match(hookSource, /const stop = useCallback\(\(\) => \{\s*if \(stateRef\.current !== "recording"\) return;\s*updateState\("transcribing"\);/);
	// 收尾唯一出口在 onFlush，且带 operation 守卫，取消后不能再把状态改回来。
	assert.match(hookSource, /onFlush:[\s\S]{0,400}?operationRef\.current === operation[\s\S]{0,200}?updateState\("idle"\)/);
});

test("录音态与转写态必须用不同动效区分（用户反馈只能看出在录音）", () => {
	const source = readFileSync("src/renderer/src/components/session/VoiceTranscriptionControls.tsx", "utf8");
	// 回归：以前两态都只有一个 loader + 灰胶囊，用户看不出到底在录还是在转。
	// 录音态改用真实电平驱动的波纹（见 VoiceLevelBars），不再用循环 bars。
	assert.match(source, /<VoiceLevelBars[\s\S]{0,160}?text-destructive/, "录音态要用红底 + 电平波纹，表示实时电平");
	assert.doesNotMatch(source, /variant="bars"/, "bars 是定时循环动画，不随说话变化，已废弃");
	assert.match(source, /variant="helix"/, "转写态要用不同变体（helix），不能沿用录音动效");
	// 两态胶囊底色也要不同：录音 destructive，转写 muted。
	assert.match(source, /bg-destructive\/10/);
	assert.match(source, /TRANSCRIBING_PILL_CLASS\s*=\s*"[^"]*bg-muted\/60/);
	// 转写态必须有非动画的进度提示（文字），不只靠动效传达。
	assert.match(source, /voice\.transcribing/);
	assert.match(source, /voice\.finalizing/);
});

test("录音波纹必须由麦克风电平驱动，且电平表随录音生命周期关闭", () => {
	const source = readFileSync("src/renderer/src/components/session/VoiceLevelBars.tsx", "utf8");
	// 电平从 props.readLevel 读，经 rAF 写 transform：不得把电平塞进 React state 造成每帧重渲染。
	assert.match(source, /requestAnimationFrame\(step\)/);
	assert.match(source, /props\.readLevel\(\)/);
	assert.match(source, /bar\.style\.transform = /);
	assert.doesNotMatch(source, /useState</, "动效状态用 ref，不用 setState");
	// 尊重「减弱动态效果」：降级时不跟电平跳动。
	assert.match(source, /useReducedMotion\(\)/);
	const hookSource = readFileSync("src/renderer/src/hooks/useVoiceTranscription.ts", "utf8");
	// 电平表必须在 releaseMedia 里关闭，否则每次录音漏一个 AudioContext。
	const release = hookSource.slice(hookSource.indexOf("const releaseMedia = useCallback"), hookSource.indexOf("const cancelInFlight"));
	assert.match(release, /levelMeterRef\.current\?\.close\(\)/);
	assert.match(release, /levelMeterRef\.current = null/);
	// 两条引擎共用：必须在 local 分支判断之前建表（云端没有 AudioWorklet）。
	assert.ok(hookSource.indexOf("await createVoiceLevelMeter(stream)") < hookSource.indexOf('if (engineRef.current === "local") {'), "云端引擎也要有电平表");
});

test("转写动效只在真有请求在飞时展示，排空后不得空转", () => {
	const source = readFileSync("src/renderer/src/components/session/VoiceTranscriptionControls.tsx", "utf8");
	// busy 为假时改用静态 dots + 去掉呼吸动画：队列已排空还转圈等于骗人。
	assert.match(source, /props\.busy === false \?[\s\S]{0,160}?variant="dots"/);
	assert.match(source, /props\.busy === false \? "" : "animate-pulse"/);
	const hookSource = readFileSync("src/renderer/src/hooks/useVoiceTranscription.ts", "utf8");
	// hook 必须在请求进出时同步这个状态，否则 UI 的 busy 恒为初始值。
	assert.ok((hookSource.match(/syncTranscribingBusy\(\)/g) ?? []).length >= 4, "请求入队/出队/复位处都要同步 busy");
	assert.match(hookSource, /return \{ state, start, stop, cancel, toggle, configured, transcribingBusy[,}]/);
});
