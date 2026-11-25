// Build, test and package the desktop and embedded Web client.
package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/andybalholm/brotli"
)

func (h *helper) devDesktop() {
	h.report(h.nsgo("dev"))
}

func (h *helper) devTarget(target string) {
	h.report(h.nsgo("dev", "-target", target))
}

func (h *helper) devPreview() {
	h.report(h.runEnv([]string{"PIDECK_V2_MOBILE=1"}, "go", "tool", "nsgo", "dev"))
}

func (h *helper) buildTarget(target string) {
	env, note := h.webAssetEnv()
	if note != "" {
		fmt.Println(note)
	}
	if err := h.runEnv(env, "go", "tool", "nsgo", "build", "-target", target); err != nil {
		if runtime.GOOS == "windows" && strings.HasPrefix(target, "windows") {
			fmt.Println("\n提示：目标程序正在运行时 Windows 会锁住 exe；先关掉 PiDeck V2 再构建。")
		}
		h.report(err)
		return
	}
	fmt.Printf("\n完成，产物在 %s\n", filepath.Join(h.root, "dist"))
}

// webAssetEnv adds -tags=webassets when webassets/site/ exists, so a local
// build serves the browser client on the remote port like a release does.
// Without the site the tag must stay off: its embed has no files to match
// and the build would not compile.
func (h *helper) webAssetEnv() ([]string, string) {
	site := filepath.Join(h.root, "webassets", "site")
	if info, err := os.Stat(filepath.Join(site, "index.html")); err == nil && !info.IsDir() {
		flags := strings.TrimSpace(os.Getenv("GOFLAGS") + " -tags=webassets")
		return []string{"GOFLAGS=" + flags}, ""
	}
	return nil, "提示：webassets/site 不存在，本次构建不带浏览器页面（设置 → 远程 里打开链接会 404）。\n      要带上页面：先跑 go run ./scripts web"
}

func (h *helper) buildAll() {
	fmt.Println("六个发布目标逐个构建（不含安装器）；正式发布包由 CI 在各系统上生成。")
	env, note := h.webAssetEnv()
	if note != "" {
		fmt.Println(note)
	}
	var failed []string
	for _, target := range releaseTargets {
		fmt.Printf("\n== %s ==\n", target)
		if err := h.runEnv(env, "go", "tool", "nsgo", "build", "-target", target, "-installers=false"); err != nil {
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

// web 把浏览器端页面编进 webassets/site/，再编一个同时发窗口、页面和 API 的二进制：
// 浏览器的 WebAssembly 里没有进程和磁盘，pi、文件与 Git 仍由桌面端提供。wasm 先
// brotli 压缩，页面抓下来只有原体积的两成。
func (h *helper) web() error {
	if err := h.nsgo("build", "-target", "web"); err != nil {
		return err
	}
	site := filepath.Join(h.root, "dist", h.name+"-"+h.version+"-web")
	dst := filepath.Join(h.root, "webassets", "site")
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	if err := copyTree(site, dst); err != nil {
		return err
	}
	if err := compressWebAssets(dst); err != nil {
		return err
	}
	out := filepath.Join(h.root, "dist", h.name+"-web-host")
	if runtime.GOOS == "windows" {
		out += ".exe"
	}
	// The site is in place by now, so webAssetEnv adds the tag that embeds it.
	env, _ := h.webAssetEnv()
	if err := h.runEnv(env, "go", "tool", "nsgo", "build", "-target", hostTarget(), "-installers=false"); err != nil {
		return err
	}
	// Keep the helper's existing output path for callers and local scripts.
	packaged := filepath.Join(h.root, "dist", h.name+"-"+h.version+"-"+hostTarget(), h.name)
	if runtime.GOOS == "windows" {
		packaged += ".exe"
	} else if runtime.GOOS == "darwin" {
		packaged = filepath.Join(packaged+".app", "Contents", "MacOS", h.name)
	}
	data, err := os.ReadFile(packaged)
	if err != nil {
		return err
	}
	if err := os.WriteFile(out, data, 0o755); err != nil {
		return err
	}
	fmt.Printf("\n网页已嵌入。设置 → 远程开启后，浏览器打开 http://<地址>:<端口>/?token=<令牌> 即可。\n产物：%s\n", out)
	return nil
}

// compressWebAssets brotli-compresses the site's wasm and drops the original:
// the server answers <name>.wasm with the .br file, so everything embedded and
// downloaded is the compressed one. The gzip copy a web build leaves beside it
// goes too: a desktop serving the site re-encodes gzip from the .br it holds
// (internal/workbench/web_serve.go), so the file would only ever be dead weight
// in every binary that embeds the page.
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
	gz, err := filepath.Glob(filepath.Join(dir, "*.wasm.gz"))
	if err != nil {
		return err
	}
	for _, path := range gz {
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if err := os.Remove(path); err != nil {
			return err
		}
		fmt.Printf("  %s 已删（%.1f MB，服务器按需编码 gzip）\n", filepath.Base(path), float64(info.Size())/1e6)
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
