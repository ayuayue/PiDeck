//go:build !js

package main

// Where agents run. A target is this machine, a WSL distribution, or a host
// over SSH; it decides how pi is spawned and where its sessions live. The
// rest of the app only ever asks a target to build a command, so nothing
// else needs to know how the process gets there.

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// targetKind is where the agent runs.
type targetKind int

const (
	targetLocal targetKind = iota
	targetWSL
	targetSSH
)

// target is one place agents can run.
type target struct {
	Kind   targetKind
	Distro string // WSL distribution
	Host   string // SSH host, user@host allowed
}

// localTarget is this machine.
var localTarget = target{}

// key is the target's stable name, "" for this machine.
func (t target) key() string {
	switch t.Kind {
	case targetWSL:
		return "wsl:" + t.Distro
	case targetSSH:
		return "ssh:" + t.Host
	}
	return ""
}

// label names the target in the UI.
func (t target) label() string {
	switch t.Kind {
	case targetWSL:
		return "WSL · " + t.Distro
	case targetSSH:
		return "SSH · " + t.Host
	}
	return "本机"
}

// remote reports whether the target is somewhere else.
func (t target) remote() bool { return t.Kind != targetLocal }

// shortLabel is the badge a workspace or session shows.
func (t target) shortLabel() string {
	switch t.Kind {
	case targetWSL:
		return "WSL"
	case targetSSH:
		return "SSH"
	}
	return ""
}

// remoteDir is where pi keeps a remote target's sessions: the app's own
// folder under the target user's home, expanded by its shell.
const remoteDir = `$HOME/.pideck-lite/sessions`

// command builds the process that runs pi with args in dir, for a session
// named by id in the app's store, or for an existing session file.
func (t target) command(piPath, dir, appSessions, id, sessionFile string, args []string) (*exec.Cmd, error) {
	all := append([]string{}, args...)
	if sessionFile != "" {
		all = append(all, "--session", sessionFile)
	} else {
		folder := appSessions
		if t.remote() {
			folder = remoteDir
		}
		all = append(all, "--session-dir", folder)
		if id != "" {
			all = append(all, "--session-id", id)
		}
	}
	switch t.Kind {
	case targetLocal:
		var cmd *exec.Cmd
		if isBatch(piPath) {
			// A .cmd shim has no process image of its own; cmd.exe runs it.
			cmd = exec.Command("cmd.exe", "/d", "/s", "/c", batchLine(piPath, all))
		} else {
			cmd = exec.Command(piPath, all...)
		}
		cmd.Dir = dir
		hideWindow(cmd)
		return cmd, nil
	case targetWSL:
		if runtime.GOOS != "windows" {
			return nil, fmt.Errorf("WSL 只能在 Windows 上使用")
		}
		script := "exec " + shellJoin(append([]string{"pi"}, all...))
		cmd := exec.Command("wsl.exe", "-d", t.Distro, "--cd", dir, "--", "sh", "-lc", script)
		hideWindow(cmd)
		return cmd, nil
	default:
		script := "cd " + shellQuote(dir) + " && exec " + shellJoin(append([]string{"pi"}, all...))
		cmd := exec.Command("ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", t.Host, script)
		hideWindow(cmd)
		return cmd, nil
	}
}

// openFile builds a command that opens a path in the target's file manager.
func (t target) openFile(path string) error {
	switch t.Kind {
	case targetWSL:
		cmd := exec.Command("wsl.exe", "-d", t.Distro, "--", "explorer.exe", path)
		hideWindow(cmd)
		return cmd.Start()
	case targetSSH:
		return fmt.Errorf("SSH 目标不能在远端打开文件")
	}
	return nil
}

// isBatch reports whether a path is a cmd.exe script.
func isBatch(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".cmd", ".bat":
		return true
	}
	return false
}

// batchLine is path and its arguments as cmd.exe takes them.
func batchLine(path string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	for _, p := range append([]string{path}, args...) {
		parts = append(parts, `"`+strings.ReplaceAll(p, `"`, `""`)+`"`)
	}
	return strings.Join(parts, " ")
}

// shellQuote quotes s for a POSIX shell.
func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	if !strings.ContainsAny(s, " \t\n'\"\\$&|;<>()*?[]#~!`") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// shellJoin quotes each word and joins them.
func shellJoin(words []string) string {
	quoted := make([]string, len(words))
	for i, w := range words {
		quoted[i] = shellQuote(w)
	}
	return strings.Join(quoted, " ")
}

// parseTarget turns a workspace's stored target key back into a target.
func parseTarget(key string) target {
	switch {
	case strings.HasPrefix(key, "wsl:"):
		return target{Kind: targetWSL, Distro: strings.TrimPrefix(key, "wsl:")}
	case strings.HasPrefix(key, "ssh:"):
		return target{Kind: targetSSH, Host: strings.TrimPrefix(key, "ssh:")}
	}
	return localTarget
}

