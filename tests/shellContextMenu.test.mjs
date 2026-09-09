import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// 注册表模块无 electron 依赖，直接编译进 vm；child_process 用 stub 捕获 reg 调用参数。
// promisify mock：等价于 promisify(execFile)，以 (cmd, args, cb) 调用底层 stub 并封装 Promise。
let regCalls = [];
const execFileStub = (cmd, args, cb) => {
  regCalls.push({ cmd, args });
  cb(null, "", "");
};

function promisifyLike(fn) {
  return (...args) =>
    new Promise((resolve, reject) => {
      fn(...args, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
    });
}

function compile(filePath, execFile = execFileStub) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (spec) => {
      if (spec === "node:child_process") return { execFile };
      if (spec === "node:path") return { join: (...parts) => parts.join("\\") };
      if (spec === "node:util") return { promisify: promisifyLike };
      return {};
    },
  });
  return module.exports;
}

const {
  registerShellContextMenu,
  unregisterShellContextMenu,
  isShellContextMenuRegistered,
  SHELL_MENU_KEYS,
} = compile("src/main/integrations/shellContextMenu.ts");

const EXE = "C:\\Program Files\\PiDeck\\PiDeck.exe";
const FOLDER_KEY = SHELL_MENU_KEYS.folder;
const BACKGROUND_KEY = SHELL_MENU_KEYS.background;
const FOLDER_COMMAND = `${FOLDER_KEY}\\command`;
const BACKGROUND_COMMAND = `${BACKGROUND_KEY}\\command`;

// 注册表值里内嵌引号被 \\" 转义（reg.exe /d 期望），断言 helper 帮你还原
function commandArgOf(key) {
  const call = regCalls.find(
    (c) => c.cmd === "reg" && c.args[0] === "add" && c.args[1] === key && c.args.includes("/ve"),
  );
  assert.ok(call, `未找到 command 写入 ${key}`);
  const dIndex = call.args.indexOf("/d");
  return call.args[dIndex + 1];
}

test("注册时对文件夹与空白处各写 3 条 reg add（默认名/command/Icon）", async () => {
  regCalls = [];
  await registerShellContextMenu(EXE);
  const adds = regCalls.filter((c) => c.cmd === "reg" && c.args[0] === "add");
  assert.equal(adds.length, 6);
  const keys = adds.map((c) => c.args[1]).sort();
  assert.deepEqual(keys, [BACKGROUND_COMMAND, BACKGROUND_KEY, BACKGROUND_KEY, FOLDER_COMMAND, FOLDER_KEY, FOLDER_KEY].sort());
});

test("文件夹右键 command 使用 %1，空白处 command 使用 %V（Explorer 展开）", async () => {
  regCalls = [];
  await registerShellContextMenu(EXE);
  assert.match(commandArgOf(FOLDER_COMMAND), /--open-project "%1"/);
  assert.match(commandArgOf(BACKGROUND_COMMAND), /--open-project "%V"/);
});

test("command 值带普通引号传给 reg.exe（不手动预转义），Icon 原样写入", async () => {
  regCalls = [];
  await registerShellContextMenu(EXE);
  // execFile 直接把含引号的 argv 交给 reg.exe：libuv 拼命令行时会包外层引号并把反斜杠加倍，
  // reg.exe 解析还原一层后嵌套引号原样入库；手动预转义会残留字面 \" 导致 Explorer 解析失败。
  assert.equal(
    commandArgOf(FOLDER_COMMAND),
    '"C:\\Program Files\\PiDeck\\PiDeck.exe" --open-project "%1"',
  );
  const iconCall = regCalls.find(
    (c) => c.cmd === "reg" && c.args[1] === FOLDER_KEY && c.args.includes("/v") && c.args.includes("Icon"),
  );
  assert.ok(iconCall, "未找到 Icon 写入");
  assert.equal(iconCall.args[iconCall.args.indexOf("/d") + 1], EXE);
});

test("dev 模式（带 app 路径）命令含 electron 与 app 目录两段参数", async () => {
  regCalls = [];
  await registerShellContextMenu("C:\\electron\\electron.exe", "C:\\dev\\pi-desktop");
  assert.equal(
    commandArgOf(FOLDER_COMMAND),
    '"C:\\electron\\electron.exe" "C:\\dev\\pi-desktop" --open-project "%1"',
  );
});

test("菜单显示名写入文件夹键的默认值", async () => {
  regCalls = [];
  await registerShellContextMenu(EXE, "", "用 PiDeck 打开");
  const call = regCalls.find(
    (c) => c.cmd === "reg" && c.args[1] === FOLDER_KEY && c.args.includes("/ve"),
  );
  assert.ok(call, "未找到 folder 默认值写入");
  assert.equal(call.args[call.args.indexOf("/d") + 1], "用 PiDeck 打开");
});

test("取消注册：删除两个 shell 键（reg delete /f）", async () => {
  regCalls = [];
  await unregisterShellContextMenu();
  assert.equal(regCalls.length, 2);
  assert.equal(regCalls[0].cmd, "reg");
  assert.equal(regCalls[0].args.join("|"), `delete|${FOLDER_KEY}|/f`);
  assert.equal(regCalls[1].cmd, "reg");
  assert.equal(regCalls[1].args.join("|"), `delete|${BACKGROUND_KEY}|/f`);
});

test("查询已注册：两个键都存在才为 true", async () => {
  // keyExists 全部成功
  regCalls = [];
  assert.equal(await isShellContextMenuRegistered(), true);
  assert.equal(regCalls.length, 2);
  assert.equal(regCalls[0].cmd, "reg");
  assert.equal(regCalls[0].args.join("|"), `query|${FOLDER_KEY}`);
  assert.equal(regCalls[1].cmd, "reg");
  assert.equal(regCalls[1].args.join("|"), `query|${BACKGROUND_KEY}`);
});

test("查询未注册：任一键 query 失败即 false（短路不查第二个）", async () => {
  // 覆盖 execFile：folder 查询失败
  const failingStub = (cmd, args, cb) => {
    regCalls.push({ cmd, args });
    if (args[0] === "query" && args[1] === FOLDER_KEY) {
      cb(new Error("找不到指定的注册表项"));
      return;
    }
    cb(null, "", "");
  };
  const { isShellContextMenuRegistered: checkRegistered } = compile(
    "src/main/integrations/shellContextMenu.ts",
    failingStub,
  );
  regCalls = [];
  assert.equal(await checkRegistered(), false);
  assert.equal(regCalls.length, 1, "folder query 失败后不应再查 background");
});