// PiDeck V2 开发助手：一条命令列出开发、打包和 Android 相关的常用操作。
//
// 不带参数时打开菜单，挑一个数字就行：
//
//	go run ./scripts
//
// 也可以直接跑某一步：
//
//	go run ./scripts dev                 桌面热重载
//	go run ./scripts dev android         Android 真机或模拟器
//	go run ./scripts dev web             浏览器端预览
//	go run ./scripts build               构建当前平台
//	go run ./scripts build macos_arm64   构建指定目标
//	go run ./scripts build all           六个发布目标各构建一次
//	go run ./scripts android up          启动模拟器（已在跑则跳过）
//	go run ./scripts android app         构建 x86_64 包、安装到模拟器并打开
//	go run ./scripts android arm64       构建真机用的 arm64 包
//	go run ./scripts android install     安装 dist 里已有的 APK
//	go run ./scripts android status      设备、AVD 和桌面端连接状态
//	go run ./scripts android link        复制模拟器要用的连接链接
//	go run ./scripts test                无头 UI 与端到端测试
//	go run ./scripts doctor              检查 adb / NDK / Xcode / 模拟器
package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// appID 和 activity 是 adb 启动应用要用的；id 也从 nsgo.yaml 读，这里只是兜底。
const (
	fallbackID      = "dev.nsgo.pideckv2"
	activity        = "dev.oneo.nsgo.NsgoActivity"
	preferredAVD    = "medium_phone"
	emulatorTimeout = 4 * time.Minute
)

// releaseTargets 是 CI 发布作业构建的六个桌面目标，顺序跟 release.yml 一致。
var releaseTargets = []string{
	"windows_x64", "windows_arm64",
	"macos_arm64", "macos_x64",
	"linux_x64", "linux_arm64",
}

// buildTargets 是菜单里可选的构建目标。
var buildTargets = []string{
	"windows_x64", "windows_arm64",
	"macos_arm64", "macos_x64",
	"linux_x64", "linux_arm64",
	"android_arm64", "android_x64",
	"ios_simulator", "web",
}

type helper struct {
	root    string
	name    string
	version string
	id      string
	in      *bufio.Reader
}

type item struct {
	key   string
	label string
	hint  string
}

func main() {
	h, err := newHelper()
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误：", err)
		os.Exit(1)
	}

	args := os.Args[1:]
	if len(args) == 0 {
		h.menu()
		return
	}

	switch args[0] {
	case "menu":
		h.menu()
	case "dev":
		if len(args) > 1 {
			h.devTarget(args[1])
		} else {
			h.devDesktop()
		}
	case "preview", "mobile":
		h.devPreview()
	case "build":
		target := hostTarget()
		if len(args) > 1 {
			target = args[1]
		}
		if target == "all" {
			h.buildAll()
		} else {
			h.buildTarget(target)
		}
	case "pack", "package":
		target := hostTarget()
		if len(args) > 1 {
			target = args[1]
		}
		if err := h.pack(target); err != nil {
			h.report(err)
			os.Exit(1)
		}
	case "android", "apk":
		sub := "menu"
		if len(args) > 1 {
			sub = args[1]
		}
		h.android(sub)
	case "test":
		h.test()
	case "web":
		if err := h.web(); err != nil {
			h.report(err)
			os.Exit(1)
		}
	case "doctor":
		h.doctor()
	case "dist":
		h.openDist()
	case "help", "-h", "--help":
		h.help()
	default:
		fmt.Fprintf(os.Stderr, "未知命令 %q。运行 go run ./scripts help 看全部命令。\n", args[0])
		os.Exit(1)
	}
}

func newHelper() (*helper, error) {
	root, err := findRoot()
	if err != nil {
		return nil, err
	}
	name, id, version := readManifest(root)
	return &helper{
		root:    root,
		name:    name,
		version: version,
		id:      id,
		in:      bufio.NewReader(os.Stdin),
	}, nil
}

// findRoot 先按源码位置找，再按当前目录往上找 nsgo.yaml。
func findRoot() (string, error) {
	if _, file, _, ok := runtime.Caller(0); ok {
		dir := filepath.Dir(filepath.Dir(file))
		if abs, err := filepath.Abs(dir); err == nil && exists(filepath.Join(abs, "nsgo.yaml")) {
			return abs, nil
		}
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if exists(filepath.Join(dir, "nsgo.yaml")) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", errors.New("找不到 nsgo.yaml：请在仓库里运行")
}

// readManifest 从 nsgo.yaml 顶层读名字、id 和版本，读不到就用兜底值。
func readManifest(root string) (name, id, version string) {
	name, id, version = "PiDeck V2", fallbackID, "?"
	raw, err := os.ReadFile(filepath.Join(root, "nsgo.yaml"))
	if err != nil {
		return name, id, version
	}
	for _, line := range strings.Split(string(raw), "\n") {
		switch {
		case strings.HasPrefix(line, "name:"):
			name = strings.TrimSpace(strings.TrimPrefix(line, "name:"))
		case strings.HasPrefix(line, "id:"):
			id = strings.TrimSpace(strings.TrimPrefix(line, "id:"))
		case strings.HasPrefix(line, "version:"):
			version = strings.TrimSpace(strings.TrimPrefix(line, "version:"))
		}
	}
	return name, id, version
}

func hostTarget() string {
	arch := runtime.GOARCH
	switch arch {
	case "amd64":
		arch = "x64"
	case "386":
		arch = "x86"
	}
	switch runtime.GOOS {
	case "windows":
		return "windows_" + arch
	case "darwin":
		return "macos_" + arch
	case "linux":
		return "linux_" + arch
	}
	return runtime.GOOS + "_" + arch
}
