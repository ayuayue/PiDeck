// Manage Android devices, emulator setup and installation.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

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
