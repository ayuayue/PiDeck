#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Keep the default target local, while allowing a reference checkout to run the
// exact same fixture for visual parity evidence.
const repoRoot = resolve(process.env.PIDECK_REPO_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(join(repoRoot, "package.json"));
const WebSocket = require("ws");

function option(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function options(name) {
	return process.argv.flatMap((value, index) => (value === name && process.argv[index + 1] ? [process.argv[index + 1]] : []));
}

function requiredOption(name) {
	const value = option(name);
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForCdp(port, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
			if (target) return target;
		} catch {
			// The Electron renderer has not exposed CDP yet.
		}
		await sleep(250);
	}
	throw new Error(`Electron did not expose a CDP page on port ${port}`);
}

async function connectCdp(target) {
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	let nextId = 1;
	const pending = new Map();
	const rejectPending = (cause) => {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		for (const request of pending.values()) request.reject(error);
		pending.clear();
	};
	socket.on("message", (raw) => {
		const message = JSON.parse(String(raw));
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.error) request.reject(new Error(JSON.stringify(message.error)));
		else request.resolve(message.result);
	});
	socket.on("close", () => rejectPending(new Error("CDP connection closed")));
	socket.on("error", (error) => rejectPending(error));
	await new Promise((resolveOpen, rejectOpen) => {
		socket.once("open", resolveOpen);
		socket.once("error", rejectOpen);
	});
	return {
		command(method, params = {}) {
			const id = nextId++;
			return new Promise((resolveCommand, rejectCommand) => {
				pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
				socket.send(JSON.stringify({ id, method, params }));
			});
		},
		close() {
			socket.close();
		},
	};
}

async function evaluate(cdp, expression) {
	const result = await cdp.command("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
		userGesture: true,
	});
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.text ?? "CDP evaluation failed");
	}
	return result.result?.value;
}

async function clickMountedElement(cdp, selector, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const clicked = await evaluate(
			cdp,
			`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    })()`,
		);
		if (clicked) return;
		await sleep(150);
	}
	throw new Error(`Could not find visual-parity click target: ${selector}`);
}

async function waitForMountedWorkbench(cdp) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const mounted = await evaluate(cdp, "!document.getElementById('boot-overlay') && Boolean(document.querySelector('.chat-list-pane, .app-shell, .sidebar'))");
		if (mounted) return;
		await sleep(200);
	}
	throw new Error("Renderer workbench remained hidden behind its startup overlay");
}

function scenarioTitle(scenario) {
	if (scenario === "A3") return "Native 100 messages";
	if (scenario === "A4") return "Native 1000 messages";
	if (scenario === "A5") return "Native 10000 messages";
	if (scenario === "A6") return "Native 50 MiB session";
	return null;
}

function scenarioPort(scenario) {
	const numeric = Number(scenario.slice(1));
	if (!Number.isInteger(numeric)) throw new Error(`Invalid scenario: ${scenario}`);
	return 9400 + numeric;
}

function builtElectronExecutable(root) {
	const executable = process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
	return join(root, "node_modules", "electron", "dist", executable);
}

function builtLaunchEnvironment() {
	const env = { ...process.env };
	delete env.ELECTRON_RENDERER_URL;
	return env;
}

async function copyTemplate(manifest, scenario, runDir) {
	const templateName = manifest.scenarios[scenario]?.userDataTemplate;
	const template = manifest.userData[templateName];
	if (!template) throw new Error(`Missing user-data template for ${scenario}`);
	const userData = join(runDir, "user-data");
	const injected = join(runDir, "injected-user-data");
	await mkdir(userData, { recursive: true });
	await mkdir(injected, { recursive: true });
	const primary = scenario === "A7" ? template.catalog.corrupt : template.catalog.primary;
	const sources = [
		{ source: template.settings, name: "settings.json" },
		{ source: template.projects, name: "projects.json" },
		{ source: primary, name: "session-catalog.json" },
		{ source: template.catalog.backup, name: "session-catalog.json.bak" },
	];
	for (const { source, name } of sources) {
		const destination = join(userData, name);
		await cp(source, destination, { force: true });
		await cp(source, join(injected, name), { force: true });
	}
	return { template, userData, injected };
}

