import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  isUnsupportedThinkingLevelsRpcError,
  parseAvailableThinkingLevelsResponse,
} = loadTsCommonJs("src/main/pi/thinkingLevels.ts");
const { toThinkingPickerLevels, resolveThinkingPickerLevels } = loadTsCommonJs(
  "src/renderer/src/components/session/sessionPickerOptions.ts",
);

const { readFile } = await import("node:fs/promises");
const [pickerSource, ipcSource, sessionIpcSource, preloadSource, componentsSource] = await Promise.all([
  readFile("src/renderer/src/components/session/ComposerPickerHost.tsx", "utf8"),
  readFile("src/shared/ipc.ts", "utf8"),
  readFile("src/main/ipc/sessionIpc.ts", "utf8"),
  readFile("src/preload/index.ts", "utf8"),
  readFile("src/renderer/src/components/session/ComposerComponents.tsx", "utf8"),
]);

test("Pi thinking RPC parses and de-duplicates authoritative levels", () => {
  assert.deepEqual(
    Array.from(parseAvailableThinkingLevelsResponse({
      success: true,
      data: { levels: ["off", " high ", "high", "max"] },
    })),
    ["off", "high", "max"],
  );
});

test("Pi thinking RPC preserves an authoritative empty list", () => {
  assert.deepEqual(
    Array.from(parseAvailableThinkingLevelsResponse({ success: true, data: { levels: [] } })),
    [],
  );
});

test("thinking level ids keep localized known labels and tolerate future ids", () => {
  const levels = toThinkingPickerLevels(["off", "future-level", "off"]);
  assert.equal(levels.length, 2);
  assert.equal(levels[0].labelKey, "thinking.levelLabel.off");
  assert.equal(levels[1].value, "future-level");
  assert.equal(levels[1].label, "future-level");
});

test("malformed success data falls back instead of hiding the picker", () => {
  assert.equal(
    parseAvailableThinkingLevelsResponse({ success: true, data: { levels: ["off", 3] } }),
    undefined,
  );
  assert.equal(
    parseAvailableThinkingLevelsResponse({ success: true, data: {} }),
    undefined,
  );
});

test("unknown RPC from an older Pi is a compatibility fallback", () => {
  assert.equal(
    isUnsupportedThinkingLevelsRpcError("Unknown command: get_available_thinking_levels"),
    true,
  );
  assert.equal(
    parseAvailableThinkingLevelsResponse({
      success: false,
      error: "Unknown command: get_available_thinking_levels",
    }),
    undefined,
  );
});

test("non-compatibility RPC errors are not swallowed", () => {
  assert.throws(
    () => parseAvailableThinkingLevelsResponse({ success: false, error: "agent is busy" }),
    /agent is busy/,
  );
});

test("Pi picker probes runtime levels only for an idle cache miss", () => {
  assert.match(pickerSource, /beginPiRuntimeThinkingLevels\(\{ sessionId, target \}\)/);
  assert.match(pickerSource, /desktopApi\.sessions\.listRuntimeThinkingLevels\(\{/);
  assert.match(pickerSource, /resolvePiRuntimeThinkingLevels\(\{/);
  assert.match(pickerSource, /runtimePiLevels: runtimeLevels/);
  assert.match(pickerSource, /props\.picker !== "thinking"/);
  assert.match(pickerSource, /runtime\?\.status !== "idle"/);
  assert.match(pickerSource, /report === null/);
  assert.match(pickerSource, /cachedModel\?\.thinkingLevels !== undefined/);
});

test("thinking picker immediately uses cache or compatibility levels while Pi runtime probing is pending", () => {
  const values = (input) => Array.from(resolveThinkingPickerLevels(input), (level) => level.value);
  // 运行中的 Pi runtime RPC 尚未返回时，已经水合的 capability cache 必须立刻可用。
  assert.deepEqual(values({ backend: "pi", cachedPiLevels: ["off", "high", "max"] }), ["off", "high", "max"]);
  // 缓存也没有时不能让菜单转圈；继续给用户兼容全量档位，后端做最终校验。
  assert.deepEqual(values({ backend: "pi" }), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  // 只有后端明确返回空数组时才表示没有可选档位。
  assert.deepEqual(values({ backend: "pi", runtimePiLevels: [] }), []);
  // 统一标准：cache 是唯一展示源；两者同时存在（runtime 探测后 cache 才刷新）时以 cache 为准。
  assert.deepEqual(
    values({ backend: "pi", cachedPiLevels: ["off", "high", "max"], runtimePiLevels: ["off"] }),
    ["off", "high", "max"],
  );
});

test("DSH missing reasoning metadata falls back to selectable full levels", () => {
  const values = (input) => Array.from(resolveThinkingPickerLevels(input), (level) => level.value);
  assert.deepEqual(values({ backend: "dsh" }), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(
    values({ backend: "dsh", dshReasoningEfforts: [{ id: "off" }, { id: "high" }] }),
    ["off", "high"],
  );
  // 运行中只在 idle 时做没有缓存的后台探测；探测不再是弹窗 loading 的前置条件。
  assert.match(pickerSource, /runtime\?\.status !== "idle"/);
  assert.match(pickerSource, /cachedModel\?\.thinkingLevels !== undefined/);
  assert.match(pickerSource, /resolveThinkingPickerLevels\(/);
  // 弹窗 loading 现在只反映「模型目录首屏加载」（catalogLoading → ModelPicker.loading），
  // 与思考档位探测解耦：探测仍只在 idle 且无缓存时后台进行，不会把面板卡成 loading。
  assert.match(pickerSource, /loading=\{catalogLoading\}/);
  assert.match(componentsSource, /loading\?: boolean/);
  assert.match(componentsSource, /resolveModelPickerBody\(\{/);
  assert.match(componentsSource, /loading: props\.loading,/);
});

test("DSH thinking/model failures surface the real host reason", () => {
  // DSH selectModel 拒绝（如 reasoningEffort 不被模型支持）时 toast 必须带 debugDetails，
  // 否则用户只看到泛化的「会话操作失败，请重试。」且主进程无日志可查。
  assert.match(pickerSource, /sessionCommandFailureToast\(error\)/);
});

test("thinking-level RPC is wired through shared IPC, main handler, and preload", () => {
  assert.match(ipcSource, /sessionsRuntimeThinkingLevels: "sessions:runtime-thinking-levels"/);
  assert.match(sessionIpcSource, /ipcChannels\.sessionsRuntimeThinkingLevels/);
  assert.match(preloadSource, /listRuntimeThinkingLevels: /);
});
