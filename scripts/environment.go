// Resolve toolchains and run commands from the repository root.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func (h *helper) nsgo(args ...string) error {
	return h.runEnv(nil, "go", append([]string{"tool", "nsgo"}, args...)...)
}

func (h *helper) runEnv(env []string, name string, args ...string) error {
	line := filepath.Base(name) + " " + strings.Join(args, " ")
	if len(env) > 0 {
		line = strings.Join(env, " ") + " " + line
	}
	fmt.Printf("\n$ %s\n\n", line)

	cmd := exec.Command(name, args...)
	cmd.Dir = h.root
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	return cmd.Run()
}

func (h *helper) report(err error) {
	if err == nil {
		return
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		fmt.Printf("\n退出码 %d\n", exit.ExitCode())
		return
	}
	fmt.Printf("\n失败：%v\n", err)
}

func (h *helper) sdkDir() string {
	for _, key := range []string{"ANDROID_HOME", "ANDROID_SDK_ROOT"} {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if value := os.Getenv("LOCALAPPDATA"); value != "" {
			return filepath.Join(value, "Android", "Sdk")
		}
	case "darwin":
		return filepath.Join(home, "Library", "Android", "sdk")
	default:
		return filepath.Join(home, "Android", "Sdk")
	}
	return ""
}

func (h *helper) adb() (string, error) {
	if sdk := h.sdkDir(); sdk != "" {
		path := filepath.Join(sdk, "platform-tools", exeName("adb"))
		if exists(path) {
			return path, nil
		}
	}
	if path, err := exec.LookPath("adb"); err == nil {
		return path, nil
	}
	return "", errors.New("找不到 adb：装 Android SDK platform-tools，或设置 ANDROID_HOME")
}

func (h *helper) emulator() (string, error) {
	if sdk := h.sdkDir(); sdk != "" {
		path := filepath.Join(sdk, "emulator", exeName("emulator"))
		if exists(path) {
			return path, nil
		}
	}
	if path, err := exec.LookPath("emulator"); err == nil {
		return path, nil
	}
	return "", errors.New("找不到 Android 模拟器：用 android sdk install emulator 安装")
}

func (h *helper) readRemote() (remoteConfig, error) {
	dir := os.Getenv("PIDECK_LITE_HOME")
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return remoteConfig{}, err
		}
		dir = filepath.Join(base, h.id)
	}
	path := filepath.Join(dir, "config.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return remoteConfig{}, fmt.Errorf("先运行一次桌面端，再在「设置 → 远程」打开服务")
	}
	var cfg remoteConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return remoteConfig{}, fmt.Errorf("解析 %s 失败", path)
	}
	if !cfg.RemoteEnabled {
		return cfg, errors.New("远程服务没开：设置 → 远程 → 允许手机连接")
	}
	if cfg.RemoteToken == "" {
		return cfg, errors.New("还没有访问令牌：在「设置 → 远程」里启用一次")
	}
	return cfg, nil
}

func (h *helper) remoteLink() (string, error) {
	cfg, err := h.readRemote()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("http://10.0.2.2:%d/?token=%s", cfg.port(), url.QueryEscape(cfg.RemoteToken)), nil
}

type remoteConfig struct {
	RemoteEnabled bool   `json:"remoteEnabled"`
	RemotePort    int    `json:"remotePort"`
	RemoteToken   string `json:"remoteToken"`
}

func (c remoteConfig) port() int {
	if c.RemotePort != 0 {
		return c.RemotePort
	}
	return 8787
}

func copyText(text string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("clip")
	case "darwin":
		cmd = exec.Command("pbcopy")
	default:
		if _, err := exec.LookPath("wl-copy"); err == nil {
			cmd = exec.Command("wl-copy")
		} else if _, err := exec.LookPath("xclip"); err == nil {
			cmd = exec.Command("xclip", "-selection", "clipboard")
		} else {
			return errors.New("没有找到剪贴板工具")
		}
	}
	cmd.Stdin = strings.NewReader(text)
	return cmd.Run()
}

func exeName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func modTime(path string) time.Time {
	info, err := os.Stat(path)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}

// pad 按显示宽度补空格，中文算两格，菜单才对得齐。
func pad(text string, width int) string {
	if gap := width - displayWidth(text); gap > 0 {
		return text + strings.Repeat(" ", gap)
	}
	return text
}

func displayWidth(text string) int {
	width := 0
	for _, r := range text {
		if isWide(r) {
			width += 2
		} else {
			width++
		}
	}
	return width
}

func isWide(r rune) bool {
	switch {
	case r < 0x1100:
		return false
	case r <= 0x115f, r == 0x2329, r == 0x232a:
		return true
	case r >= 0x2e80 && r <= 0xa4cf:
		return true
	case r >= 0xac00 && r <= 0xd7a3:
		return true
	case r >= 0xf900 && r <= 0xfaff:
		return true
	case r >= 0xfe30 && r <= 0xfe6f:
		return true
	case r >= 0xff00 && r <= 0xff60:
		return true
	case r >= 0xffe0 && r <= 0xffe6:
		return true
	}
	return false
}
