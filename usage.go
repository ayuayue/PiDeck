package main

// Local usage statistics: what the session files say about tokens, cost,
// models and projects. Everything is read from disk on demand and kept in
// memory as a small report; no network, no telemetry.

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// usageSample is one assistant message's usage.
type usageSample struct {
	Time       time.Time
	Provider   string
	Model      string
	Cwd        string
	SessionID  string
	Input      int
	Output     int
	CacheRead  int
	CacheWrite int
	Total      int
	Cost       float64
	// Estimated marks an ACP sample, whose tokens come from text length.
	Estimated bool
}

// usageDay is one day of the heatmap.
type usageDay struct {
	Date    string
	Weekday int
	Total   int
	Cost    float64
	Replies int
}

// usageBucket is one model's or project's share.
type usageBucket struct {
	Name  string
	Sub   string
	Total int
	Cost  float64
	Count int
}

// usageReport is what the usage page shows.
type usageReport struct {
	Days      []usageDay
	Models    []usageBucket
	Projects  []usageBucket
	Total     usageInfo
	Sessions  int
	Replies   int
	Files     int
	Estimated int
	Since     time.Time
	Until     time.Time
}

// usageWindowDays is how many days the heatmap covers: 12 weeks.
const usageWindowDays = 84

// maxUsageFiles bounds a scan so a machine with years of sessions still
// answers in a moment.
const maxUsageFiles = 3000

// collectUsage reads the newest session files under roots and builds the
// report. Files are capped and sessions counted once, so an imported copy
// does not double the original.
func collectUsage(roots []string, acpDir string, now time.Time) usageReport {
	type fileInfo struct {
		path string
		mod  time.Time
	}
	var files []fileInfo
	seenPath := map[string]bool{}
	for _, root := range roots {
		if root == "" {
			continue
		}
		_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
				return nil
			}
			clean := filepath.Clean(path)
			if seenPath[clean] {
				return nil
			}
			seenPath[clean] = true
			info, err := d.Info()
			if err != nil {
				return nil
			}
			files = append(files, fileInfo{path: clean, mod: info.ModTime()})
			return nil
		})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.After(files[j].mod) })
	if len(files) > maxUsageFiles {
		files = files[:maxUsageFiles]
	}

	report := usageReport{Files: len(files)}
	seenSession := map[string]bool{}
	var samples []usageSample
	for _, f := range files {
		ss, id := readUsageFile(f.path)
		if id != "" && seenSession[id] {
			continue
		}
		if id != "" {
			seenSession[id] = true
		}
		samples = append(samples, ss...)
	}
	for _, sample := range readACPUsage(acpDir) {
		if seenSession[sample.SessionID] {
			continue
		}
		seenSession[sample.SessionID] = true
		samples = append(samples, sample)
		report.Estimated++
	}
	report.Sessions = len(seenSession)
	report.Replies = len(samples)
	if len(samples) == 0 {
		return report
	}

	// The heatmap's days, oldest first, starting on a Monday.
	until := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	since := until.AddDate(0, 0, -(usageWindowDays - 1))
	for since.Weekday() != time.Monday {
		since = since.AddDate(0, 0, -1)
	}
	report.Since, report.Until = since, until
	days := map[string]*usageDay{}
	for d := since; !d.After(until); d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		days[key] = &usageDay{Date: key, Weekday: int(d.Weekday())}
	}
	models := map[string]*usageBucket{}
	projects := map[string]*usageBucket{}
	for _, s := range samples {
		report.Total = report.Total.add(usageInfo{Input: s.Input, Output: s.Output, CacheRead: s.CacheRead,
			CacheWrite: s.CacheWrite, Total: s.Total, Cost: s.Cost})
		key := s.Time.Format("2006-01-02")
		if d, ok := days[key]; ok {
			d.Total += s.Total
			d.Cost += s.Cost
			d.Replies++
		}
		mk := firstNonEmpty(s.Provider+" / "+s.Model, s.Model, "未知模型")
		if b, ok := models[mk]; ok {
			b.Total += s.Total
			b.Cost += s.Cost
			b.Count++
		} else {
			models[mk] = &usageBucket{Name: mk, Sub: s.Provider, Total: s.Total, Cost: s.Cost, Count: 1}
		}
		proj := firstNonEmpty(projectLabel(s.Cwd), "未知项目")
		if b, ok := projects[proj]; ok {
			b.Total += s.Total
			b.Cost += s.Cost
			b.Count++
		} else {
			projects[proj] = &usageBucket{Name: proj, Sub: s.Cwd, Total: s.Total, Cost: s.Cost, Count: 1}
		}
	}
	for d := since; !d.After(until); d = d.AddDate(0, 0, 1) {
		report.Days = append(report.Days, *days[d.Format("2006-01-02")])
	}
	report.Models = topBuckets(models, 10)
	report.Projects = topBuckets(projects, 10)
	return report
}

// readACPUsage estimates ACP tokens from the archived text.
func readACPUsage(dir string) []usageSample {
	if dir == "" {
		return nil
	}
	entries, _ := os.ReadDir(dir)
	var out []usageSample
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var arch acpArchive
		if json.Unmarshal(raw, &arch) != nil || arch.ID == "" {
			continue
		}
		for _, t := range arch.Turns {
			var output strings.Builder
			output.WriteString(t.Final)
			for _, st := range t.Steps {
				output.WriteString(st.Text)
				output.WriteString(st.Thinking)
			}
			in, outTok := estimateTokens(t.Prompt), estimateTokens(output.String())
			if in+outTok == 0 {
				continue
			}
			when := t.Start
			if when.IsZero() {
				when = t.End
			}
			if when.IsZero() {
				when = arch.Updated
			}
			out = append(out, usageSample{Time: when, Provider: "acp", Model: arch.Preset,
				Cwd: arch.Cwd, SessionID: arch.ID, Input: in, Output: outTok, Total: in + outTok, Estimated: true})
		}
	}
	return out
}

