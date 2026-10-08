/** One-time local conversion of pi-context's viewer. Third-party code is not vendored or auto-enabled. */
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ADAPTERS = fileURLToPath(new URL("../resources/host-plugin-adapters/pi-context/", import.meta.url));
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** Fail before creating the output when a known upstream seam has changed. */
function replace(source, oldText, newText) {
	if (!source.includes(oldText) || source.indexOf(oldText) !== source.lastIndexOf(oldText)) throw new Error(`Unsupported pi-context viewer: expected one match for ${JSON.stringify(oldText.slice(0, 70))}`);
	return source.replace(oldText, newText);
}

/** Model rows keep a timeline entry id so "view in workbench" can jump the PiDeck timeline. */
export function adaptPiContextModel(source) {
	let output = source;
	output = replace(output, "userMsgs.push({ time: e.timestamp, text: uText.slice(0, 8000), tokens: estimateTokens(uText) });", 'userMsgs.push({ time: e.timestamp, text: uText.slice(0, 8000), tokens: estimateTokens(uText), id: typeof e.id === "string" ? e.id : undefined });');
	output = replace(output, "asstMsgs.push({ time: e.timestamp, text: aText.slice(0, 8000), tokens: estimateTokens(aText), kinds });", 'asstMsgs.push({ time: e.timestamp, text: aText.slice(0, 8000), tokens: estimateTokens(aText), kinds, id: typeof e.id === "string" ? e.id : undefined });');
	output = replace(
		output,
		'toolRes.push({ time: e.timestamp, tool: m.toolName ?? "", callId: m.toolCallId ?? "", text: c.slice(0, 8000), tokens: estimateTokens(c.slice(0, 4000)) });',
		'toolRes.push({ time: e.timestamp, tool: m.toolName ?? "", callId: m.toolCallId ?? "", text: c.slice(0, 8000), tokens: estimateTokens(c.slice(0, 4000)), id: typeof e.id === "string" ? e.id : undefined });',
	);
	return output;
}

/** Keep upstream presentation/interaction, replace only IO, navigation and refresh lifetime. */
export function adaptPiContextViewer(source) {
	let output = `import { createPiContextHost } from "./bridge.mjs";\nconst host = await createPiContextHost();\n${source}`;
	output = replace(output, "const api = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });", "const api = (p) => host.api(p);");
	output = replace(output, '.replace(/>/g, "&gt;");', '.replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\'/g, "&#39;");');
	output = replace(output, 'href="/?file=', 'href="./app.html?file=');
	output = replace(output, '      const [k, n] = loc.dataset.loc.split(":");\n      jumpTo(k, `it-${k}-${n}`);', '      const [k, n] = loc.dataset.loc.split(":");\n      host.locate?.(file, k, Number(n));\n      jumpTo(k, `it-${k}-${n}`);');
	output = replace(output, 'const file = new URLSearchParams(location.search).get("file");', 'let file = host.context.sessionId ?? new URLSearchParams(location.search).get("file");');
	output = replace(output, 'document.getElementById("live").textContent = "● 每 10 秒自动刷新";', 'document.getElementById("live").textContent = host.context.locale.startsWith("zh") ? "● 历史变更自动刷新" : "● Refresh on history changes";');
	output = replace(output, '  const renderHome = async () => {\n    if (!all) all = await api("/api/sessions");', '  const renderHome = () => host.render(async (epoch) => {\n    if (!all) all = await api("/api/sessions");\n    if (epoch !== host.revision) { all = null; return; }\n    copyStore.clear();');
	output = replace(output, "  };\n  let hTimer = 0;", "  });\n  let hTimer = 0;");
	output = replace(
		output,
		"  const renderDetail = async (keep) => {\n    app.innerHTML = detail(await api(`/api/snapshot?file=${encodeURIComponent(file)}`), file, keep);",
		"  const renderDetail = (keep) => host.render(async (epoch) => {\n    const snap = await api(`/api/snapshot?file=${encodeURIComponent(file)}`);\n    if (epoch !== host.revision) return;\n    copyStore.clear();\n    app.innerHTML = detail(snap, file, keep);",
	);
	output = replace(output, "  };\n  let dTimer = 0;", "  });\n  let dTimer = 0;");
	const ending =
		'  try {\n    if (!file) {\n      await renderHome();\n      setInterval(async () => { all = await api("/api/sessions"); if (document.activeElement?.id !== "sq") renderHome(); }, 10000);\n      return;\n    }\n    await renderDetail();\n    setInterval(() => { if (document.activeElement?.tagName !== "INPUT") renderDetail({ q: document.getElementById("q")?.value ?? "", ts: toolSort }); }, 10000);\n  } catch (e) {\n    app.innerHTML = `<p class="note">加载失败：${esc(e.message)}</p>`;\n  }';
	output = replace(
		output,
		ending,
		`  let dirty = false;
  const refresh = async () => {
    all = null;
    if (file) await renderDetail({ q: document.getElementById("q")?.value ?? "", ts: toolSort });
    else await renderHome();
  };
  host.onChange(async (scopeChanged) => {
    if (scopeChanged) {
      file = host.context.sessionId;
      selReq = viewReq = 0;
      state.q = ""; state.dir = "全部"; state.heatDay = "";
      bq = {}; fq = ""; trendHi = fpHi = null; openCats.clear();
      app.replaceChildren();
    }
    if (!scopeChanged && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) { dirty = true; return; }
    dirty = false;
    await refresh();
  });
  app.addEventListener("focusout", () => { if (dirty) { dirty = false; void refresh(); } });
  document.querySelector("header a").addEventListener("click", (event) => { event.preventDefault(); file = null; selReq = viewReq = 0; void refresh(); });
  app.addEventListener("click", (event) => {
    const link = event.target.closest("a.scard");
    if (!link) return;
    event.preventDefault();
    file = new URL(link.href).searchParams.get("file");
    selReq = viewReq = 0;
    void refresh();
  });
  window.addEventListener("pagehide", () => { clearTimeout(hTimer); clearTimeout(dTimer); }, { once: true });
  await refresh();`,
	);
	return output;
}

