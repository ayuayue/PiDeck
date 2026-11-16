// PiDeck Lite 开发助手：一条命令列出开发、打包和 Android 相关的常用操作。
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
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
)

// appID 和 activity 是 adb 启动应用要用的；id 也从 nsgo.yaml 读，这里只是兜底。
const (
	fallbackID      = "dev.nsgo.pidecklite"
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
	case "android", "apk":
		sub := "menu"
		if len(args) > 1 {
			sub = args[1]
		}
		h.android(sub)
	case "test":
		h.test()
	case "web":
		h.web()
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
	name, id, version = "PiDeck Lite", fallbackID, "?"
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

// ---------- 菜单 ----------

func (h *helper) menu() {
	for {
		h.printHeader("PiDeck Lite 助手")
		h.printItems([]item{
			{"1", "桌面开发（热重载）", "go tool nsgo dev"},
			{"2", "开发 Android 真机/模拟器", "go tool nsgo dev -target android"},
			{"3", "手机页桌面预览", "PIDECK_LITE_MOBILE=1 go tool nsgo dev"},
			{"4", "浏览器端预览", "go tool nsgo dev -target web"},
			{"5", "构建当前平台", "go tool nsgo build -target " + hostTarget()},
			{"6", "构建指定平台…", "macos / linux / android / ios / web"},
			{"7", "构建全部发布目标", "六个桌面目标，不含安装器"},
			{"8", "Android 模拟器与 APK…", "启动、装包、状态、连接链接"},
			{"9", "测试", "go tool nsgo test"},
			{"10", "环境检查", "go tool nsgo doctor"},
			{"11", "打开发布产物目录", "dist/releases"},
			{"0", "退出", ""},
		})

		choice, ok := h.ask("\n选择 [0-11]： ")
		if !ok {
			fmt.Println()
			return
		}
		switch choice {
		case "1":
			h.devDesktop()
		case "2":
			h.devTarget("android")
		case "3":
			h.devPreview()
		case "4":
			h.devTarget("web")
		case "5":
			h.buildTarget(hostTarget())
		case "6":
			h.buildMenu()
		case "7":
			h.buildAll()
		case "8":
			h.androidMenu()
		case "9":
			h.test()
		case "10":
			h.doctor()
		case "11":
			h.openDist()
		case "0", "q", "quit":
			return
		case "":
			continue
		default:
			fmt.Printf("没有 %q 这个选项\n", choice)
			continue
		}
		if !h.wait() {
			return
		}
	}
}

func (h *helper) buildMenu() {
	for {
		h.printHeader("构建指定平台")
		items := make([]item, 0, len(buildTargets)+1)
		for i, target := range buildTargets {
			hint := ""
			switch {
			case target == hostTarget():
				hint = "当前平台"
			case target == "android_arm64":
				hint = "真机 APK"
			case target == "android_x64":
				hint = "模拟器 APK（需要 NDK）"
			case target == "ios_simulator":
				hint = "需要 macOS + Xcode"
			case target == "web":
				hint = "网页预览"
			}
			items = append(items, item{strconv.Itoa(i + 1), target, hint})
		}
		items = append(items, item{"0", "返回", ""})
		h.printItems(items)

		choice, ok := h.ask("\n选择目标： ")
		if !ok {
			fmt.Println()
			return
		}
		if choice == "0" {
			return
		}
		n, err := strconv.Atoi(choice)
		if err != nil || n < 1 || n > len(buildTargets) {
			fmt.Printf("没有 %q 这个选项\n", choice)
			continue
		}
		h.buildTarget(buildTargets[n-1])
		if !h.wait() {
			return
		}
	}
}

func (h *helper) androidMenu() {
	for {
		h.printHeader("Android 模拟器与 APK")
		h.printItems([]item{
			{"1", "启动模拟器", "已启动则跳过"},
			{"2", "构建 x86_64 包并安装运行", "构建 → 安装 → 打开"},
			{"3", "构建 arm64 真机包", "只构建，不安装"},
			{"4", "安装 dist 里已有的 APK…", "选文件"},
			{"5", "设备与模拟器状态", "SDK、AVD、APK、连接链接"},
			{"6", "复制模拟器连接链接", "http://10.0.2.2:<端口>/?token=…"},
			{"0", "返回", ""},
		})

		choice, ok := h.ask("\n选择 [0-6]： ")
		if !ok {
			fmt.Println()
			return
		}
		switch choice {
		case "1":
			h.report(h.startEmulator())
		case "2":
			h.buildAndRun()
		case "3":
			h.buildAPK("android_arm64")
		case "4":
			h.installMenu()
		case "5":
			h.status()
		case "6":
			h.link()
		case "0", "q":
			return
		case "":
			continue
		default:
			fmt.Printf("没有 %q 这个选项\n", choice)
			continue
		}
		if !h.wait() {
			return
		}
	}
}

func (h *helper) printHeader(title string) {
	fmt.Printf("\n%s  %s · %s\n\n", title, h.version, hostTarget())
}

func (h *helper) printItems(items []item) {
	for _, it := range items {
		if it.hint == "" {
			fmt.Printf("  %2s  %s\n", it.key, it.label)
			continue
		}
		fmt.Printf("  %2s  %s  %s\n", it.key, pad(it.label, 24), it.hint)
	}
}

func (h *helper) ask(prompt string) (string, bool) {
	fmt.Print(prompt)
	line, err := h.in.ReadString('\n')
	if err != nil && line == "" {
		return "", false
	}
	return strings.TrimSpace(line), true
}

func (h *helper) wait() bool {
	_, ok := h.ask("\n按回车返回菜单… ")
	return ok
}

func (h *helper) help() {
	fmt.Print(`PiDeck Lite 开发助手

  go run ./scripts                    打开菜单（推荐）
  go run ./scripts dev                桌面热重载
  go run ./scripts dev android        Android 真机或模拟器
  go run ./scripts dev web            浏览器端预览（在浏览器里热重载）
  go run ./scripts preview            手机页桌面预览
  go run ./scripts build [目标]       构建；省略目标时用当前平台
  go run ./scripts build all          六个发布目标各构建一次
  go run ./scripts android up         启动模拟器（已在跑则跳过）
  go run ./scripts android app        构建 x86_64 包、安装、打开
  go run ./scripts android arm64      构建真机用的 arm64 包
  go run ./scripts android install    安装 dist 里已有的 APK
  go run ./scripts android status     设备、AVD 和桌面端连接状态
  go run ./scripts android link       复制模拟器要用的连接链接
  go run ./scripts test               无头 UI 与端到端测试
  go run ./scripts web                构建浏览器端：页面进 webassets/，再编带页面的桌面程序
  go run ./scripts doctor             检查 adb / NDK / Xcode / 模拟器

构建目标：windows_x64 windows_arm64 macos_arm64 macos_x64 linux_x64
          linux_arm64 android_arm64 android_x64 ios_simulator web
`)
}

// ---------- 开发与构建 ----------

func (h *helper) devDesktop() {
	h.report(h.nsgo("dev"))
}

func (h *helper) devTarget(target string) {
	h.report(h.nsgo("dev", "-target", target))
}

func (h *helper) devPreview() {
	h.report(h.runEnv([]string{"PIDECK_LITE_MOBILE=1"}, "go", "tool", "nsgo", "dev"))
}

func (h *helper) buildTarget(target string) {
	if err := h.nsgo("build", "-target", target); err != nil {
		if runtime.GOOS == "windows" && strings.HasPrefix(target, "windows") {
			fmt.Println("\n提示：目标程序正在运行时 Windows 会锁住 exe；先关掉 PiDeck Lite 再构建。")
		}
		h.report(err)
		return
	}
	fmt.Printf("\n完成，产物在 %s\n", filepath.Join(h.root, "dist"))
}

func (h *helper) buildAll() {
	fmt.Println("六个发布目标逐个构建（不含安装器）；正式发布包由 CI 在各系统上生成。")
	var failed []string
	for _, target := range releaseTargets {
		fmt.Printf("\n== %s ==\n", target)
		if err := h.nsgo("build", "-target", target, "-installers=false"); err != nil {
			failed = append(failed, target)
		}
	}
	fmt.Println()
	if len(failed) == 0 {
		fmt.Printf("全部完成，产物在 %s\n", filepath.Join(h.root, "dist"))
		return
	}
	fmt.Printf("完成 %d/%d，失败：%s\n", len(releaseTargets)-len(failed), len(releaseTargets), strings.Join(failed, ", "))
	fmt.Println("跨平台构建依赖各平台工具链，失败的目标交给 CI 即可。")
}

func (h *helper) test() {
	h.report(h.nsgo("test"))
}

// web 把浏览器端页面编进 webassets/，再编一个同时发窗口、页面和 API 的二进制：
// 浏览器的 WebAssembly 里没有进程和磁盘，pi、文件与 Git 仍由桌面端提供。wasm 先
// brotli 压缩，页面抓下来只有原体积的两成。
func (h *helper) web() {
	if err := h.nsgo("build", "-target", "web"); err != nil {
		h.report(err)
		return
	}
	site := filepath.Join(h.root, "dist", h.name+"-"+h.version+"-web")
	dst := filepath.Join(h.root, "webassets")
	if err := os.RemoveAll(dst); err != nil {
		h.report(err)
		return
	}
	if err := copyTree(site, dst); err != nil {
		h.report(err)
		return
	}
	if err := compressWebAssets(dst); err != nil {
		h.report(err)
		return
	}
	out := filepath.Join(h.root, "dist", h.name+"-web-host")
	if runtime.GOOS == "windows" {
		out += ".exe"
	}
	if err := h.runEnv(nil, "go", "build", "-tags", "webassets", "-o", out, "."); err != nil {
		h.report(err)
		return
	}
	fmt.Printf("\n网页已嵌入。设置 → 远程开启后，浏览器打开 http://<地址>:<端口>/?token=<令牌> 即可。\n产物：%s\n", out)
}

// compressWebAssets brotli-compresses the site's wasm and drops the original:
// the server answers <name>.wasm with the .br file, so everything embedded and
// downloaded is the compressed one.
func compressWebAssets(dir string) error {
	files, err := filepath.Glob(filepath.Join(dir, "*.wasm"))
	if err != nil {
		return err
	}
	for _, path := range files {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var buf bytes.Buffer
		w := brotli.NewWriterLevel(&buf, 9)
		if _, err := w.Write(data); err != nil {
			return err
		}
		if err := w.Close(); err != nil {
			return err
		}
		if err := os.WriteFile(path+".br", buf.Bytes(), 0o644); err != nil {
			return err
		}
		if err := os.Remove(path); err != nil {
			return err
		}
		fmt.Printf("  %s → %.1f MB（%.1f MB）\n", filepath.Base(path), float64(buf.Len())/1e6, float64(len(data))/1e6)
	}
	return nil
}

// copyTree 把一个目录复制到另一个，文件逐个来；发布目录不大，够用。
func copyTree(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

func (h *helper) doctor() {
	h.report(h.nsgo("doctor"))
}

func (h *helper) openDist() {
	dir := filepath.Join(h.root, "dist", "releases")
	if !exists(dir) {
		dir = filepath.Join(h.root, "dist")
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	if err := cmd.Start(); err != nil {
		fmt.Printf("打不开 %s：%v\n", dir, err)
		return
	}
	fmt.Printf("已打开 %s\n", dir)
}

// ---------- Android ----------

func (h *helper) android(sub string) {
	switch sub {
	case "menu":
		h.androidMenu()
	case "up", "start":
		h.report(h.startEmulator())
	case "app", "run":
		h.buildAndRun()
	case "arm64":
		h.buildAPK("android_arm64")
	case "install":
		h.installMenu()
	case "status":
		h.status()
	case "link":
		h.link()
	default:
		fmt.Fprintf(os.Stderr, "未知的 android 操作 %q（可用：up、app、arm64、install、status、link）\n", sub)
		os.Exit(1)
	}
}

func (h *helper) buildAndRun() {
	apk, err := h.buildAndroid("android_x64")
	if err != nil {
		h.report(err)
		return
	}
	if err := h.installAPK(apk); err != nil {
		h.report(err)
		return
	}
	fmt.Printf("\n已在设备上打开 %s（%s）\n", h.name, filepath.Base(apk))
}

func (h *helper) buildAPK(target string) {
	apk, err := h.buildAndroid(target)
	if err != nil {
		h.report(err)
		return
	}
	fmt.Printf("\n完成：%s\n", apk)
}

func (h *helper) buildAndroid(target string) (string, error) {
	if err := h.nsgo("build", "-target", target, "-installers=false"); err != nil {
		return "", fmt.Errorf("构建 %s 失败", target)
	}
	suffix := "-android-" + strings.TrimPrefix(target, "android_") + ".apk"
	apk := h.newest(filepath.Join(h.root, "dist", "releases", "*"+suffix))
	if apk == "" {
		return "", fmt.Errorf("构建结束了，但 dist/releases 里没有 *%s", suffix)
	}
	return apk, nil
}

func (h *helper) installMenu() {
	apks := h.apks()
	if len(apks) == 0 {
		fmt.Println("dist/releases 里还没有 APK：先用菜单 7 → 2 构建一个。")
		return
	}
	fmt.Println("dist 里的 APK（新的在前）：")
	items := make([]item, 0, len(apks))
	for i, apk := range apks {
		items = append(items, item{strconv.Itoa(i + 1), filepath.Base(apk), ""})
	}
	h.printItems(items)

	choice, ok := h.ask("\n安装哪个 [1]： ")
	if !ok {
		return
	}
	n := 1
	if choice != "" {
		parsed, err := strconv.Atoi(choice)
		if err != nil || parsed < 1 || parsed > len(apks) {
			fmt.Printf("没有 %q 这个 APK\n", choice)
			return
		}
		n = parsed
	}
	h.report(h.installAPK(apks[n-1]))
}

func (h *helper) installAPK(apk string) error {
	adb, err := h.adb()
	if err != nil {
		return err
	}
	device, err := h.pickDevice()
	if err != nil {
		return err
	}
	if err := h.runEnv(nil, adb, "-s", device, "install", "-r", "-t", apk); err != nil {
		return errors.New("安装失败：模拟器要 android_x64 包，真机要 android_arm64 包")
	}
	_ = h.runEnv(nil, adb, "-s", device, "shell", "am", "force-stop", h.id)
	if err := h.runEnv(nil, adb, "-s", device, "shell", "am", "start", "-n", h.id+"/"+activity); err != nil {
		return errors.New("装好了，但没启动起来：检查设备是否解锁")
	}
	return nil
}

func (h *helper) startEmulator() error {
	adb, err := h.adb()
	if err != nil {
		return err
	}
	if devices := h.devices(); len(devices) > 0 {
		fmt.Printf("设备已在运行：%s\n", strings.Join(devices, ", "))
		return nil
	}

	avd, err := h.pickAVD()
	if err != nil {
		return err
	}
	emulator, err := h.emulator()
	if err != nil {
		return err
	}

	cmd := exec.Command(emulator, "-avd", avd, "-no-boot-anim")
	cmd.Dir = h.root
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动模拟器失败：%w", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	fmt.Printf("正在启动模拟器 %s（冷启动可能要一两分钟）", avd)
	deadline := time.Now().Add(emulatorTimeout)
	for tick := 1; ; tick++ {
		select {
		case err := <-done:
			fmt.Println()
			if err != nil {
				return fmt.Errorf("模拟器退出了（%v）。手动运行看原因：\n  %q -avd %s", err, emulator, avd)
			}
			return fmt.Errorf("模拟器退出了。手动运行看原因：\n  %q -avd %s", emulator, avd)
		case <-time.After(2 * time.Second):
		}

		if time.Now().After(deadline) {
			fmt.Println()
			_ = cmd.Process.Kill()
			return fmt.Errorf("等了 %s 还没启动完，已经结束它；手动运行 %q -avd %s 检查", emulatorTimeout, emulator, avd)
		}
		for _, device := range h.devices() {
			out, _ := exec.Command(adb, "-s", device, "shell", "getprop", "sys.boot_completed").Output()
			if strings.TrimSpace(string(out)) == "1" {
				fmt.Printf("\n模拟器已就绪：%s\n", device)
				return nil
			}
		}
		if tick%5 == 0 {
			fmt.Print(".")
		}
	}
}

func (h *helper) status() {
	row := func(key, value string) { fmt.Printf("%s  %s\n", pad(key, 8), value) }

	sdk := h.sdkDir()
	if sdk == "" {
		row("SDK", "未找到；设置 ANDROID_HOME，或把 SDK 放在默认位置")
	} else {
		row("SDK", sdk)
	}
	if adb, err := h.adb(); err == nil {
		row("ADB", adb)
	} else {
		row("ADB", "未找到（装 platform-tools 或设置 ANDROID_HOME）")
	}
	if emulator, err := h.emulator(); err == nil {
		row("模拟器", emulator)
	} else {
		row("模拟器", "未找到（装 Android SDK emulator）")
	}
	if devices := h.devices(); len(devices) > 0 {
		row("设备", strings.Join(devices, ", "))
	} else {
		row("设备", "无（先运行 go run ./scripts android up）")
	}
	if avds := h.avds(); len(avds) > 0 {
		row("AVD", strings.Join(avds, ", "))
	} else {
		row("AVD", "无")
	}
	if apks := h.apks(); len(apks) > 0 {
		row("APK", filepath.Base(apks[0]))
	} else {
		row("APK", "dist/releases 里还没有")
	}
	if cfg, err := h.readRemote(); err == nil {
		row("桌面端", fmt.Sprintf("http://10.0.2.2:%d（远程已开启）", cfg.port()))
	} else {
		row("桌面端", err.Error())
	}
}

func (h *helper) link() {
	link, err := h.remoteLink()
	if err != nil {
		h.report(err)
		return
	}
	fmt.Println(link)
	if err := copyText(link); err != nil {
		fmt.Println("复制到剪贴板失败，手动复制上面的地址。")
		return
	}
	fmt.Println("已复制。在模拟器里粘贴到地址栏，点「连接」；令牌框可以留空。")
}

func (h *helper) devices() []string {
	adb, err := h.adb()
	if err != nil {
		return nil
	}
	out, err := exec.Command(adb, "devices").Output()
	if err != nil {
		return nil
	}
	var devices []string
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == "device" {
			devices = append(devices, fields[0])
		}
	}
	return devices
}

func (h *helper) pickDevice() (string, error) {
	devices := h.devices()
	switch len(devices) {
	case 0:
		return "", errors.New("没有已连接的设备：先启动模拟器（go run ./scripts android up）")
	case 1:
		return devices[0], nil
	}
	items := make([]item, 0, len(devices))
	for i, device := range devices {
		items = append(items, item{strconv.Itoa(i + 1), device, ""})
	}
	fmt.Println("已连接的设备：")
	h.printItems(items)
	choice, ok := h.ask("\n用哪个设备 [1]： ")
	if !ok {
		return "", errors.New("没有选择设备")
	}
	n := 1
	if choice != "" {
		parsed, err := strconv.Atoi(choice)
		if err != nil || parsed < 1 || parsed > len(devices) {
			return "", fmt.Errorf("没有 %q 这个设备", choice)
		}
		n = parsed
	}
	return devices[n-1], nil
}

func (h *helper) avds() []string {
	emulator, err := h.emulator()
	if err != nil {
		return nil
	}
	out, err := exec.Command(emulator, "-list-avds").Output()
	if err != nil {
		return nil
	}
	var avds []string
	for _, line := range strings.Split(string(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			avds = append(avds, line)
		}
	}
	return avds
}

func (h *helper) pickAVD() (string, error) {
	avds := h.avds()
	switch len(avds) {
	case 0:
		return "", errors.New("没有可用的 AVD：按 README 的「装 Android 模拟器」先建一个")
	case 1:
		return avds[0], nil
	}
	for _, avd := range avds {
		if avd == preferredAVD {
			return avd, nil
		}
	}
	items := make([]item, 0, len(avds))
	for i, avd := range avds {
		items = append(items, item{strconv.Itoa(i + 1), avd, ""})
	}
	fmt.Println("可用的 AVD：")
	h.printItems(items)
	choice, ok := h.ask("\n用哪个 AVD [1]： ")
	if !ok {
		return "", errors.New("没有选择 AVD")
	}
	n := 1
	if choice != "" {
		parsed, err := strconv.Atoi(choice)
		if err != nil || parsed < 1 || parsed > len(avds) {
			return "", fmt.Errorf("没有 %q 这个 AVD", choice)
		}
		n = parsed
	}
	return avds[n-1], nil
}

func (h *helper) apks() []string {
	files, _ := filepath.Glob(filepath.Join(h.root, "dist", "releases", "*.apk"))
	if len(files) == 0 {
		files, _ = filepath.Glob(filepath.Join(h.root, "dist", "*", "*.apk"))
	}
	sort.Slice(files, func(i, j int) bool { return modTime(files[i]).After(modTime(files[j])) })
	return files
}

func (h *helper) newest(pattern string) string {
	files, _ := filepath.Glob(pattern)
	best := ""
	for _, file := range files {
		if best == "" || modTime(file).After(modTime(best)) {
			best = file
		}
	}
	return best
}

// ---------- 环境 ----------

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

// ---------- 小工具 ----------

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
