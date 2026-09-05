import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadPreflight() {
  const filePath = "src/renderer/src/atoms/update-install-preflight.ts";
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      module,
      exports: module.exports,
      require: (id) => {
        if (id === "jotai") return { atom: (initialValue) => initialValue };
        throw new Error(`Unexpected dependency: ${id}`);
      },
      Promise,
    },
    { filename: filePath },
  );
  return module.exports;
}

const { flushUpdateInstallPreflight } = loadPreflight();

test("update install preflight waits for every registered editor save", async () => {
  const calls = [];
  const saved = await flushUpdateInstallPreflight([
    async () => {
      calls.push("first");
      return true;
    },
    async () => {
      calls.push("second");
      return true;
    },
  ]);

  assert.equal(saved, true);
  assert.deepEqual(calls, ["first", "second"]);
});

test("update install preflight blocks installation but still runs remaining saves after a failure", async () => {
  const calls = [];
  const saved = await flushUpdateInstallPreflight([
    async () => {
      calls.push("failed");
      return false;
    },
    async () => {
      calls.push("rejected");
      throw new Error("disk unavailable");
    },
    async () => {
      calls.push("later");
      return true;
    },
  ]);

  assert.equal(saved, false);
  assert.deepEqual(calls, ["failed", "rejected", "later"]);
});