async function boundedSource(root, asset) {
	let path = root;
	for (const part of asset.split("/")) {
		path = join(path, part);
		if ((await lstat(path)).isSymbolicLink()) throw new Error("Source symlinks are not supported");
	}
	const handle = await open(path, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_SOURCE_BYTES) throw new Error("Source file exceeds the conversion limit");
		const bytes = Buffer.alloc(info.size + 1);
		const result = await handle.read(bytes, 0, bytes.length, 0);
		if (result.bytesRead !== info.size) throw new Error("Source changed during conversion");
		return bytes.subarray(0, info.size).toString("utf8").replace(/\r\n/g, "\n");
	} finally {
		await handle.close();
	}
}

/** Transpile only the pure fold: never execute imports, npm scripts, or pi-context/index.ts. */
function compileModel(source) {
	const parsed = ts.createSourceFile("model.ts", source, ts.ScriptTarget.Latest, true);
	const forbidden = (node) => ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier) || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")));
	const inspect = (node) => {
		if (forbidden(node)) throw new Error("Only pi-context's import-free model is supported");
		ts.forEachChild(node, inspect);
	};
	inspect(parsed);
	const result = ts.transpileModule(source, { fileName: "model.ts", compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
	if (result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error("pi-context model cannot be transpiled");
	return result.outputText;
}

/** Destination must be new, preserving existing plugin packages and their consent identity. */
export async function convertPiContext(sourceDirectory, outputDirectory) {
	const source = await realpath(resolve(sourceDirectory));
	const output = resolve(outputDirectory);
	const rel = relative(source, output);
	if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) throw new Error("Output must be outside the pi-context source directory");
	const files = new Map();
	const pkg = JSON.parse(await boundedSource(source, "package.json"));
	if (pkg.name !== "pi-context" || typeof pkg.version !== "string") throw new Error("Expected a local pi-context package");
	const viewer = await boundedSource(source, "viewer/public/app.js");
	const html = await boundedSource(source, "viewer/public/app.html");
	files.set("app.js", adaptPiContextViewer(viewer));
	const modelSource = await boundedSource(source, "src/model.ts");
	// 先做 import/AST 门禁再打 seam 补丁：上游引入后端依赖时，报错必须指向 import 而不是 seam 变化。
	compileModel(modelSource);
	files.set("model.mjs", compileModel(adaptPiContextModel(modelSource)));
	files.set("app.html", replace(replace(replace(html, 'href="/"', 'href="./app.html"'), '<main id="app">', '<aside id="host-note" role="status"></aside>\n<main id="app">'), '<script src="app.js"></script>', '<script type="module" src="app.js"></script>'));
	const appearance =
		'\n/* PiDeck tokens affect this isolated page only, never host workbench CSS. */\n:root { color-scheme: dark; }\n:root[data-host-theme="light"] { color-scheme: light; }\nbody { background: var(--color-bg-app, #1a1b26); color: var(--color-text-primary, #c0caf5); }\nheader, .card, .panel, .kpic { background: var(--color-bg-panel, #24283b); border-color: var(--color-border-default, #414868); }\n#host-note { padding: 10px 16px; border-bottom: 1px solid var(--color-border-default, #414868); font-size: 12px; overflow-wrap: anywhere; }\n';
	files.set("styles.css", (await boundedSource(source, "viewer/public/styles.css")) + appearance);
	files.set("NOTICE", await boundedSource(source, "viewer/NOTICE"));
	for (const asset of ["data.mjs", "bridge.mjs", "worker.mjs"]) files.set(asset, await boundedSource(ADAPTERS, asset));
	files.set(
		"pideck-plugin.json",
		JSON.stringify(
			{
				schemaVersion: 1,
				apiVersion: 1,
				id: "pi-context",
				name: "pi-context",
				version: `${pkg.version}-pideck.1`,
				description: "Local pi-context viewer adaptation. Historical estimates only; no pi runtime or HTTP server.",
				permissions: ["sessions.read", "workbench.navigate"],
				contributes: { panels: [{ id: "context", title: "Context viewer", entry: "app.html" }], commands: [{ id: "context.open", title: "Open context viewer", panelId: "context" }] },
			},
			null,
			2,
		) + "\n",
	);
	await mkdir(dirname(output), { recursive: true });
	await mkdir(output);
	for (const [asset, content] of files) await writeFile(join(output, asset), content, { encoding: "utf8", flag: "wx" });
	return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [source, output] = process.argv.slice(2);
	if (!source || !output) {
		process.stderr.write('Usage: node scripts/convert-pi-context-host-plugin.mjs "<pi-context directory>" "<new host-plugins/pi-context directory>"\n');
		process.exitCode = 1;
	} else {
		try {
			process.stdout.write(`Created disabled local plugin: ${await convertPiContext(source, output)}\nRescan and explicitly enable it in PiDeck Settings → Extensions → Desktop plugins.\n`);
		} catch (error) {
			process.stderr.write(`Conversion failed: ${error.message}\n`);
			process.exitCode = 1;
		}
	}
}
