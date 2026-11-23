import type { PiExtensionSummary } from "../../shared/types";
import { quotePosixArgument } from "../remote/RemoteBootstrapContract";
import { compareVersions } from "../utils/versionCompare";

/** Read package manifests and query npm in the SSH host's own Node/npm environment. */
export const REMOTE_EXTENSION_VERSION_SCRIPT = String.raw`
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const entries = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const npm = process.argv[2];
const deadline = Date.now() + 26000;
const results = entries.map(() => ({}));
let next = 0;
async function worker() {
  while (next < entries.length) {
    const index = next++;
    const entry = entries[index];
    if (entry.path) {
      try {
        const file = path.join(entry.path, "package.json");
        if ((await fs.stat(file)).size <= 1048576) {
          const version = JSON.parse(await fs.readFile(file, "utf8")).version;
          if (typeof version === "string" && /^[0-9A-Za-z.+_-]{1,128}$/.test(version)) results[index].currentVersion = version;
        }
      } catch {}
    }
    if (entry.packageName && Date.now() < deadline) {
      const timeout = Math.min(25000, deadline - Date.now());
      await new Promise((resolve) => execFile(process.execPath, [npm, "view", entry.packageName, "version"], { timeout, maxBuffer: 65536, env: { ...process.env, PATH: path.dirname(process.execPath) + ":" + (process.env.PATH || "") } }, (error, stdout) => {
        const version = stdout.trim();
        if (!error && /^[0-9A-Za-z.+_-]{1,128}$/.test(version)) results[index].latestVersion = version;
        resolve();
      }));
    }
  }
}
Promise.all(Array.from({ length: Math.min(6, entries.length) }, worker)).then(() => process.stdout.write(JSON.stringify(results)));
`;

type Run = (input: { hostId: string; remoteCommand: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;
type Facts = { home: string; nodePath: string };
const versionPattern = /^[0-9A-Za-z.+_-]{1,128}$/;

/** Version results are untrusted: only bounded version strings are projected onto their original rows. */
export async function enrichRemoteExtensionVersions(hostId: string, facts: Facts, extensions: PiExtensionSummary[], run: Run): Promise<PiExtensionSummary[]> {
	if (extensions.length === 0 || extensions.length > 200) return extensions;
	const entries = extensions.map((entry) => ({
		path: typeof entry.path === "string" && entry.path.startsWith("/") && entry.path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(entry.path) ? entry.path : undefined,
		packageName: /^npm:(@?[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9][a-z0-9._~-]*)?(?:@[a-z0-9][a-z0-9._~+^-]*)?)$/i.exec(entry.source)?.[1],
	}));
	const payload = Buffer.from(JSON.stringify(entries)).toString("base64");
	if (payload.length > 100000) return extensions;
	const script = Buffer.from(REMOTE_EXTENSION_VERSION_SCRIPT).toString("base64");
	const nodeDir = facts.nodePath.slice(0, facts.nodePath.lastIndexOf("/"));
	const command = "cd " + quotePosixArgument(facts.home) + " && " + [facts.nodePath, "-e", `eval(Buffer.from('${script}','base64').toString())`, payload, nodeDir + "/npm"].map(quotePosixArgument).join(" ");
	try {
		const result = await run({ hostId, remoteCommand: command, timeoutMs: 30000 });
		if (result.exitCode !== 0 || Buffer.byteLength(result.stdout, "utf8") > 128000) return extensions;
		const versions: unknown = JSON.parse(result.stdout);
		if (!Array.isArray(versions) || versions.length !== extensions.length) return extensions;
		return extensions.map((entry, index) => {
			const value: unknown = versions[index];
			if (typeof value !== "object" || value === null) return entry;
			const current = Reflect.get(value, "currentVersion");
			const latest = Reflect.get(value, "latestVersion");
			const currentVersion = typeof current === "string" && versionPattern.test(current) ? current : undefined;
			const latestVersion = typeof latest === "string" && versionPattern.test(latest) ? latest : undefined;
			return { ...entry, ...(currentVersion ? { currentVersion } : {}), ...(latestVersion ? { latestVersion } : {}), ...(currentVersion && latestVersion ? { hasUpdate: compareVersions(latestVersion, currentVersion) > 0 } : {}) };
		});
	} catch {
		return extensions;
	}
}
