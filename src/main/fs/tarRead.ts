/**
 * tar 读取的共享实现（纯解析，无 IO）。
 *
 * 两个消费者：
 * - `plugins/hostPluginGitHub.ts`：GitHub 插件仓库 tarball（只挑出 pideck-plugin.json 包根）；
 * - `feishu/feishuSdkRuntime.ts`：随包分发的飞书 SDK tar.gz，首次启用时解压到 userData。
 *
 * 设计约束（与 host plugin 归档一致）：只认常规文件，目录/链接/设备文件一律跳过；
 * 路径做穿越校验（`..`、绝对路径、空段全部拒绝）。尺寸上界由调用方在解压前卡住，
 * 这里再校验一次 tar 头里声明的长度不会越过缓冲，避免恶意头把子缓冲越界。
 */

export type TarFileEntry = { path: string; bytes: Buffer };

function normalizeEntryPath(path: string): string | null {
	const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "." || part.length === 0)) return null;
	return normalized;
}

function readString(buffer: Buffer, offset: number, length: number): string {
	const slice = buffer.subarray(offset, offset + length);
	const end = slice.indexOf(0);
	return (end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
}

function readOctalSize(header: Buffer): number {
	const raw = readString(header, 124, 12).trim();
	if (!/^[0-7]+$/.test(raw)) throw new Error("archive-invalid");
	return Number.parseInt(raw, 8);
}

/** pax 扩展头（typeflag `x`）：长路径与 UTF-8 名走这里，格式是 `<len> <key>=<value>\n`。 */
function readPaxPath(data: Buffer): string | undefined {
	const text = data.toString("utf8");
	let cursor = 0;
	let path: string | undefined;
	while (cursor < text.length) {
		const space = text.indexOf(" ", cursor);
		if (space < 0) break;
		const length = Number.parseInt(text.slice(cursor, space), 10);
		if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > text.length) break;
		const record = text.slice(space + 1, cursor + length - 1);
		const eq = record.indexOf("=");
		if (eq > 0 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
		cursor += length;
	}
	return path;
}

/**
 * 解析 tar：只认常规文件，目录/链接/设备文件一律跳过（链接指向包外，不可能成为可服务资产）。
 * 尺寸与缓冲上界由调用方在解压时先卡住，这里再校验一次头里声明的长度不会越过缓冲。
 */
export function readTarFiles(tar: Buffer): TarFileEntry[] {
	const files: TarFileEntry[] = [];
	let offset = 0;
	let pendingPath: string | undefined;
	let pendingLongName: string | undefined;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = readString(header, 0, 100);
		const prefix = readString(header, 345, 155);
		const size = readOctalSize(header);
		const type = String.fromCharCode(header[156] ?? 0);
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;
		if (dataEnd > tar.length) throw new Error("archive-invalid");
		const data = tar.subarray(dataStart, dataEnd);
		offset = dataStart + Math.ceil(size / 512) * 512;
		if (type === "x") {
			pendingPath = readPaxPath(data) ?? pendingPath;
			continue;
		}
		if (type === "L") {
			const end = data.indexOf(0);
			pendingLongName = (end === -1 ? data : data.subarray(0, end)).toString("utf8");
			continue;
		}
		// 全局 pax（g）与链接目标（K）对文件内容没有影响，跳过即可。
		if (type === "g" || type === "K") continue;
		const full = pendingLongName ?? pendingPath ?? (prefix.length > 0 && !name.startsWith(prefix) ? `${prefix}/${name}` : name);
		pendingLongName = undefined;
		pendingPath = undefined;
		if (type !== "0" && type !== "\u0000" && type !== "7") continue;
		const path = normalizeEntryPath(full);
		if (path) files.push({ path, bytes: Buffer.from(data) });
	}
	return files;
}
