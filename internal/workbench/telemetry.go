//go:build !js && !android && !ios

package workbench

// Anonymous usage telemetry: the daily heartbeat PiDeck sends, one event
// a day per install. The event carries the version, the platform, the
// feature switches and counts of what the app holds. It never carries
// project paths, project or session names, file names, prompts, provider
// settings, webhooks or keys.
//
// PiDeck and PiDeck Lite report into one PostHog project so the two can be
// compared side by side. Every event here names its app in the "app"
// property ("pideck-lite"), which an insight filters on; PiDeck's own
// events are the ones without the property.

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"

	"example.com/pideck-lite/internal/appinfo"
	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
)

const (
	// telemetryEvent is the daily event's name, as PiDeck sends it.
	telemetryEvent = "app_heartbeat"
	// telemetryApp is the value of the shared project's "app" property
	// that marks this app's events; PiDeck's own events carry no app
	// property, so they are the ones it filters out.
	telemetryApp     = "pideck-lite"
	telemetryAppName = "PiDeck Lite"
	// The defaults point at PiDeck's project and host; POSTHOG_PROJECT_KEY
	// and POSTHOG_HOST point a build elsewhere.
	defaultTelemetryProjectKey = "phc_xgJ8gFUMgExZEEPzZ7VRa7698ENcaDRquWZVGYb2dCFK"
	defaultTelemetryHost       = "https://us.i.posthog.com"
)

// telemetryMeta is what the payload says about this build.
type telemetryMeta struct {
	Version  string
	Platform string
	Arch     string
}

// telemetrySnapshotInput is what the snapshot reads, gathered on the
// interface's thread so the payload can be checked without an app.
type telemetrySnapshotInput struct {
	Language        string
	Theme           string
	StartupMS       int
	SessionsTotal   int
	ProjectsTotal   int
	TasksTotal      int
	PluginsTotal    int
	DisabledPlugins int
	PetEnabled      bool
	RemoteEnabled   bool
	FeishuEnabled   bool
	NotifyOnDone    bool
	ScanPi          bool
	ScanAll         bool
	ProxySet        bool
	BackgroundImage bool
}

// collectTelemetrySnapshot builds the anonymous properties. Every field
// is a switch or a count: no path, name, content or credential belongs
// here, and the list is short enough to read.
func collectTelemetrySnapshot(in telemetrySnapshotInput) map[string]any {
	return map[string]any{
		"language":               in.Language,
		"theme":                  in.Theme,
		"startup_ms":             in.StartupMS,
		"sessions_total":         in.SessionsTotal,
		"projects_total":         in.ProjectsTotal,
		"tasks_total":            in.TasksTotal,
		"plugins_total":          in.PluginsTotal,
		"disabled_plugins_total": in.DisabledPlugins,
		"feature_pet":            in.PetEnabled,
		"feature_remote":         in.RemoteEnabled,
		"feature_feishu":         in.FeishuEnabled,
		"feature_notify":         in.NotifyOnDone,
		"feature_scan_pi":        in.ScanPi,
		"feature_scan_all":       in.ScanAll,
		"feature_proxy":          in.ProxySet,
		"feature_background":     in.BackgroundImage,
	}
}

// telemetryPayload is the request body PostHog's /capture/ takes. The
// fixed fields are written last, so a snapshot can never rename the app.
func telemetryPayload(projectKey string, meta telemetryMeta, snapshot map[string]any, installID string) map[string]any {
	props := make(map[string]any, len(snapshot)+8)
	person := make(map[string]any, len(snapshot)+8)
	for k, v := range snapshot {
		props[k] = v
		person[k] = v
	}
	for _, m := range []map[string]any{props, person} {
		m["app"] = telemetryApp
		m["app_name"] = telemetryAppName
		m["app_version"] = meta.Version
		m["platform"] = meta.Platform
		m["arch"] = meta.Arch
		m["packaged"] = true
	}
	props["install_id"] = installID
	props["$set"] = person
	return map[string]any{
		"api_key":     projectKey,
		"event":       telemetryEvent,
		"distinct_id": installID,
		"properties":  props,
	}
}

// telemetrySendOptions is one heartbeat's inputs. Post is replaced by a
// test to see the body; the app posts it over appHTTPClient.
type telemetrySendOptions struct {
	// Development keeps nsgo dev, nsgo test and plain go builds from
	// reporting; only nsgo build sets it false.
	Development bool
	ProjectKey  string
	Host        string
	Now         time.Time
	Settings    config
	Meta        telemetryMeta
	Snapshot    map[string]any
	Post        func(url string, body []byte) error
}

// sendTelemetryHeartbeat sends today's heartbeat unless one already went
// out, the user turned it off, or this is a development build. The install
// id and the day come back only after PostHog accepted the request, so a
// failure retries on the next start instead of losing the day.
func sendTelemetryHeartbeat(o telemetrySendOptions) (installID, day string, sent bool, err error) {
	host := normalizeTelemetryHost(o.Host)
	key := strings.TrimSpace(o.ProjectKey)
	if o.Development || key == "" || host == "" || !telemetryEnabled(o.Settings) {
		return "", "", false, nil
	}
	day = telemetryDay(o.Now)
	if o.Settings.TelemetryLastHeartbeatDate == day {
		return "", "", false, nil
	}
	installID = strings.TrimSpace(o.Settings.TelemetryInstallID)
	if installID == "" {
		if installID, err = newTelemetryInstallID(); err != nil {
			return "", "", false, err
		}
	}
	body, err := json.Marshal(telemetryPayload(key, o.Meta, o.Snapshot, installID))
	if err != nil {
		return "", "", false, err
	}
	if o.Post == nil {
		return "", "", false, fmt.Errorf("没有发送心跳的方式")
	}
	if err := o.Post(host+"/capture/", body); err != nil {
		return "", "", false, err
	}
	return installID, day, true, nil
}

