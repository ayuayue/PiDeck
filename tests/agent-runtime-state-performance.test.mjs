import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadModule(sourcePath) {
  const source = readFileSync(sourcePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const sandbox = { exports: {}, module: { exports: {} }, require };
  vm.runInNewContext(outputText, sandbox, { filename: sourcePath });
  return sandbox.module.exports;
}

test("mergeAgentRuntimeState skips update when nothing changed", () => {
  const { mergeAgentRuntimeState } = loadModule(
    "src/renderer/src/utils/agentRuntimeState.ts",
  );

  const state = {
    isStreaming: true,
    isExecutingTool: false,
    activeToolCall: null,
  };

  // Same values → should return reference unchanged.
  const same = mergeAgentRuntimeState(state, {
    isStreaming: true,
    isExecutingTool: false,
    activeToolCall: null,
  });
  assert.equal(same, state, "should return same reference when no change");

  // Different values → should return new object.
  const changed = mergeAgentRuntimeState(state, {
    isStreaming: false,
    isExecutingTool: false,
    activeToolCall: null,
  });
  assert.notEqual(changed, state, "should return new object when changed");
  assert.equal(changed.isStreaming, false);
});
