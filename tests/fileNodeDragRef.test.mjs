import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// 与 sessionComposer.test.mjs 同一套 vm 编译模式：
// 直接加载真实实现，只桩掉外部依赖，保证测的是行为而不是复制逻辑。
function compile(filePath, stubs = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => stubs[specifier] ?? {};
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    Set,
  }, { filename: filePath });
  return module.exports;
}

const reactStub = {
  forwardRef: (render) => render,
  useCallback: (fn) => fn,
  useLayoutEffect: () => undefined,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
};

function loadRichInput() {
  return compile("src/renderer/src/components/app/RichInput.tsx", {
    react: reactStub,
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: {} },
  });
}

function loadAppUtils(richInput) {
  return compile("src/renderer/src/components/app/AppUtils.ts", {
    "./RichInput": richInput,
  });
}

/** 最小 DataTransfer 模拟：只实现 read/write 助手用到的接口 */
function createDataTransfer() {
  const store = new Map();
  return {
    setData: (type, value) => store.set(type, String(value)),
    getData: (type) => store.get(type) ?? "",
    get types() { return [...store.keys()]; },
  };
}

const richInput = loadRichInput();
const appUtils = loadAppUtils(richInput);
const {
  PI_FILE_NODE_DRAG_MIME,
  PI_FILE_PATH_DRAG_MIME,
  writeFileNodeDragPayload,
  readFileNodeDragPayload,
  fileNodeDragPayloadToRef,
} = appUtils;

const fileNode = {
  name: "a.ts",
  path: "C:\\proj\\src\\utils\\a.ts",
  relativePath: "src/utils/a.ts",
  type: "file",
};
const dirNode = {
  name: "components",
  path: "C:\\proj\\src\\components",
  relativePath: "src/components",
  type: "directory",
};

// vm 沙箱内创建的对象原型与测试侧不同，strict deepEqual 会误报，逐字段断言
function assertPayload(payload, expected) {
  assert.ok(payload, "payload 不应为 null");
  assert.equal(payload.path, expected.path);
  assert.equal(payload.relativePath, expected.relativePath);
  assert.equal(payload.type, expected.type);
}

test("文件树拖拽负载写入后可完整读回（文件与目录）", () => {
  const dt = createDataTransfer();
  writeFileNodeDragPayload(dt, fileNode);
  // 双写：纯路径（移动落点）+ JSON（composer 落点）
  assert.equal(dt.getData(PI_FILE_PATH_DRAG_MIME), fileNode.path);
  assertPayload(readFileNodeDragPayload(dt), {
    path: fileNode.path,
    relativePath: fileNode.relativePath,
    type: "file",
  });

  const dtDir = createDataTransfer();
  writeFileNodeDragPayload(dtDir, dirNode);
  assert.equal(readFileNodeDragPayload(dtDir)?.type, "directory");
});

test("非文件树拖拽（无负载）返回 null", () => {
  assert.equal(readFileNodeDragPayload(createDataTransfer()), null);
});

test("仅有历史纯路径负载时兜底为文件 + 绝对路径", () => {
  const dt = createDataTransfer();
  dt.setData(PI_FILE_PATH_DRAG_MIME, "C:\\proj\\x.ts");
  assertPayload(readFileNodeDragPayload(dt), {
    path: "C:\\proj\\x.ts",
    relativePath: "",
    type: "file",
  });
});

test("JSON 损坏时退回纯路径兜底", () => {
  const dt = createDataTransfer();
  dt.setData(PI_FILE_NODE_DRAG_MIME, "{not-json");
  dt.setData(PI_FILE_PATH_DRAG_MIME, "C:\\proj\\y.ts");
  assert.equal(readFileNodeDragPayload(dt)?.path, "C:\\proj\\y.ts");
});

test("节点转 @ 引用：文件用相对路径，目录带尾斜杠", () => {
  assert.equal(fileNodeDragPayloadToRef({
    path: fileNode.path, relativePath: fileNode.relativePath, type: "file",
  }), "@src/utils/a.ts");
  assert.equal(fileNodeDragPayloadToRef({
    path: dirNode.path, relativePath: dirNode.relativePath, type: "directory",
  }), "@src/components/");
});

test("节点转 @ 引用：含空格路径自动加引号", () => {
  assert.equal(fileNodeDragPayloadToRef({
    path: "C:\\proj\\my docs", relativePath: "my docs", type: "directory",
  }), '@"my docs/"');
});

test("节点转 @ 引用：relativePath 缺失时退回绝对路径", () => {
  assert.equal(fileNodeDragPayloadToRef({
    path: "C:\\proj\\x.ts", relativePath: "", type: "file",
  }), "@C:\\proj\\x.ts");
});

// 端到端守卫：生成的引用文本必须能被 RichInput chip 规则识别，
// 否则拖进去只是纯文本、不会渲染成引用 chip。
test("生成的引用文本可解析为 file chip", () => {
  const { parseRichInputChips } = richInput;
  const validFilePaths = new Set(["src/utils/a.ts", "src/components"]);

  const fileChips = parseRichInputChips("看下 @src/utils/a.ts", undefined, validFilePaths);
  assert.equal(fileChips.length, 1);
  assert.equal(fileChips[0].kind, "file");
  assert.equal(fileChips[0].label, "src/utils/a.ts");

  const dirChips = parseRichInputChips("@src/components/ 这个目录", undefined, validFilePaths);
  assert.equal(dirChips.length, 1);
  assert.equal(dirChips[0].kind, "file");
  assert.equal(dirChips[0].label, "src/components/");

  // 绝对路径绕过白名单（白名单为空也能识别）
  const absChips = parseRichInputChips("@C:\\proj\\x.ts", undefined, new Set());
  assert.equal(absChips.length, 1);
  assert.equal(absChips[0].kind, "file");

  // 含空格的目录引用（引号包裹 + 尾斜杠）；相对路径需过白名单（真实环境 validFilePaths 含目录节点）
  const spacedChips = parseRichInputChips('@"my docs/"', undefined, new Set(["my docs"]));
  assert.equal(spacedChips.length, 1);
  assert.equal(spacedChips[0].kind, "file");
  assert.equal(spacedChips[0].label, "my docs/");
});