// telemetryStartupDelay is how long the heartbeat waits after launch, so
// the background framework probe has filled in the plugin count.
const telemetryStartupDelay = 10 * time.Second

// startTelemetry sends this install's heartbeat for today, in the
// background, once the app has read its projects and sessions.
func (a *app) startTelemetry() {
	if a.st == nil || a.cx == nil {
		return
	}
	startupMS := 0
	if !a.startedAt.IsZero() {
		startupMS = int(time.Since(a.startedAt).Milliseconds())
		if startupMS < 0 {
			startupMS = 0
		}
	}
	a.cx.AfterFunc(telemetryStartupDelay, func() { a.telemetryTick(startupMS) })
}

// telemetryTick gathers today's heartbeat and sends it, off the interface
// thread.
func (a *app) telemetryTick(startupMS int) {
	if a.st == nil || a.cx == nil {
		return
	}
	key, host := telemetryConfig()
	opts := telemetrySendOptions{
		Development: core.App().Development,
		ProjectKey:  key,
		Host:        host,
		Now:         time.Now(),
		Settings:    a.cfg,
		Meta:        telemetryMeta{Version: appinfo.Version, Platform: runtime.GOOS, Arch: runtime.GOARCH},
		Snapshot:    a.telemetrySnapshot(startupMS),
		Post: func(url string, body []byte) error {
			req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
			if err != nil {
				return err
			}
			req.Header.Set("Content-Type", "application/json")
			resp, err := appHTTPClient.Do(req)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				return fmt.Errorf("HTTP %d", resp.StatusCode)
			}
			return nil
		},
	}
	go func() {
		installID, day, sent, err := sendTelemetryHeartbeat(opts)
		if err != nil {
			a.diagf("info", "匿名统计未发出：%v", err)
			return
		}
		if !sent {
			return
		}
		a.cx.Post(func() {
			a.st.edit(func(c *config) {
				c.TelemetryInstallID = installID
				c.TelemetryLastHeartbeatDate = day
			})
			a.cfg.TelemetryInstallID = installID
			a.cfg.TelemetryLastHeartbeatDate = day
		})
	}()
}

// telemetrySnapshot reads the counts and switches the payload carries.
func (a *app) telemetrySnapshot(startupMS int) map[string]any {
	pluginsTotal := 0
	if a.plugins != nil {
		pluginsTotal = len(a.plugins.GetUntracked())
	}
	a.taskMu.Lock()
	tasksTotal := len(a.tasks)
	a.taskMu.Unlock()
	projectsTotal := len(a.cfg.Workspaces)
	if a.workspaces != nil {
		projectsTotal = len(a.workspaces.GetUntracked())
	}
	cfg := a.cfg
	return collectTelemetrySnapshot(telemetrySnapshotInput{
		Language:        apptext.CurrentLanguage(),
		Theme:           cfg.Theme,
		StartupMS:       startupMS,
		SessionsTotal:   len(a.all),
		ProjectsTotal:   projectsTotal,
		TasksTotal:      tasksTotal,
		PluginsTotal:    pluginsTotal,
		DisabledPlugins: len(cfg.DisabledPlugins),
		PetEnabled:      cfg.PetEnabled,
		RemoteEnabled:   cfg.RemoteEnabled,
		FeishuEnabled:   cfg.FeishuEnabled,
		NotifyOnDone:    cfg.NotifyOnDone,
		ScanPi:          cfg.ScanPi,
		ScanAll:         cfg.ScanAll,
		ProxySet:        cfg.ProxyApp != "" || cfg.ProxyAgent != "",
		BackgroundImage: cfg.BackgroundImage != "",
	})
}

// telemetryConfig is the project and host this build reports to.
func telemetryConfig() (key, host string) {
	key = strings.TrimSpace(os.Getenv("POSTHOG_PROJECT_KEY"))
	if key == "" {
		key = defaultTelemetryProjectKey
	}
	host = strings.TrimSpace(os.Getenv("POSTHOG_HOST"))
	if host == "" {
		host = defaultTelemetryHost
	}
	return key, normalizeTelemetryHost(host)
}

// telemetryEnabled reports the switch; a config from before it existed
// reads as on, as PiDeck ships it.
func telemetryEnabled(c config) bool {
	return c.TelemetryEnabled == nil || *c.TelemetryEnabled
}

// newTelemetryInstallID makes this install's anonymous id: random, not
// derived from the machine, so two installs cannot be linked by it.
func newTelemetryInstallID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// telemetryDay is the local day a heartbeat counts for.
func telemetryDay(now time.Time) string {
	return now.Format("2006-01-02")
}

// normalizeTelemetryHost drops the slashes a host is written with, so the
// capture URL never doubles them.
func normalizeTelemetryHost(host string) string {
	return strings.TrimRight(strings.TrimSpace(host), "/")
}
