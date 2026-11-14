package main

// Usage as CSV: the days, models and projects the usage page draws, for
// a spreadsheet or a cost report.

import (
	"encoding/csv"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/oneo-me/nsgo/ui"
)

// usageCSV writes the report as three sections: days, models, projects.
func usageCSV(r usageReport) string {
	var b strings.Builder
	w := csv.NewWriter(&b)
	row := func(cells ...string) { _ = w.Write(cells) }

	row("PiDeck Lite 用量", r.Since.Format("2006-01-02")+" ~ "+r.Until.Format("2006-01-02"))
	row("会话", strconv.Itoa(r.Sessions), "回复", strconv.Itoa(r.Replies),
		"输入", strconv.Itoa(r.Total.Input), "输出", strconv.Itoa(r.Total.Output),
		"tokens", strconv.Itoa(r.Total.Total), "费用", fmt.Sprintf("%.4f", r.Total.Cost))
	row()

	row("日期", "tokens", "费用", "回复")
	for _, d := range r.Days {
		if d.Total == 0 && d.Replies == 0 {
			continue
		}
		row(d.Date, strconv.Itoa(d.Total), fmt.Sprintf("%.4f", d.Cost), strconv.Itoa(d.Replies))
	}
	row()

	row("模型", "供应商", "tokens", "费用", "次数")
	for _, m := range r.Models {
		row(m.Name, m.Sub, strconv.Itoa(m.Total), fmt.Sprintf("%.4f", m.Cost), strconv.Itoa(m.Count))
	}
	row()

	row("项目", "路径", "tokens", "费用", "次数")
	for _, p := range r.Projects {
		row(p.Name, p.Sub, strconv.Itoa(p.Total), fmt.Sprintf("%.4f", p.Cost), strconv.Itoa(p.Count))
	}
	w.Flush()
	return b.String()
}

// exportUsageCSV writes the current report under exports/.
func (a *app) exportUsageCSV() {
	if a.st == nil {
		return
	}
	r := a.usage.GetUntracked()
	if r.Replies == 0 {
		a.toast(ui.ToastInfo, "还没有可导出的用量", "发几轮消息后再导出。")
		return
	}
	dir := filepath.Join(a.st.dir, "exports")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.toast(ui.ToastError, "导出用量失败", err.Error())
		return
	}
	path := filepath.Join(dir, "usage-"+time.Now().Format("20060102-150405")+".csv")
	if err := os.WriteFile(path, []byte(usageCSV(r)), 0o644); err != nil {
		a.toast(ui.ToastError, "导出用量失败", err.Error())
		return
	}
	a.toastAction(ui.ToastSuccess, "已导出用量", path, "打开", func() { a.cx.OpenURL(fileURL(path), nil) })
}
