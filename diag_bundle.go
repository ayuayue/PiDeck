//go:build !js && !android && !ios

package main

// A support bundle: one zip with the diagnostic report, a redacted
// config, the end of the log file and the plugin list. Secrets are
// replaced, so the bundle can be sent without leaking keys.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

// diagnosticZip builds the bundle in memory.
func (a *app) diagnosticZip() ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name string, data []byte) error {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	}
	if err := add("report.txt", []byte(a.diagnosticText())); err != nil {
		return nil, err
	}
	if err := add("config.json", a.redactedConfig()); err != nil {
		return nil, err
	}
	if err := add("plugins.txt", []byte(a.pluginReport())); err != nil {
		return nil, err
	}
	if err := add("settings-schema.json", settingsSchemaJSON()); err != nil {
		return nil, err
	}
	if log := a.logTail(256 << 10); len(log) > 0 {
		if err := add("app.log", log); err != nil {
			return nil, err
		}
	}
	readme := "PiDeck Lite 诊断包\n\n" +
		"report.txt  运行环境、进程与最近日志\n" +
		"config.json 应用配置（访问令牌、密钥、Webhook、代理凭据已替换为 ***）\n" +
		"plugins.txt 插件列表与警告\n" +
		"app.log     日志文件的最后 256 KB（如有）\n"
	if err := add("README.txt", []byte(readme)); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// exportDiagnostics writes a support bundle under the data folder.
func (a *app) exportDiagnostics() {
	if a.st == nil {
		return
	}
	data, err := a.diagnosticZip()
	if err != nil {
		a.toast(ui.ToastError, "导出诊断包失败", err.Error())
		return
	}
	dir := filepath.Join(a.st.dir, "exports")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.toast(ui.ToastError, "导出诊断包失败", err.Error())
		return
	}
	path := filepath.Join(dir, "diagnostics-"+time.Now().Format("20060102-150405")+".zip")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		a.toast(ui.ToastError, "导出诊断包失败", err.Error())
		return
	}
	a.diagf("info", "已导出诊断包到 %s", path)
	a.toastAction(ui.ToastSuccess, "已导出诊断包", path, "打开", func() {
		a.cx.OpenURL(fileURL(path), nil)
	})
}

// redactedConfig is config.json with every credential replaced.
func (a *app) redactedConfig() []byte {
	c := a.cfg
	c.RemoteToken = "***"
	c.FeishuSecret = "***"
	c.FeishuWebhook = "***"
	c.ProxyApp = redactProxy(c.ProxyApp)
	c.ProxyAgent = redactProxy(c.ProxyAgent)
	if c.PluginSettings != nil {
		out := make(map[string]string, len(c.PluginSettings))
		for k, v := range c.PluginSettings {
			if looksSecret(k) {
				v = "***"
			}
			out[k] = v
		}
		c.PluginSettings = out
	}
	raw, _ := json.MarshalIndent(c, "", "  ")
	return raw
}

// redactProxy keeps a proxy's host but drops its user info and query,
// where a password or token usually sits.
func redactProxy(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "***"
	}
	u.User = nil
	if u.RawQuery != "" {
		u.RawQuery = "***"
	}
	return u.String()
}

// looksSecret reports whether a setting key names a credential.
func looksSecret(key string) bool {
	key = strings.ToLower(key)
	for _, word := range []string{"key", "token", "secret", "password", "passwd", "webhook"} {
		if strings.Contains(key, word) {
			return true
		}
	}
	return false
}

// logTail reads the end of the diagnostic log file.
func (a *app) logTail(limit int64) []byte {
	if a.diagPath == "" {
		return nil
	}
	f, err := os.Open(a.diagPath)
	if err != nil {
		return nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil
	}
	if size := info.Size(); size > limit {
		if _, err := f.Seek(size-limit, io.SeekStart); err != nil {
			return nil
		}
	}
	data, _ := io.ReadAll(f)
	return data
}

// pluginReport lists plugins and what the loader thought of them.
func (a *app) pluginReport() string {
	if a.plugins == nil {
		return "（没有插件）\n"
	}
	list := a.plugins.GetUntracked()
	if len(list) == 0 {
		return "（没有插件）\n"
	}
	var b strings.Builder
	for _, p := range list {
		fmt.Fprintf(&b, "%s · %s · %s · disabled=%v\n", p.ID, p.Name, p.Version, p.Disabled)
		if p.Error != "" {
			fmt.Fprintf(&b, "  error: %s\n", p.Error)
		}
		for _, w := range p.Warnings {
			fmt.Fprintf(&b, "  warn: %s\n", w)
		}
	}
	return b.String()
}
