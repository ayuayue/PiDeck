import { deflateRawSync } from "node:zlib";

/**
 * 最小 ZIP 打包器（deflate 压缩）。
 *
 * 为什么不引三方库：项目里唯一的 zip 实现（fflate）是 electron-builder 的传递依赖，
 * 不是 package.json 的直接依赖——为「导出一次日志包」把传递依赖变成生产依赖，
 * 会在依赖树变动时静默挂掉。ZIP 的 store/deflate 容器格式很稳定，用 node:zlib 自己写
 * 约 120 行，零依赖且可控。
 *
 * 只实现写、不实现读（日志包是给用户发给支持者的，应用侧不需要解析）。
 */

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
/** 版本号 20 = 需要 2.0 才能解压；deflate 压缩标记 */
const VERSION_NEEDED = 20;
const COMPRESSION_DEFLATE = 8;

export type ZipEntry = {
	/** 包内相对路径，统一用正斜杠（ZIP 规范要求） */
	name: string;
	data: Buffer;
	modifiedAt?: Date;
};

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (let index = 0; index < data.length; index += 1) {
		crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** 转成 ZIP 需要的 MS-DOS 日期时间；早于 1980 的时间会被钳到 1980-01-01。 */
function toDosDateTime(input: Date | undefined): { time: number; date: number } {
	const value = input ?? new Date();
	const year = Math.max(1980, value.getFullYear());
	return {
		time: ((value.getHours() & 0x1f) << 11) | ((value.getMinutes() & 0x3f) << 5) | (Math.floor(value.getSeconds() / 2) & 0x1f),
		date: (((year - 1980) & 0x7f) << 9) | (((value.getMonth() + 1) & 0x0f) << 5) | (value.getDate() & 0x1f),
	};
}

/** 包内路径统一正斜杠并去掉前导斜杠，避免解压后出现绝对路径逃逸。 */
export function normalizeZipEntryName(name: string): string {
	return name.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** 把若干条目打成 zip 二进制。 */
export function buildZip(entries: ZipEntry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(normalizeZipEntryName(entry.name), "utf8");
		const compressed = deflateRawSync(entry.data, { level: 6 });
		const crc = crc32(entry.data);
		const { time, date } = toDosDateTime(entry.modifiedAt);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
		local.writeUInt16LE(VERSION_NEEDED, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(COMPRESSION_DEFLATE, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, compressed);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
		central.writeUInt16LE(VERSION_NEEDED, 4);
		central.writeUInt16LE(VERSION_NEEDED, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(COMPRESSION_DEFLATE, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += local.length + name.length + compressed.length;
	}

	const centralBuffer = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuffer.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);

	return Buffer.concat([...locals, centralBuffer, end]);
}