// estimateTokens approximates tokens from text: one per CJK rune, a
// quarter per other non-space rune.
func estimateTokens(text string) int {
	cjk, other := 0, 0
	for _, r := range text {
		switch {
		case r >= 0x2E80 && r <= 0x9FFF, r >= 0xF900 && r <= 0xFAFF, r >= 0xFF00 && r <= 0xFFEF:
			cjk++
		case r == ' ' || r == '\n' || r == '\t' || r == '\r':
		default:
			other++
		}
	}
	return cjk + (other+3)/4
}

// readUsageFile reads one session file's usage samples and its id.
func readUsageFile(path string) ([]usageSample, string) {
	f, err := os.Open(path)
	if err != nil {
		return nil, ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	var out []usageSample
	id, cwd, provider, model := "", "", "", ""
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var entry struct {
			Type      string `json:"type"`
			Timestamp string `json:"timestamp"`
			Cwd       string `json:"cwd"`
			ID        string `json:"id"`
			Provider  string `json:"provider"`
			ModelID   string `json:"modelId"`
			Message   struct {
				Role     string `json:"role"`
				Provider string `json:"provider"`
				Model    string `json:"model"`
				Usage    *struct {
					Input      int `json:"input"`
					Output     int `json:"output"`
					CacheRead  int `json:"cacheRead"`
					CacheWrite int `json:"cacheWrite"`
					Total      int `json:"totalTokens"`
					Cost       struct {
						Total float64 `json:"total"`
					} `json:"cost"`
				} `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &entry) != nil {
			continue
		}
		switch entry.Type {
		case "session":
			id, cwd = entry.ID, entry.Cwd
		case "model_change":
			provider, model = entry.Provider, entry.ModelID
		case "message":
			if entry.Message.Role != "assistant" || entry.Message.Usage == nil {
				continue
			}
			u := entry.Message.Usage
			if u.Total == 0 && u.Input == 0 && u.Output == 0 {
				continue
			}
			ts, err := time.Parse(time.RFC3339Nano, entry.Timestamp)
			if err != nil {
				continue
			}
			p := firstNonEmpty(entry.Message.Provider, provider)
			m := firstNonEmpty(entry.Message.Model, model)
			out = append(out, usageSample{
				Time: ts.Local(), Provider: p, Model: m, Cwd: cwd, SessionID: id,
				Input: u.Input, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite,
				Total: u.Total, Cost: u.Cost.Total,
			})
		}
	}
	return out, id
}

// topBuckets sorts buckets by tokens and keeps the first n.
func topBuckets(m map[string]*usageBucket, n int) []usageBucket {
	out := make([]usageBucket, 0, len(m))
	for _, b := range m {
		out = append(out, *b)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Total != out[j].Total {
			return out[i].Total > out[j].Total
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}

// projectLabel is a project path's last element.
func projectLabel(path string) string {
	path = filepath.Clean(path)
	base := filepath.Base(path)
	if base == "." || base == string(filepath.Separator) || base == "" {
		return path
	}
	return base
}

// heatLevel turns a day's tokens into 0..4, on a log scale so a very
// busy day does not flatten the rest.
func heatLevel(total, max int) int {
	if total <= 0 || max <= 0 {
		return 0
	}
	ratio := float64(total) / float64(max)
	switch {
	case ratio > 0.66:
		return 4
	case ratio > 0.33:
		return 3
	case ratio > 0.12:
		return 2
	default:
		return 1
	}
}

// loadUsage reads the session files in the background, once unless force
// asks for a fresh count.
func (a *app) loadUsage(force bool) {
	if a.st == nil || a.usageLoading.GetUntracked() {
		return
	}
	if a.usageLoaded && !force {
		return
	}
	roots := []string{a.st.sessions}
	dir := a.env.GetUntracked().SessionsDir
	if dir == "" {
		dir = piSessionsDir()
	}
	if dir != "" && filepath.Clean(dir) != filepath.Clean(a.st.sessions) {
		roots = append(roots, dir)
	}
	a.usageLoading.Set(true)
	go func() {
		report := collectUsage(roots, a.acpArchiveDir(), time.Now())
		a.cx.Post(func() {
			a.usage.Set(report)
			a.usageLoading.Set(false)
			a.usageLoaded = true
		})
	}()
}

// usageMaxDay is the busiest day in the window, for the heat scale.
func usageMaxDay(days []usageDay) int {
	max := 0
	for _, d := range days {
		if d.Total > max {
			max = d.Total
		}
	}
	return max
}

// usageWeekRows lays the days out as 12 columns of 7 rows, Monday first.
func usageWeekRows(days []usageDay) [][]usageDay {
	var weeks [][]usageDay
	var week []usageDay
	for _, d := range days {
		if len(week) == 0 && d.Weekday != int(time.Monday) {
			// Pad the first week so Monday is the top row.
			for i := 0; i < d.Weekday; i++ {
				week = append(week, usageDay{Weekday: i})
			}
		}
		week = append(week, d)
		if len(week) == 7 {
			weeks = append(weeks, week)
			week = nil
		}
	}
	if len(week) > 0 {
		for len(week) < 7 {
			week = append(week, usageDay{Weekday: len(week)})
		}
		weeks = append(weeks, week)
	}
	return weeks
}