async function stopChildTree(child) {
	if (child.exitCode !== null) return;
	if (process.platform === "win32") {
		await new Promise((resolveStop) => {
			const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
			killer.once("exit", resolveStop);
			killer.once("error", resolveStop);
		});
		return;
	}
	child.kill("SIGTERM");
}

async function waitForChildExit(child, timeoutMs = 5_000) {
	if (child.exitCode !== null) return;
	await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), sleep(timeoutMs)]);
}

async function closeElectronGracefully(cdp) {
	if (!cdp) return;
	try {
		// Electron can detach its browser descendants from electron-vite's process
		// tree on Windows. Closing through CDP gives Chromium a chance to shut down
		// those descendants before taskkill becomes the fallback.
		await cdp.command("Browser.close");
	} catch {
		// A failed CDP close still falls through to the process-tree cleanup below.
	} finally {
		cdp.close();
	}
}

async function copyWithRetry(source, destination, attempts = 5) {
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			await cp(source, destination, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = error && typeof error === "object" ? error.code : undefined;
			if (code !== "EBUSY" || attempt === attempts) throw error;
			await sleep(attempt * 250);
		}
	}
}

const FINAL_USER_DATA_EVIDENCE = ["settings.json", "projects.json", "session-catalog.json", "session-catalog.json.bak", "logs"];

async function copyFinalUserDataEvidence(userData, destination) {
	await mkdir(destination, { recursive: true });
	// Chromium cache and storage files are neither application state nor stable
	// test evidence. Copying them makes teardown exceed the test timeout on Windows.
	for (const entry of FINAL_USER_DATA_EVIDENCE) {
		try {
			await copyWithRetry(join(userData, entry), join(destination, entry));
		} catch (error) {
			if (error && typeof error === "object" && error.code === "ENOENT") continue;
			throw error;
		}
	}
}

