import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Batch 2A: Lazy Session activation invariants.
 *
 * These tests verify that the frozen architecture preserves the rule:
 * "打开/切换 Session 不启动 Agent；首次发送消息才激活 runtime。"
 *
 * They validate behavioral contracts in source files; they do NOT
 * mock Jotai stores or run React. If a test fails, it means the
 * frozen architecture's source code no longer enforces the invariant.
 */

// ── source files ──

const sessionSendSource = readFileSync("src/renderer/src/hooks/useSessionSend.ts", "utf8");
const sessionActionsSource = readFileSync("src/renderer/src/hooks/useSessionActions.ts", "utf8");
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");

// ── helpers ──

function functionBody(name, source) {
	const marker = `function ${name}(`;
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `${name} should exist in source`);
	const bodyStart = source.indexOf("{", start);
	let depth = 0;
	for (let index = bodyStart; index < source.length; index += 1) {
		const char = source[index];
		if (char === "{") depth += 1;
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(bodyStart + 1, index);
		}
	}
	throw new Error(`Could not parse function body for ${name}`);
}

/**
 * Extract a specific returned function from a hook returned object.
 * Works with patterns like:
 *   return {
 *     openSidebarSession: async (...) => { ... },
 *     ...
 *   }
 *   or
 *   return async function sendSessionPrompt(...) { ... }
 */
function returnedFunctionBody(name, source) {
	// Try async arrow in object:  name: async (...) => { ... }
	const objArrow = new RegExp(`\\b${name}\\s*:\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>\\s*\\{`);
	const match = source.match(objArrow);
	if (match) {
		const bodyStart = source.indexOf("{", match.index + match[0].length - 1);
		let depth = 0;
		for (let index = bodyStart; index < source.length; index += 1) {
			const char = source[index];
			if (char === "{") depth += 1;
			if (char === "}") {
				depth -= 1;
				if (depth === 0) return source.slice(bodyStart + 1, index);
			}
		}
	}
	// Try regular function: return async function name(...) { ... }
	const funcMarker = `return async function ${name}(`;
	const funcStart = source.indexOf(funcMarker);
	if (funcStart !== -1) {
		const bodyStart = source.indexOf("{", funcStart);
		let depth = 0;
		for (let index = bodyStart; index < source.length; index += 1) {
			const char = source[index];
			if (char === "{") depth += 1;
			if (char === "}") {
				depth -= 1;
				if (depth === 0) return source.slice(bodyStart + 1, index);
			}
		}
	}
	// Try exported named function: export async function name(...)
	{
		const exportMarker = `export async function ${name}(`;
		const exportStart = source.indexOf(exportMarker);
		if (exportStart !== -1) {
			const bodyStart = source.indexOf("{", exportStart);
			let depth = 0;
			for (let index = bodyStart; index < source.length; index += 1) {
				const char = source[index];
				if (char === "{") depth += 1;
				if (char === "}") {
					depth -= 1;
					if (depth === 0) return source.slice(bodyStart + 1, index);
				}
			}
		}
	}
	// Try named async function: async function name(...)
	{
		const namedMarker = `async function ${name}(`;
		const namedStart = source.indexOf(namedMarker);
		if (namedStart !== -1) {
			const bodyStart = source.indexOf("{", namedStart);
			let depth = 0;
			for (let index = bodyStart; index < source.length; index += 1) {
				const char = source[index];
				if (char === "{") depth += 1;
				if (char === "}") {
					depth -= 1;
					if (depth === 0) return source.slice(bodyStart + 1, index);
				}
			}
		}
	}
	// Try plain named function: function name(...)
	{
		const namedMarker = `function ${name}(`;
		const namedStart = source.indexOf(namedMarker);
		if (namedStart !== -1) {
			const bodyStart = source.indexOf("{", namedStart);
			let depth = 0;
			for (let index = bodyStart; index < source.length; index += 1) {
				const char = source[index];
				if (char === "{") depth += 1;
				if (char === "}") {
					depth -= 1;
					if (depth === 0) return source.slice(bodyStart + 1, index);
				}
			}
		}
	}
	throw new Error(`Could not locate returned function: ${name}`);
}

// ── Tests ──

// ════════════════════════════════════════════════════════════════════
// 1. Lazy Session open: no Agent creation
// ════════════════════════════════════════════════════════════════════

