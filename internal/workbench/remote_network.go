//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"example.com/pideck-v2/internal/viewkit"
)

// withUI runs fn on the graph's goroutine, waiting briefly for it.
func (a *app) withUI(fn func()) bool {
	done := make(chan struct{})
	a.cx.Post(func() {
		defer close(done)
		fn()
	})
	select {
	case <-done:
		return true
	case <-time.After(3 * time.Second):
		return false
	}
}

// virtualIfaceWords mark an interface a virtual machine, a container or a
// VPN owns rather than the cable or the Wi-Fi the user is on. Windows
// gives vEthernet to Hyper-V and to WSL, and every VPN names its own.
var virtualIfaceWords = []string{
	"vethernet", "hyper-v", "wsl", "default switch", "virtualbox", "vmware", "docker",
	"tailscale", "zerotier", "easy tier", "easytier", "hsne", "wireguard", "tap-", "tun0",
	"virtual adapter", "vpn",
}

// virtualIface says an interface is a virtual one, not the LAN a phone
// shares with this machine.
func virtualIface(name string) bool {
	lower := strings.ToLower(name)
	for _, word := range virtualIfaceWords {
		if strings.Contains(lower, word) {
			return true
		}
	}
	return false
}

// detectLAN lists the non-loopback IPv4 addresses a phone can reach: the
// real network adapters first, so the address the phone shares a Wi-Fi with
// leads, then virtual adapters sorted last.
func detectLAN() []remoteLANAddress {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []remoteLANAddress
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipnet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || seen[ip.String()] {
				continue
			}
			seen[ip.String()] = true
			out = append(out, remoteLANAddress{Address: ip.String(), Interface: iface.Name,
				Private: privateIPv4(ip), Virtual: virtualIface(iface.Name)})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Virtual != out[j].Virtual {
			return !out[i].Virtual
		}
		if out[i].Private != out[j].Private {
			return out[i].Private
		}
		return out[i].Address < out[j].Address
	})
	return out
}

func privateIPv4(ip net.IP) bool {
	if len(ip) != 4 {
		return false
	}
	return ip[0] == 10 || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] == 192 && ip[1] == 168)
}

// probeTailscale reads the local tailnet address from the CLI.
func probeTailscale() remoteChannel {
	path := findTool("tailscale", []string{
		`C:\Program Files\Tailscale\tailscale.exe`, `C:\Program Files\Tailscale IPN\tailscale.exe`,
		"/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale",
		"/usr/bin/tailscale",
	})
	if path == "" {
		return remoteChannel{Detail: "未找到 tailscale CLI"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "status", "--json")
	hideWindow(cmd)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	out, err := cmd.Output()
	if err != nil {
		return remoteChannel{Installed: true, Error: viewkit.FirstLine(err.Error(), 160)}
	}
	var status struct {
		BackendState string `json:"BackendState"`
		Self         struct {
			TailscaleIPs []string `json:"TailscaleIPs"`
			DNSName      string   `json:"DNSName"`
		} `json:"Self"`
	}
	if json.Unmarshal(out, &status) != nil {
		return remoteChannel{Installed: true, Error: "tailscale status 没有返回 JSON"}
	}
	ip := ""
	for _, candidate := range status.Self.TailscaleIPs {
		if strings.Contains(candidate, ".") {
			ip = candidate
			break
		}
	}
	if status.BackendState != "Running" || ip == "" {
		detail := "状态：" + status.BackendState
		if status.BackendState == "" {
			detail = "tailscaled 未运行或未登录"
		}
		return remoteChannel{Installed: true, Detail: detail}
	}
	dns := strings.TrimSuffix(status.Self.DNSName, ".")
	detail := "Tailscale 已连接"
	if dns != "" {
		detail = dns
	}
	return remoteChannel{Installed: true, Ready: true, Address: ip, Detail: detail}
}

// probeEasyTier reads the virtual IPv4 of a running EasyTier node, with a
// manually entered address as the fallback.
func probeEasyTier(manual string) remoteChannel {
	manual = normalizeIPv4(manual)
	candidates := []string{
		`C:\Program Files\EasyTier\easytier-cli.exe`, `C:\Program Files\easytier\easytier-cli.exe`,
		`C:\Program Files\easytier-gui\easytier-cli.exe`,
	}
	for _, base := range []string{os.Getenv("LOCALAPPDATA"), os.Getenv("USERPROFILE"), os.Getenv("ProgramData")} {
		if base == "" {
			continue
		}
		candidates = append(candidates,
			filepath.Join(base, "Programs", "EasyTier", "easytier-cli.exe"),
			filepath.Join(base, "Microsoft", "WinGet", "Links", "easytier-cli.exe"),
			filepath.Join(base, "scoop", "shims", "easytier-cli.exe"),
			filepath.Join(base, "chocolatey", "bin", "easytier-cli.exe"))
	}
	path := findTool("easytier-cli", candidates)
	if path != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, path, "-o", "json", "node")
		hideWindow(cmd)
		if out, err := cmd.Output(); err == nil {
			if ch, ok := easyTierJSON(out); ok {
				return ch
			}
		}
		cmd = exec.CommandContext(ctx, path, "node")
		hideWindow(cmd)
		if out, err := cmd.Output(); err == nil {
			if ch, ok := easyTierTable(string(out)); ok {
				return ch
			}
		}
	}
	if manual != "" {
		return remoteChannel{Installed: path != "", Ready: true, Address: manual, Detail: "手动填写的 EasyTier 地址"}
	}
	if path == "" {
		return remoteChannel{Detail: "未找到 easytier-cli"}
	}
	return remoteChannel{Installed: true, Error: "EasyTier 节点没有运行，或 CLI 读不到虚拟地址"}
}