// wslDistro is one WSL distribution, and whether pi answers inside it.
type wslDistro struct {
	Name   string
	PiPath string
	Error  string
}

// sshHost is one host from the ssh config, and whether pi answers there.
type sshHost struct {
	Name   string
	PiPath string
	Error  string
}

// envInfo is what the app knows about the machines it can run on. It is
// probed off the UI thread and read by the settings page.
type envInfo struct {
	PiPath         string
	PiVersion      string
	PiError        string
	SessionsDir    string // pi's own sessions, for browsing
	AppDir         string
	WSL            []wslDistro
	SSH            []sshHost
	Probed         bool
	Probing        bool
	TargetsProbing bool
}

// piSessionsDir is where pi keeps its sessions, without starting anything.
func piSessionsDir() string {
	if dir := os.Getenv("PI_CODING_AGENT_SESSION_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".pi", "agent", "sessions")
}

// probeLocal finds pi here: its path, its version, where its sessions are.
func probeLocal(info envInfo) envInfo {
	info.SessionsDir = piSessionsDir()
	info.Probing = false
	info.Probed = true
	path, version, err := probePi("", "")
	if err != nil {
		info.PiError = err.Error()
	}
	info.PiPath, info.PiVersion = path, version
	return info
}

// probeTargets finds pi in each WSL distribution and on each SSH host.
func probeTargets(info envInfo) envInfo {
	info.WSL = nil
	info.SSH = nil
	info.TargetsProbing = false
	if runtime.GOOS == "windows" {
		for _, d := range listWSL() {
			distro := wslDistro{Name: d}
			if p, v, err := probePi("wsl", d); err != nil {
				distro.Error = err.Error()
			} else {
				distro.PiPath = p + " · " + v
			}
			info.WSL = append(info.WSL, distro)
		}
	}
	for _, h := range sshHosts() {
		host := sshHost{Name: h}
		if p, v, err := probePi("ssh", h); err != nil {
			host.Error = firstLine(err.Error(), 120)
		} else {
			host.PiPath = p + " · " + v
		}
		info.SSH = append(info.SSH, host)
	}
	info.Probing = false
	info.Probed = true
	return info
}

// probeEnv finds pi here and everywhere else, as a convenience for tools
// that want the whole picture at once.
func probeEnv(appDir string) envInfo {
	info := probeLocal(envInfo{AppDir: appDir, Probing: true})
	return probeTargets(info)
}

// probePi finds pi's path and version on a target, "this machine" when
// kind is empty.
func probePi(kind, where string) (path, version string, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	script := "command -v pi && pi --version"
	switch kind {
	case "wsl":
		cmd = exec.CommandContext(ctx, "wsl.exe", "-d", where, "--", "sh", "-lc", script)
	case "ssh":
		cmd = exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-T", where, script)
	default:
		p, e := resolvePi()
		if e != nil {
			return "", "", e
		}
		path = p
		if isBatch(p) {
			cmd = exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", batchLine(p, []string{"--version"}))
		} else {
			cmd = exec.CommandContext(ctx, p, "--version")
		}
	}
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if ee, ok := err.(*exec.ExitError); ok {
			if s := strings.TrimSpace(string(ee.Stderr)); s != "" {
				msg = s
			}
		}
		if msg == "" {
			msg = err.Error()
		}
		return "", "", fmt.Errorf("%s", firstLine(msg, 200))
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	version = strings.TrimSpace(lines[len(lines)-1])
	if path == "" && len(lines) > 1 {
		path = strings.TrimSpace(lines[0])
	}
	if path == "" {
		path = "pi"
	}
	return path, version, nil
}

// resolvePi finds pi on this machine: an executable first, then a cmd
// shim.
func resolvePi() (string, error) {
	if p, err := exec.LookPath("pi.exe"); err == nil {
		return p, nil
	}
	if p, err := exec.LookPath("pi"); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("找不到 pi 命令：请把 pi 放进 PATH")
}

// listWSL lists the WSL distributions this machine has.
func listWSL() []string {
	if runtime.GOOS != "windows" {
		return nil
	}
	cmd := exec.Command("wsl.exe", "-l", "-q")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	// WSL writes UTF-16LE; the NULs are the giveaway.
	text := strings.ReplaceAll(string(out), "\x00", "")
	var names []string
	for _, line := range strings.Split(text, "\n") {
		name := strings.TrimSpace(line)
		if name == "" || strings.Contains(name, "docker-desktop") {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// sshHosts lists the hosts in the user's ssh config that look usable.
func sshHosts() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	f, err := os.Open(filepath.Join(home, ".ssh", "config"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var hosts []string
	seen := map[string]bool{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(strings.ToLower(line), "host ") {
			continue
		}
		for _, h := range strings.Fields(line)[1:] {
			if strings.ContainsAny(h, "*?!") || seen[h] {
				continue
			}
			seen[h] = true
			hosts = append(hosts, h)
		}
	}
	sort.Strings(hosts)
	return hosts
}