test("openSidebarSession selects a SessionRecord without Agent creation primitives", () => {
	const body = returnedFunctionBody("openSidebarSession", sessionActionsSource);
	assert.match(body, /await refreshProjectSessions\(projectId/);
	assert.match(body, /commitSessionSelection\(projectId, record\.id/);
	assert.doesNotMatch(body, /listCatalog|bindSessionRuntime|createAgent\(/);
});

test("selectSession does not trigger bindSessionRuntime or Agent start", () => {
	const body = returnedFunctionBody("selectSession", sessionActionsSource);
	assert.doesNotMatch(body, /bindSessionRuntime|bindRuntime|createAgent\(|listCatalog/);
});

test("history drawer uses lazy Session open in DrawerSurface", () => {
	const drawerSource = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
	assert.match(drawerSource, /onOpenSession=\{/);
});

// ════════════════════════════════════════════════════════════════════
// 2. First send activates runtime
// ════════════════════════════════════════════════════════════════════

test("sendSessionPrompt binds runtime after successful prompt send", () => {
	const body = returnedFunctionBody("sendSessionPrompt", sessionSendSource);
	assert.match(body, /requestId = crypto\.randomUUID\(\)/);
	assert.match(body, /options\.sendPrompt\(\{/);

	// When no runtimeAgentId exists, send state = "activating"
	assert.match(body, /status:\s*runtimeAgentId\s*\?\s*"sending"\s*:\s*"activating"/);

	// After send, bindRuntime is called with result
	assert.match(body, /bindRuntime\(\{/);
	assert.match(body, /sessionId/);
	assert.match(body, /agentId:\s*result\.agentId/);
	assert.match(body, /runtimeGeneration:\s*result\.runtimeGeneration/);
	assert.match(body, /result\.accepted\s*\?\s*"running"\s*:\s*undefined/);
});

test("sendSessionPrompt rejects empty and whitespace-only drafts", () => {
	const body = returnedFunctionBody("sendSessionPrompt", sessionSendSource);

	// Empty/whitespace without images must return early before send
	assert.match(body, /if\s*\(!hasComposerSubmission\(rawDraft,\s*imageSnapshot\)\)\s*return/);
});

test("hasComposerSubmission correctly rejects empty messages", () => {
	const body = functionBody("hasComposerSubmission", sessionSendSource);
	assert.match(body, /message\.trim\(\)/);
	// Must also consider images
	assert.match(body, /images\?\.length/);
});

test("sendSessionPrompt without runtime binding shows activating send state", () => {
	const body = returnedFunctionBody("sendSessionPrompt", sessionSendSource);

	// Verify the activating/sending branch exists
	assert.match(body, /status:\s*runtimeAgentId\s*\?\s*"sending"\s*:\s*"activating"/);
	assert.match(body, /requestId/);

	// After accepted result, idle state is restored
	assert.match(body, /"idle"/);
});

// ════════════════════════════════════════════════════════════════════
// 3. Session identity protection during fast switching
// ════════════════════════════════════════════════════════════════════

test("App derives activeAgentId from Session runtime binding atom", () => {
	assert.match(appSource, /activeAgentIdAtom/);
	assert.match(appSource, /const activeAgentId = useAtomValue\(activeAgentIdAtom\)/);
	assert.doesNotMatch(appSource, /setActiveAgentId/);
});

test("Session has no Agent runtime before first send", () => {
	// Verify sessionRuntimeByIdAtom is the only source of truth
	const atomsSource = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
	assert.match(atomsSource, /sessionRuntimeByIdAtom/);

	// The atom's initial state is an empty record (no pre-bound agents)
	assert.match(atomsSource, /sessionRuntimeByIdAtom\s*=\s*atom.*Record.*\{\}/);
});

test("active Agent identity does not use useState", () => {
	assert.doesNotMatch(appSource, /useState<[^>]*>\([^)]*\).*activeAgentId/);
});

// ════════════════════════════════════════════════════════════════════
// 4. Deterministic bug parity: TurnRow hook order
// ════════════════════════════════════════════════════════════════════

test("TurnRow puts all hooks before any early return", () => {
	const surfaceSource = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");

	// Find TurnRow component
	const turnRowIndex = surfaceSource.indexOf("export const TurnRow = memo(function TurnRow");
	if (turnRowIndex === -1) {
		// 多行格式：export const TurnRow = memo(\n    function TurnRow(...)
		const multiLineIndex = surfaceSource.indexOf("export const TurnRow = memo(");
		assert.notEqual(multiLineIndex, -1, "TurnRow should exist in turn/TurnRow.tsx");
	} else {
		assert.notEqual(turnRowIndex, -1, "TurnRow should exist in turn/TurnRow.tsx");
	}

	// Get the function body
	const bodyStart = surfaceSource.indexOf("{", turnRowIndex);
	let depth = 0;
	let parseIndex = bodyStart;
	for (; parseIndex < surfaceSource.length; parseIndex += 1) {
		const ch = surfaceSource[parseIndex];
		if (ch === "{") depth += 1;
		if (ch === "}") {
			depth -= 1;
			if (depth === 0) break;
		}
	}
	const body = surfaceSource.slice(bodyStart, parseIndex);

	// Find the last hook-like call (useState, useRef, useMemo, useCallback, useEffect, useAtomValue, etc.)
	// before any early return statement
	const lines = body.split("\n");
	const hookPatterns = [/\buseState\(/, /\buseRef\(/, /\buseMemo\(/, /\buseCallback\(/, /\buseEffect\(/, /\buseLayoutEffect\(/, /\buseAtomValue\(/, /\buseSetAtom\(/, /\buseStore\(/];

	let lastHookLine = -1;
	let firstEarlyReturnLine = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isHook = hookPatterns.some((p) => p.test(line));
		if (isHook) lastHookLine = i;
		if (/\breturn\s+null\b/.test(line) && firstEarlyReturnLine === -1) {
			firstEarlyReturnLine = i;
		}
	}

	if (firstEarlyReturnLine === -1) {
		// No early return — no risk of hook reordering. This is the safest case.
		assert.ok(true, "TurnRow has no early return, hook order is safe");
	} else {
		// If there IS an early return, all hooks must be before it
		assert.ok(lastHookLine < firstEarlyReturnLine, `TurnRow has hooks after early return (last hook at line ${lastHookLine}, early return at ${firstEarlyReturnLine}). This causes 'Rendered fewer hooks' crash.`);
	}
});

test("TurnRow has no hook placed after an early return", () => {
	const surfaceSource = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");

	const turnRowIndex = surfaceSource.indexOf("export const TurnRow = memo(function TurnRow");
	const bodyStart = surfaceSource.indexOf("{", turnRowIndex);
	let depth = 0;
	let parseIndex = bodyStart;
	for (; parseIndex < surfaceSource.length; parseIndex += 1) {
		const ch = surfaceSource[parseIndex];
		if (ch === "{") depth += 1;
		if (ch === "}") {
			depth -= 1;
			if (depth === 0) break;
		}
	}
	const body = surfaceSource.slice(bodyStart, parseIndex);

	// Split into lines for analysis
	const lines = body.split("\n");

	// Track hook names that appear after any early return
	const hookPatterns = [/\buseState\(/, /\buseRef\(/, /\buseMemo\(/, /\buseCallback\(/, /\buseEffect\(/, /\buseLayoutEffect\(/, /\buseAtomValue\(/, /\buseSetAtom\(/];

	let afterEarlyReturn = false;
	let violations = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/\breturn\s+null\b/.test(line)) {
			afterEarlyReturn = true;
			continue;
		}
		if (afterEarlyReturn) {
			for (const pattern of hookPatterns) {
				if (pattern.test(line)) {
					violations.push(`Line ${i}: ${line.trim()}`);
				}
			}
		}
	}

	assert.equal(violations.length, 0, `TurnRow has hooks after early return: ${violations.join("; ")}`);
});

// ════════════════════════════════════════════════════════════════════
// 5. Deterministic bug parity: idle skeleton not shown
// ════════════════════════════════════════════════════════════════════

test("deriveSessionSurfaceRuntime hides loading for idle non-activating Session", () => {
	const controllerSource = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");

	// deriveSessionSurfaceRuntime must exist
	const fnBody = functionBody("deriveSessionSurfaceRuntime", controllerSource);

	// isLoading = true only when not a known-empty draft AND messageCount===0 AND (loading...)
	// 值的表达式可能被格式化换行：容忍 isLoading: 与 !knownEmpty、&& 之间的所有空白。
	assert.match(fnBody, /isLoading:\s*!knownEmpty &&\s*messageCount\s*===\s*0/);
	assert.match(fnBody, /messageLoadStatus\s*===\s*"loading"/);
	assert.match(fnBody, /activating/);

	// isStarting 与 status==="starting" 同源：activating=true 时 status 恒为 "starting"
	assert.match(fnBody, /isStarting:\s*activating/);
	assert.match(fnBody, /const status = activating \? "starting" : runtimeStatus/);

	// idle with messages: isLoading=false, isStarting=false
	// This naturally fixes the "idle 后仍显示启动骨架" bug from dev f959ae2
});

// ════════════════════════════════════════════════════════════════════
// 6. Project toggle behavior
// ════════════════════════════════════════════════════════════════════

test("ProjectTree selects and toggles a project from its primary row", () => {
	const projectTreeSource = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");

	// The whole project row is the accordion control. This makes the state
	// discoverable and keeps projects with lazily loaded sessions operable.
	assert.match(projectTreeSource, /onClick=\{\(\) => \{[\s\S]*?props\.controller\.toggleProject\(project\.id\);[\s\S]*?props\.actions\.projects\.select\(project\.id\);[\s\S]*?\}\}/);
	assert.match(projectTreeSource, /onClick=\{\(\) => props\.controller\.toggleProject\(project\.id\)\}/);
});

// ════════════════════════════════════════════════════════════════════
// 7. Routing: no setCurrentSessionId in App
// ════════════════════════════════════════════════════════════════════

test("App never calls setCurrentSessionId directly", () => {
	assert.doesNotMatch(appSource, /setCurrentSessionId\(/);
	assert.match(appSource, /selectSessionCommand\(/);
});