func easyTierJSON(out []byte) (remoteChannel, bool) {
	var value any
	if json.Unmarshal(out, &value) != nil {
		return remoteChannel{}, false
	}
	if list, ok := value.([]any); ok && len(list) > 0 {
		value = list[0]
	}
	for i := 0; i < 3; i++ {
		record, ok := value.(map[string]any)
		if !ok {
			return remoteChannel{}, false
		}
		if inner, ok := record["result"].(map[string]any); ok {
			value = inner
			continue
		}
		raw := stringField(record, "ipv4_addr", "ipv4Addr")
		ip := normalizeIPv4(raw)
		if ip == "" {
			return remoteChannel{}, false
		}
		detail := stringField(record, "hostname", "host_name")
		if version := stringField(record, "version"); version != "" {
			if detail != "" {
				detail += " · "
			}
			detail += version
		}
		if detail == "" {
			detail = "EasyTier 已连接"
		}
		return remoteChannel{Installed: true, Ready: true, Address: ip, Detail: detail}, true
	}
	return remoteChannel{}, false
}

func easyTierTable(out string) (remoteChannel, bool) {
	var ip, hostname string
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(line, "|")
		if len(fields) < 3 {
			continue
		}
		key, value := strings.TrimSpace(fields[1]), strings.TrimSpace(fields[2])
		switch key {
		case "Virtual IP":
			ip = normalizeIPv4(value)
		case "Hostname":
			hostname = value
		}
	}
	if ip == "" {
		return remoteChannel{}, false
	}
	detail := "EasyTier 已连接"
	if hostname != "" {
		detail = hostname
	}
	return remoteChannel{Installed: true, Ready: true, Address: ip, Detail: detail}, true
}

func stringField(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := record[key].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// normalizeIPv4 accepts an address with an optional CIDR suffix.
func normalizeIPv4(value string) string {
	value = strings.TrimSpace(strings.Split(value, "/")[0])
	ip := net.ParseIP(value)
	if ip == nil {
		return ""
	}
	v4 := ip.To4()
	if v4 == nil || v4.IsUnspecified() || v4.Equal(net.IPv4bcast) {
		return ""
	}
	return v4.String()
}

// findTool looks in PATH and the usual install places.
func findTool(name string, candidates []string) string {
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	if runtime.GOOS == "windows" {
		exe := name
		if filepath.Ext(exe) == "" {
			exe += ".exe"
		}
		for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")} {
			if base == "" {
				continue
			}
			for _, sub := range []string{"Programs\\EasyTier", "EasyTier", "easytier", "easytier-gui"} {
				candidates = append(candidates, filepath.Join(base, sub, exe))
			}
		}
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}