function parseJson(text, label) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${String(error)}`);
	}
}

async function countJsonlMessages(filePath) {
	const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
	let count = 0;
	for (const line of lines) {
		if (parseJson(line, filePath).type === "message") count += 1;
	}
	return count;
}

function assertScenario({ scenario, manifest, observed, recoveredCatalog }) {
	const errors = [];
	const expected = manifest.scenarios[scenario];
	const selectedTitle = scenarioTitle(scenario);
	const selectedRecord = selectedTitle ? observed.catalog.find((record) => record.title === selectedTitle) : undefined;

	if (selectedTitle && !selectedRecord) errors.push(`Catalog did not contain ${selectedTitle}`);
	if (selectedRecord && observed.selectedSessionTitle !== selectedTitle) {
		errors.push(`UI selected ${observed.selectedSessionTitle ?? "nothing"}, expected ${selectedTitle}`);
	}
	if (scenario === "A3" && (observed.fileMessageCount !== 100 || observed.loadedMessageCount !== 100)) {
		errors.push("A3 message count mismatch");
	}
	if (scenario === "A4" && (observed.fileMessageCount !== 1000 || observed.visibleMessageRows <= 100)) {
		errors.push("A4 pagination did not load an additional page");
	}
	if (scenario === "A5") {
		if (observed.fileMessageCount !== 10000 || observed.visibleMessageRows <= 100) {
			errors.push("A5 fixture or pagination mismatch");
		}
		if (observed.runtimes.filter((runtime) => runtime.sessionId === selectedRecord?.id).length > 1) {
			errors.push("A5 created duplicate runtimes for one Session");
		}
	}
	if (scenario === "A6") {
		if (selectedRecord?.filePath !== expected.sessionPath) errors.push("A6 selected an unexpected session file");
		if (observed.fileBytes !== manifest.scale.large.bytes) errors.push("A6 session byte size mismatch");
		if (observed.errorBoundary) errors.push("A6 rendered an application error boundary");
	}
	if (scenario === "A7") {
		const backup = parseJson(manifest.__nativeBackup, "A7 fixture backup");
		if (!Array.isArray(recoveredCatalog?.sessions) || recoveredCatalog.sessions.length !== backup.sessions.length) {
			errors.push("A7 did not recover the backup catalog entries");
		}
	}
	if (scenario === "A8") {
		const paths = expected.sessionPaths.map((path) => path.toLowerCase());
		const catalogPaths = observed.catalog.map((record) => String(record.filePath ?? "").toLowerCase());
		if (catalogPaths.filter((path) => paths.includes(path)).length !== 2) {
			errors.push("A8 should retain one folded native Session and one imported Session");
		}
	}
	if (scenario === "A9") {
		const records = observed.catalog.filter((record) => expected.sessionPaths.includes(record.filePath));
		if (records.length !== 2 || new Set(records.map((record) => record.filePath)).size !== 2) {
			errors.push("A9 did not preserve two case-sensitive WSL Session paths");
		}
		if (records.some((record) => record.environment !== "wsl" || record.wslDistro !== manifest.wslIdentity.distro || record.wslUser !== manifest.wslIdentity.user)) {
			errors.push("A9 WSL Session identity metadata mismatch");
		}
	}
	return errors;
}

async function run() {
	const scenario = requiredOption("--scenario");
	const evidence = resolve(requiredOption("--evidence"));
	const useBuiltApp = process.argv.includes("--built");
	const captureOnly = process.argv.includes("--capture-only");
	const clickSelectors = options("--click-selector");
	const sendText = option("--send-text");
	if (sendText !== undefined && !captureOnly) {
		throw new Error("--send-text is only supported with --capture-only");
	}
	if (sendText !== undefined && !sendText.trim()) {
		throw new Error("--send-text must not be empty");
	}
	const captureWaitMs = Number(option("--capture-wait-ms") ?? 0);
	if (!Number.isSafeInteger(captureWaitMs) || captureWaitMs < 0 || captureWaitMs > 60_000) {
		throw new Error("--capture-wait-ms must be an integer between 0 and 60000");
	}
	const manifestPath = join(evidence, "fixtures", "fixture-manifest.json");
	const manifest = parseJson(await readFile(manifestPath, "utf8"), "fixture manifest");
	if (!manifest.scenarios[scenario]) throw new Error(`Unknown fixture scenario: ${scenario}`);
	if (scenario === "A10") throw new Error("A10 is a generator dry run, not an Electron scenario");

	const runDir = join(evidence, "runs", `${scenario}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	const logsDir = join(runDir, "logs");
	const screenshotsDir = join(runDir, "screenshots");
	await mkdir(logsDir, { recursive: true });
	await mkdir(screenshotsDir, { recursive: true });
	await cp(manifestPath, join(runDir, "fixture-manifest.json"), { force: true });
	const { template, userData } = await copyTemplate(manifest, scenario, runDir);
	manifest.__nativeBackup = await readFile(template.catalog.backup, "utf8");

	const port = Number(option("--port") ?? scenarioPort(scenario));
	const selectionTimeoutMs = Number(option("--selection-timeout-ms") ?? 30_000);
	if (!Number.isSafeInteger(selectionTimeoutMs) || selectionTimeoutMs < 1_000) {
		throw new Error("--selection-timeout-ms must be an integer of at least 1000");
	}
	const launch = useBuiltApp
		? {
				command: builtElectronExecutable(repoRoot),
				args: [join(repoRoot, "out", "main", "index.js"), `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
				env: builtLaunchEnvironment(),
			}
		: {
				command: process.execPath,
				args: ["scripts/dev.js", "--", `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
				env: process.env,
			};
	const command = `${launch.command} ${launch.args.join(" ")}`;
	await writeFile(join(runDir, "command.txt"), `${command}\n`, "utf8");
	const child = spawn(launch.command, launch.args, {
		cwd: repoRoot,
		env: launch.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout = await import("node:fs").then(({ createWriteStream }) => createWriteStream(join(logsDir, "electron.stdout.log")));
	const stderr = await import("node:fs").then(({ createWriteStream }) => createWriteStream(join(logsDir, "electron.stderr.log")));
	child.stdout.pipe(stdout);
	child.stderr.pipe(stderr);

	let cdp;
	let report;
	try {
		const target = await waitForCdp(port);
		cdp = await connectCdp(target);
		await cdp.command("Runtime.enable");
		await cdp.command("Page.enable");
		await waitForMountedWorkbench(cdp);
		if (captureOnly) {
			const clicked = [];
			for (const clickSelector of clickSelectors) {
				await clickMountedElement(cdp, clickSelector);
				clicked.push(clickSelector);
				await sleep(500);
			}
			let sendDispatched = false;
			if (sendText !== undefined) {
				const deadline = Date.now() + 15_000;
				let inputFocused = false;
				while (!inputFocused && Date.now() < deadline) {
					inputFocused = await evaluate(
						cdp,
						`(() => {
            const input = document.querySelector('.composer [contenteditable="true"]');
            if (!(input instanceof HTMLElement)) return false;
            input.focus();
            return document.activeElement === input;
          })()`,
					);
					if (!inputFocused) await sleep(150);
				}
				if (!inputFocused) throw new Error("Could not focus the fixture composer");
				// A trusted CDP insertion follows the same input path as a real user. A
				// synthetic InputEvent changes contentEditable DOM but React intentionally
				// does not treat it as a composer-state update.
				await cdp.command("Input.insertText", { text: sendText });
				await sleep(150);
				sendDispatched = await evaluate(
					cdp,
					`(() => {
          const send = document.querySelector('.composer button.btn-circle.send');
          if (!(send instanceof HTMLElement)) return false;
          send.click();
          return true;
        })()`,
				);
				if (!sendDispatched) throw new Error("Could not enter and submit the fixture message");
			}
			// Reference and candidate can settle asynchronous catalog work at different
			// times. This keeps parity captures deterministic without altering runtime behavior.
			if (captureWaitMs > 0) await sleep(captureWaitMs);
			const sessionDiagnostics = await evaluate(
				cdp,
				`(async () => {
        const sessions = window.piDesktop?.sessions;
        if (
          !sessions ||
          typeof sessions.listCatalog !== "function" ||
          typeof sessions.listRuntimes !== "function"
        ) {
          return { supported: false };
        }
        try {
          const [catalog, runtimes] = await Promise.all([
            sessions.listCatalog("builtin-chat"),
            sessions.listRuntimes(),
          ]);
          return {
            supported: true,
            chatCatalogCount: catalog.filter((record) => record.projectId === "builtin-chat").length,
            runtimeCount: runtimes.length,
          };
        } catch (error) {
          return {
            supported: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        })()`,
			);
			const agentStartObserved =
				sendText === undefined
					? false
					: (await Promise.all((await readdir(join(userData, "logs")).catch(() => [])).filter((name) => name.startsWith("app-") && name.endsWith(".log")).map((name) => readFile(join(userData, "logs", name), "utf8").catch(() => "")))).some((text) => text.includes('"message":"Pi process spawned"'));
			const observed = await evaluate(
				cdp,
				`(() => ({
        buttons: [...document.querySelectorAll("button")].slice(0, 80).map((button) => ({
          className: button.className,
          title: button.getAttribute("title"),
          ariaLabel: button.getAttribute("aria-label"),
          text: button.textContent?.trim().slice(0, 80) ?? "",
        })),
        modalClasses: [...document.querySelectorAll(".modal-backdrop, .picker-backdrop, .drawer-surface, .terminal-dock")]
          .map((element) => element.className),
        modalLayouts: [".settings-modal", ".config-modal"].map((selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return { selector, present: false };
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            selector,
            present: true,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            top: Math.round(rect.top),
            left: Math.round(rect.left),
          };
        }),
        chatSurfaceVisible: Boolean(document.querySelector(".chat-header, .composer-area")),
        composerSessionId: document.querySelector(".composer[data-session-id]")?.getAttribute("data-session-id") ?? null,
        text: document.body.innerText.slice(0, 1200),
      }))()`,
			);
			const screenshot = await cdp.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
			await writeFile(join(screenshotsDir, "workbench.png"), Buffer.from(screenshot.data, "base64"));
			if (sendText !== undefined) {
				if (sessionDiagnostics.chatCatalogCount !== 1 || !agentStartObserved) {
					throw new Error(`First send expected exactly one Chat Session and a pi spawn, got ${JSON.stringify({ sessionDiagnostics, agentStartObserved })}`);
				}
				if (observed.composerSessionId === "renderer:chat-bootstrap") {
					throw new Error("First send did not promote the renderer-only Chat Session");
				}
			}
			report = {
				scenario,
				port,
				target: target.url,
				captureOnly,
				clickSelectors,
				captureWaitMs,
				sendDispatched,
				agentStartObserved,
				sessionDiagnostics,
				observed,
			};
			await writeFile(join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
			return;
		}
		const title = scenarioTitle(scenario);
		const expectedPath = manifest.scenarios[scenario].sessionPath ?? null;
		const observed = await evaluate(
			cdp,
			`(async () => {
      const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
      document.querySelector('[aria-label="Close"]')?.click();
      const projects = await window.piDesktop.projects.list();
      const project = projects.find((item) => item.id !== 'builtin-chat');
      if (!project) return { error: 'fixture project was not loaded' };
      document.querySelector('.project-group:not(.chat-project-group) .conversation')?.click();
      await wait(600);
      const catalog = await window.piDesktop.sessions.listCatalog(project.id);
      const expectedPath = ${JSON.stringify(expectedPath)};
      const title = ${JSON.stringify(title)};
      const selectionTimeoutMs = ${JSON.stringify(selectionTimeoutMs)};
      const shouldReadMessages = ${JSON.stringify(["A3", "A4", "A5"].includes(scenario))};
      const targetRecord = expectedPath ? catalog.find((record) => record.filePath === expectedPath) : (title ? catalog.find((record) => record.title === title) : null);
      let sessionMoreClicks = 0;
		let selectionClickCount = 0;
      let selectedSessionElapsedMs = null;
      let messageLoadElapsedMs = null;
      if (targetRecord) {
        const selectionStartedAt = performance.now();
        const findTargetRow = () => [...document.querySelectorAll('.session-row')]
          .find((node) => node.textContent?.includes(targetRecord.title));
        let targetRow = findTargetRow();
        while (!targetRow && sessionMoreClicks < 20) {
          const showMore = document.querySelector('.session-more-row, .worktree-sessions-more');
          if (!(showMore instanceof HTMLElement)) break;
          showMore.click();
          sessionMoreClicks += 1;
          await wait(120);
          targetRow = findTargetRow();
        }
        if (targetRow instanceof HTMLElement) {
          const deadline = performance.now() + selectionTimeoutMs;
			let nextClickAt = performance.now();
          while (performance.now() < deadline) {
			// A catalog refresh can replace a row between the first synthetic click
			// and React committing the selection. Retrying the same Session row is
			// idempotent and avoids recording an infrastructure race as a product failure.
			if (performance.now() >= nextClickAt) {
				targetRow = findTargetRow();
				if (targetRow instanceof HTMLElement) {
					targetRow.click();
					selectionClickCount += 1;
				}
				nextClickAt = performance.now() + 1_000;
			}
            const selectedTitle = document.querySelector('.chat-header .chat-title-block strong')?.textContent?.trim();
            if (selectedTitle === targetRecord.title) {
              selectedSessionElapsedMs = Math.round(performance.now() - selectionStartedAt);
              break;
            }
            await wait(150);
          }
          const messageStartedAt = performance.now();
          const messageDeadline = messageStartedAt + selectionTimeoutMs;
          while (performance.now() < messageDeadline) {
            if (document.querySelectorAll('.message-list > *').length > 0 || document.querySelector('.app-error-boundary')) {
              messageLoadElapsedMs = Math.round(performance.now() - messageStartedAt);
              break;
            }
            await wait(150);
          }
        }
      }
      const timeline = document.querySelector('.message-timeline');
      let initialVisibleMessageRows = document.querySelectorAll('.message-list > *').length;
      let loadMoreClicked = false;
      if (timeline) {
        timeline.scrollTop = 0;
        timeline.dispatchEvent(new Event('scroll'));
        const loadMore = document.querySelector('.message-timeline > div > button');
        if (loadMore && !loadMore.disabled) {
          loadMoreClicked = true;
          loadMore.click();
          for (let attempt = 0; attempt < 25; attempt += 1) {
            await wait(200);
            if (document.querySelectorAll('.message-list > *').length > initialVisibleMessageRows) break;
          }
        }
        timeline.scrollTop = timeline.scrollHeight;
        timeline.dispatchEvent(new Event('scroll'));
      }
      // Catalog list rows are intentionally lightweight; use the public Session-ID
      // reader for scale assertions so a scan projection cannot hide the JSONL data.
      const loadedMessages = shouldReadMessages && targetRecord
        ? await window.piDesktop.sessions.readRecordMessages(targetRecord.id)
        : null;
      return {
        projects,
        catalog,
        summaries: await window.piDesktop.sessions.list(project.id),
        runtimes: await window.piDesktop.sessions.listRuntimes(),
        selectedSessionTitle: document.querySelector('.chat-header .chat-title-block strong')?.textContent?.trim() ?? null,
        sessionMoreClicks,
			selectionClickCount,
        selectedSessionElapsedMs,
        messageLoadElapsedMs,
        visibleMessageRows: document.querySelectorAll('.message-list > *').length,
        initialVisibleMessageRows,
        loadMoreClicked,
        loadedMessageCount: loadedMessages?.length ?? null,
        firstLoadedMessage: loadedMessages?.[0]?.content ?? null,
        lastLoadedMessage: loadedMessages?.at(-1)?.content ?? null,
        sessionRows: document.querySelectorAll('.session-row').length,
        errorBoundary: Boolean(document.querySelector('.app-error-boundary')),
        bootOverlay: Boolean(document.getElementById('boot-overlay')),
        text: document.body.innerText.slice(0, 1200),
      };
    })()`,
		);
		if (observed.error) throw new Error(observed.error);
		const screenshot = await cdp.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
		await writeFile(join(screenshotsDir, "workbench.png"), Buffer.from(screenshot.data, "base64"));

		observed.fileBytes = expectedPath ? (await stat(expectedPath)).size : null;
		observed.fileMessageCount = expectedPath && ["A3", "A4", "A5"].includes(scenario) ? await countJsonlMessages(expectedPath) : null;
		const catalogPath = join(userData, "session-catalog.json");
		const recoveredCatalog = parseJson(await readFile(catalogPath, "utf8"), `${scenario} final catalog`);
		const errors = assertScenario({ scenario, manifest, observed, recoveredCatalog });
		report = { scenario, port, target: target.url, observed, recoveredCatalog, errors };
		await writeFile(
			join(runDir, "ids.json"),
			JSON.stringify(
				{
					scenario,
					remoteDebuggingPort: port,
					projectId: observed.projects.find((item) => item.id !== "builtin-chat")?.id ?? null,
					desktopSessionId: scenarioTitle(scenario) ? (observed.catalog.find((record) => record.title === scenarioTitle(scenario))?.id ?? null) : null,
					sessionPath: manifest.scenarios[scenario].sessionPath ?? manifest.scenarios[scenario].sessionPaths ?? null,
				},
				null,
				2,
			),
			"utf8",
		);
		await writeFile(join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
		if (errors.length > 0) throw new Error(`${scenario} assertions failed: ${errors.join("; ")}`);
	} finally {
		await closeElectronGracefully(cdp);
		await waitForChildExit(child, 2_000);
		await stopChildTree(child);
		await waitForChildExit(child);
		await copyFinalUserDataEvidence(userData, join(runDir, "final-user-data"));
		await writeFile(join(runDir, "exit-code.txt"), `${report?.errors?.length ? 1 : 0}\n`, "utf8");
	}
	console.log(JSON.stringify({ scenario, runDir, report }, null, 2));
}

run().catch((error) => {
	console.error(error.stack ?? String(error));
	process.exitCode = 1;
});
