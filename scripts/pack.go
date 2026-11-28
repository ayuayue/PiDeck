// Package a built desktop target for users: a portable zip, and the Windows
// installer NSIS compiles.
package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// pack builds a desktop target and puts beside it what a user downloads: a
// portable zip of the package directory, and the NSIS installer when
// makensis is installed. webassets/site decides whether the binary carries
// the browser page, as every other build does.
func (h *helper) pack(target string) error {
	if !isReleaseTarget(target) {
		return fmt.Errorf("%s 不是桌面发布目标，可选：%s", target, strings.Join(releaseTargets, " "))
	}
	env, note := h.webAssetEnv()
	if note != "" {
		fmt.Println(note)
	}
	fmt.Println("\n构建（安装器随 -installers 产出，带页面时自动加 -tags=webassets）：")
	if err := h.runEnv(env, "go", "tool", "nsgo", "build", "-target", target, "-installers=true"); err != nil {
		if runtime.GOOS == "windows" && strings.HasPrefix(target, "windows") {
			fmt.Println("\n提示：目标程序正在运行时 Windows 会锁住 exe；先关掉 PiDeck 再打包。")
		}
		return err
	}
	dir := filepath.Join(h.root, "dist", h.name+"-"+h.version+"-"+target)
	if _, err := os.Stat(dir); err != nil {
		return fmt.Errorf("找不到构建目录 %s", dir)
	}
	zipPath, err := h.zipPackage(dir, target)
	if err != nil {
		return err
	}
	if strings.HasPrefix(target, "windows") {
		h.reportInstaller(dir, target)
	}
	fmt.Printf("\n便携包：%s\n", zipPath)
	return nil
}

// zipPackage writes the package directory into one portable zip, leaving out
// the files NSIS read to compile the installer and the installer itself,
// which users download on its own.
func (h *helper) zipPackage(dir, target string) (string, error) {
	out := filepath.Join(h.root, "dist", h.releaseName(target, "-portable.zip"))
	f, err := os.Create(out)
	if err != nil {
		return "", err
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	skipped := 0
	err = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		name := info.Name()
		if strings.HasSuffix(name, ".nsi") || strings.HasSuffix(name, "-setup.exe") ||
			strings.HasSuffix(name, "-setup.ico") || strings.HasSuffix(name, "-uninstall.ico") {
			skipped++
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(rel)
		header.Method = zip.Deflate
		w, err := zw.CreateHeader(header)
		if err != nil {
			return err
		}
		src, err := os.Open(path)
		if err != nil {
			return err
		}
		defer src.Close()
		_, err = io.Copy(w, src)
		return err
	})
	if err != nil {
		zw.Close()
		return "", err
	}
	if err := zw.Close(); err != nil {
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	if err := os.WriteFile(out+".sha256", []byte(fmt.Sprintf("%s  %s\n", fileSHA256(out), filepath.Base(out))), 0o644); err != nil {
		return "", err
	}
	if skipped > 0 {
		fmt.Printf("\n压缩包跳过了 %d 个 NSIS 输入文件\n", skipped)
	}
	return out, nil
}

// reportInstaller says what the build produced for Windows: the setup
// executable, or the script waiting for makensis. nsgo moves a compiled
// installer into dist/releases, so both places are looked at.
func (h *helper) reportInstaller(dir, target string) {
	name := h.releaseName(target, "-setup.exe")
	for _, candidate := range []string{filepath.Join(h.root, "dist", "releases", name), filepath.Join(dir, name)} {
		if _, err := os.Stat(candidate); err == nil {
			fmt.Printf("\n安装器：%s\n", candidate)
			return
		}
	}
	scripts, _ := filepath.Glob(filepath.Join(dir, "*.nsi"))
	if len(scripts) == 0 {
		fmt.Printf("\n安装器：本次没生成（没有 NSIS，也没有写出脚本）\n")
		return
	}
	fmt.Printf("\n安装器：未编译，缺 NSIS。装好后编译，不用重新构建：\n")
	if compiler, err := exec.LookPath("makensis"); err == nil {
		fmt.Printf("  cd %q && %q -V2 -INPUTCHARSET UTF8 %q\n", dir, compiler, filepath.Base(scripts[0]))
		return
	}
	fmt.Println("  winget install NSIS.NSIS      （或 choco install nsis -y）")
	fmt.Printf("  cd %q && makensis -V2 -INPUTCHARSET UTF8 %q\n", dir, filepath.Base(scripts[0]))
}

// releaseName is a release file's name, as nsgo spells it:
// <slug>-<version>-<target><suffix>, with the target's underscore as a dash.
func (h *helper) releaseName(target, suffix string) string {
	return slug(h.name) + "-" + h.version + "-" + strings.ReplaceAll(target, "_", "-") + suffix
}

// slug keeps name's ASCII letters and digits, in lowercase, joined by
// hyphens where anything else was, as nsgo names release files.
func slug(name string) string {
	var b strings.Builder
	hyphen := false
	for _, r := range strings.ToLower(name) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			if hyphen && b.Len() > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r)
			hyphen = false
			continue
		}
		hyphen = true
	}
	return b.String()
}

// fileSHA256 is the digest release pages publish beside a file.
func fileSHA256(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, f); err != nil {
		return ""
	}
	return hex.EncodeToString(sum.Sum(nil))
}

func isReleaseTarget(target string) bool {
	for _, t := range releaseTargets {
		if t == target {
			return true
		}
	}
	return false
}
