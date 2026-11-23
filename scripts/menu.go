// Interactive development menu and command dispatch.
package main

import (
	"fmt"
	"strconv"
	"strings"
)

func (h *helper) menu() {
	for {
		h.printHeader("PiDeck V2 助手")
		h.printItems([]item{
			{"1", "桌面开发（热重载）", "go tool nsgo dev"},
			{"2", "开发 Android 真机/模拟器", "go tool nsgo dev -target android"},
			{"3", "手机页桌面预览", "PIDECK_V2_MOBILE=1 go tool nsgo dev"},
			{"4", "浏览器端预览", "go tool nsgo dev -target web"},
			{"5", "构建当前平台", "go tool nsgo build -target " + hostTarget()},
			{"6", "构建指定平台…", "macos / linux / android / ios / web"},
			{"7", "构建全部发布目标", "六个桌面目标，不含安装器"},
			{"8", "打包当前平台", "便携 zip + 安装器，给用户下载的那两个"},
			{"9", "生成浏览器页面并打包桌面端", "web 资源进 webassets/site，浏览器打开链接才有页面"},
			{"10", "Android 模拟器与 APK…", "启动、装包、状态、连接链接"},
			{"11", "测试", "go tool nsgo test"},
			{"12", "环境检查", "go tool nsgo doctor"},
			{"13", "打开发布产物目录", "dist/releases"},
			{"0", "退出", ""},
		})

		choice, ok := h.ask("\n选择 [0-13]： ")
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
			if err := h.pack(hostTarget()); err != nil {
				h.report(err)
			}
		case "9":
			if err := h.web(); err != nil {
				h.report(err)
			}
		case "10":
			h.androidMenu()
		case "11":
			h.test()
		case "12":
			h.doctor()
		case "13":
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
	fmt.Print(`PiDeck V2 开发助手

  go run ./scripts                    打开菜单（推荐）
  go run ./scripts dev                桌面热重载
  go run ./scripts dev android        Android 真机或模拟器
  go run ./scripts dev web            浏览器端预览（在浏览器里热重载）
  go run ./scripts preview            手机页桌面预览
  go run ./scripts build [目标]       构建；省略目标时用当前平台
  go run ./scripts build all          六个发布目标各构建一次
  go run ./scripts pack [目标]        构建并打包：便携 zip，以及装了 NSIS 时的安装器
  go run ./scripts android up         启动模拟器（已在跑则跳过）
  go run ./scripts android app        构建 x86_64 包、安装、打开
  go run ./scripts android arm64      构建真机用的 arm64 包
  go run ./scripts android install    安装 dist 里已有的 APK
  go run ./scripts android status     设备、AVD 和桌面端连接状态
  go run ./scripts android link       复制模拟器要用的连接链接
  go run ./scripts test               无头 UI 与端到端测试
  go run ./scripts web                构建浏览器端：页面进 webassets/site/，再编带页面的桌面程序
  go run ./scripts doctor             检查 adb / NDK / Xcode / 模拟器

构建目标：windows_x64 windows_arm64 macos_arm64 macos_x64 linux_x64
          linux_arm64 android_arm64 android_x64 ios_simulator web
`)
}
