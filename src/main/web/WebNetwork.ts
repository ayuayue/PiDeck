import { isIPv4 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { WebNetworkAddress } from "../../shared/types";

type NetworkInterfaceMap = Record<string, NetworkInterfaceInfo[] | undefined>;

function isPrivateIpv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return false;
	}
	const [first, second] = parts;
	return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/** 判断 IPv6 地址是否属于不对外发布的保留范围：链路本地、ULA、组播、未指定与环回。 */
function isExcludedIpv6(address: string): boolean {
	if (address === "::" || address === "::1") return true;
	const firstPart = address.split(":")[0];
	if (!firstPart) return true;
	const value = Number.parseInt(firstPart, 16);
	if (Number.isNaN(value)) return true;
	// fe80::/10 (fe80–febf)、fc00::/7 (fc00–fdff)、ff00::/8 (ff00–ffff)
	return (value >= 0xfe80 && value <= 0xfebf) || (value >= 0xfc00 && value <= 0xfdff) || (value >= 0xff00 && value <= 0xffff);
}

/**
 * 枚举所有非回环 IPv4 网卡与全局单播 IPv6 网卡，局域网地址排在前面。
 * 机器同时连接 Wi-Fi、网线、VPN 或虚拟网卡时，调用方可让用户切换具体入口。
 */
export function listWebNetworkAddresses(interfaces: NetworkInterfaceMap = networkInterfaces()): WebNetworkAddress[] {
	const addresses: WebNetworkAddress[] = [];
	const seen = new Set<string>();

	for (const [interfaceName, entries] of Object.entries(interfaces)) {
		for (const entry of entries ?? []) {
			const address = entry.address.trim();
			if (seen.has(address)) continue;

			if (isIPv4(address) && !entry.internal) {
				seen.add(address);
				addresses.push({
					address,
					interfaceName,
					cidr: typeof entry.cidr === "string" ? entry.cidr : null,
					isPrivate: isPrivateIpv4(address),
					family: "IPv4",
				});
			} else if (entry.family === "IPv6" && !entry.internal && !isExcludedIpv6(address)) {
				seen.add(address);
				addresses.push({
					address,
					interfaceName,
					cidr: typeof entry.cidr === "string" ? entry.cidr : null,
					isPrivate: false,
					family: "IPv6",
				});
			}
		}
	}

	return addresses.sort((left, right) => {
		// IPv4 始终排在 IPv6 之前。
		if (left.family !== right.family) return left.family === "IPv4" ? -1 : 1;
		// 同族时私网 IPv4 优先；IPv6 统一 isPrivate=false，直接按地址排序。
		if (left.isPrivate !== right.isPrivate) return left.isPrivate ? -1 : 1;
		return left.address.localeCompare(right.address, undefined, { numeric: true });
	});
}
