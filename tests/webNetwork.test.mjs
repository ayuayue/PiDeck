import assert from "node:assert/strict";
import test from "node:test";
import { listWebNetworkAddresses } from "../src/main/web/WebNetwork.ts";

test("listWebNetworkAddresses filters loopback and sorts private LAN addresses first", () => {
	const result = listWebNetworkAddresses({
		WiFi: [
			{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "", internal: true, cidr: "127.0.0.1/8" },
			{ address: "192.168.1.23", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "192.168.1.23/24" },
		],
		VPN: [
			{ address: "100.64.0.8", netmask: "255.192.0.0", family: "IPv4", mac: "", internal: false, cidr: "100.64.0.8/10" },
			{ address: "10.0.0.12", netmask: "255.0.0.0", family: "IPv4", mac: "", internal: false, cidr: "10.0.0.12/8" },
		],
		IPv6: [{ address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "fe80::1/64" }],
	});

	assert.deepEqual(
		result.map(({ address }) => address),
		["10.0.0.12", "192.168.1.23", "100.64.0.8"],
	);
	assert.equal(result[0].interfaceName, "VPN");
	assert.equal(result[0].isPrivate, true);
	assert.equal(result[0].family, "IPv4");
	assert.equal(result[2].isPrivate, false);
	assert.equal(result[2].family, "IPv4");
	assert.equal(
		result.some(({ address }) => address === "127.0.0.1"),
		false,
	);
});

test("listWebNetworkAddresses includes global unicast IPv6 and excludes reserved ranges", () => {
	const result = listWebNetworkAddresses({
		WiFi: [
			{ address: "192.168.1.23", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "192.168.1.23/24" },
			{ address: "2001:db8::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "2001:db8::1/64" },
			{ address: "fd00::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "fd00::1/64" },
			{ address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "fe80::1/64" },
			{ address: "ff02::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "ff02::1/64" },
			{ address: "::", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "::/128" },
			{ address: "::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: true, cidr: "::1/128" },
		],
	});

	assert.deepEqual(
		result.map(({ address }) => address),
		["192.168.1.23", "2001:db8::1"],
	);
	assert.equal(result[1].family, "IPv6");
	assert.equal(result[1].isPrivate, false);
	assert.equal(
		result.some(({ address }) => address === "fd00::1" || address === "fe80::1" || address === "ff02::1" || address === "::" || address === "::1"),
		false,
	);
});

test("listWebNetworkAddresses sorts multiple IPv6 addresses after IPv4 and in address order", () => {
	const result = listWebNetworkAddresses({
		WiFi: [
			{ address: "192.168.1.23", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "192.168.1.23/24" },
			{ address: "2001:db8::10", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "2001:db8::10/64" },
			{ address: "2001:db8::2", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "2001:db8::2/64" },
		],
	});

	assert.deepEqual(
		result.map(({ address }) => address),
		["192.168.1.23", "2001:db8::2", "2001:db8::10"],
	);
	assert.deepEqual(
		result.map(({ family }) => family),
		["IPv4", "IPv6", "IPv6"],
	);
});

test("listWebNetworkAddresses deduplicates IPv6 addresses across virtual adapters", () => {
	const result = listWebNetworkAddresses({
		WiFi: [{ address: "2001:db8::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "2001:db8::1/64" }],
		Ethernet: [{ address: "2001:db8::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "2001:db8::1/64" }],
	});

	assert.equal(result.length, 1);
	assert.equal(result[0].address, "2001:db8::1");
	assert.equal(result[0].family, "IPv6");
});

test("listWebNetworkAddresses deduplicates addresses across virtual adapters", () => {
	const result = listWebNetworkAddresses({
		Ethernet: [{ address: "172.20.1.5", netmask: "255.255.0.0", family: "IPv4", mac: "", internal: false, cidr: "172.20.1.5/16" }],
		Bridge: [{ address: "172.20.1.5", netmask: "255.255.0.0", family: "IPv4", mac: "", internal: false, cidr: "172.20.1.5/16" }],
	});

	assert.equal(result.length, 1);
	assert.equal(result[0].address, "172.20.1.5");
});
