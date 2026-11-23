//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
	"go.yaml.in/yaml/v3"
)

type videoJob struct {
	ID, Session, Provider, Family, Model, Prompt string
	Resolution, Ratio, Task, State, Error        string
	Duration                                     int
	Stored                                       bool
	Created                                      time.Time
}

var videoJobWrites sync.WaitGroup

type videoHost struct {
	lifetime                                                              context.Context
	open, ready                                                           *core.Signal[bool]
	jobs                                                                  *core.Signal[[]videoJob]
	window                                                                *core.Signal[int]
	provider, family, model, prompt, resolution, ratio, duration, message *core.Signal[string]
	busy                                                                  string
	cancel                                                                context.CancelFunc
	writeMu                                                               sync.Mutex
	seq, written                                                          uint64
}

func (a *app) initVideo() {
	h := &videoHost{lifetime: a.cx.Context(), open: core.NewSignal(a.cx, false), ready: core.NewSignal(a.cx, false), jobs: core.NewSignalFunc(a.cx, []videoJob(nil), nil),
		window:   core.NewSignal(a.cx, 40),
		provider: core.NewSignal(a.cx, ""), family: core.NewSignal(a.cx, "ark"), model: core.NewSignal(a.cx, ""), prompt: core.NewSignal(a.cx, ""),
		resolution: core.NewSignal(a.cx, "720p"), ratio: core.NewSignal(a.cx, "16:9"), duration: core.NewSignal(a.cx, "5"), message: core.NewSignal(a.cx, "")}
	a.video = h
	a.cx.Cleanup(func() {
		if h.cancel != nil {
			h.cancel()
		}
	})
	if a.st == nil {
		h.ready.Set(true)
		return
	}
	file := filepath.Join(a.st.dir, "video", "jobs.yaml")
	go func() { list := readVideoJobs(file); a.cx.Post(func() { h.jobs.Set(list); h.ready.Set(true) }) }()
}

func readVideoJobs(file string) []videoJob {
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, (4<<20)+1))
	if err != nil || len(raw) > 4<<20 {
		return nil
	}
	var saved struct {
		Version int
		Jobs    []videoJob
	}
	if yaml.Unmarshal(raw, &saved) != nil || saved.Version != 1 {
		return nil
	}
	var list []videoJob
	for _, j := range saved.Jobs {
		if len(j.ID) != 32 || !marketID.MatchString(j.ID) || j.Model == "" || len(j.Prompt) > 24<<10 {
			continue
		}
		if j.State == "queued" || j.State == "running" {
			j.State = "interrupted"
		}
		list = append(list, j)
		if len(list) >= 200 {
			break
		}
	}
	return list
}

func (a *app) persistVideoJobs() {
	h := a.video
	if a.st == nil {
		return
	}
	jobs := append([]videoJob(nil), h.jobs.GetUntracked()...)
	h.seq++
	seq := h.seq
	file := filepath.Join(a.st.dir, "video", "jobs.yaml")
	videoJobWrites.Add(1)
	go func() {
		defer videoJobWrites.Done()
		h.writeMu.Lock()
		defer h.writeMu.Unlock()
		if seq <= h.written {
			return
		}
		raw, err := yaml.Marshal(struct {
			Version int
			Jobs    []videoJob
		}{1, jobs})
		if err == nil {
			err = os.MkdirAll(filepath.Dir(file), 0o700)
		}
		if err == nil {
			err = writeFileAtomic(file, raw, 0o600)
		}
		if err == nil {
			h.written = seq
		} else {
			a.cx.Post(func() { h.message.Set(err.Error()) })
		}
	}()
}

func (a *app) updateVideo(j videoJob) {
	a.video.jobs.Update(func(list []videoJob) []videoJob {
		out := append([]videoJob(nil), list...)
		for i := range out {
			if out[i].ID == j.ID {
				out[i] = j
				return out
			}
		}
		return append([]videoJob{j}, out...)
	})
	a.persistVideoJobs()
}

func (a *app) nextVideo() {
	h := a.video
	if h.busy != "" {
		return
	}
	jobs := h.jobs.GetUntracked()
	for i := len(jobs) - 1; i >= 0; i-- {
		j := jobs[i]
		if j.State != "queued" {
			continue
		}
		h.busy = j.ID
		ctx, cancel := context.WithTimeout(h.lifetime, 20*time.Minute)
		h.cancel = cancel
		j.State = "running"
		j.Error = ""
		a.updateVideo(j)
		go a.runVideo(ctx, j)
		return
	}
}

func (a *app) runVideo(ctx context.Context, j videoJob) {
	var cfg providerConfig
	for _, p := range readProviderConfigs() {
		if p.ID == j.Provider {
			cfg = p
			break
		}
	}
	err := error(nil)
	if cfg.ID == "" {
		err = errors.New(apptext.T("找不到供应商配置。"))
	}
	if err == nil && j.Task == "" {
		j.Task, err = submitVideo(ctx, cfg, j)
		if err == nil {
			copy := j
			a.cx.Post(func() { a.updateVideo(copy) })
		}
	}
	var artifact string
	if err == nil {
		tick := time.NewTicker(3 * time.Second)
		defer tick.Stop()
		for {
			_, artifact, err = queryVideo(ctx, cfg, j)
			if err != nil || artifact != "" {
				break
			}
			select {
			case <-ctx.Done():
				err = ctx.Err()
			case <-tick.C:
				continue
			}
			break
		}
	}
	if err == nil {
		err = downloadVideo(ctx, artifact, a.videoPath(j))
	}
	if err == nil {
		j.State = "succeeded"
		j.Stored = true
	} else {
		j.State = "failed"
		j.Error = err.Error()
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			j.State = "interrupted"
		}
	}
	a.cx.Post(func() {
		h := a.video
		if h.cancel != nil {
			h.cancel()
			h.cancel = nil
		}
		h.busy = ""
		a.updateVideo(j)
		if j.Stored {
			a.toast(ui.ToastSuccess, "视频已生成", j.Model)
		}
		a.nextVideo()
	})
}

func (a *app) videoPath(j videoJob) string {
	return filepath.Join(a.st.dir, "video", "blobs", j.ID+".mp4")
}

func downloadVideo(ctx context.Context, address, file string) error {
	if !isHTTPURL(address) {
		return errors.New("invalid video artifact URL")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	// Artifact hosts never receive the gateway's authorization header.
	res, err := appHTTPLongClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errors.New("video artifact download failed")
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), "video-*.part")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	n, err := io.Copy(f, io.LimitReader(res.Body, (256<<20)+1))
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if n < 12 || n > 256<<20 {
		return errors.New("invalid video artifact size")
	}
	check, err := os.Open(tmp)
	if err != nil {
		return err
	}
	var header [12]byte
	_, err = io.ReadFull(check, header[:])
	check.Close()
	if err != nil || string(header[4:8]) != "ftyp" {
		return errors.New("video artifact is not MP4")
	}
	return os.Rename(tmp, file)
}

func videoJobLabel(j videoJob) string {
	switch j.State {
	case "queued":
		return apptext.T("排队中")
	case "running":
		return apptext.T("运行中")
	case "succeeded":
		return apptext.T("已完成")
	case "interrupted":
		return apptext.T("跟踪已暂停")
	}
	return apptext.T("失败")
}

func (a *app) resumeVideo(j videoJob) {
	if j.Task == "" {
		return
	}
	j.State = "queued"
	j.Error = ""
	a.updateVideo(j)
	a.nextVideo()
}

func (a *app) removeVideoRecord(id string) {
	list := a.video.jobs.GetUntracked()
	var kept []videoJob
	for _, j := range list {
		if j.ID != id || j.State == "running" || j.State == "queued" {
			kept = append(kept, j)
		}
	}
	if len(kept) != len(list) {
		a.video.jobs.Set(kept)
		a.persistVideoJobs()
	}
}

func (a *app) videoSessionRows(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		var rows []core.Node
		for _, j := range a.video.jobs.Get() {
			if j.Session != s.ID {
				continue
			}
			job := j
			rows = append(rows, ui.Button{Text: job.Model + " · " + videoJobLabel(job), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "session-video-" + job.ID, OnPress: func() { a.openPane(paneVideo) }})
			if len(rows) >= 8 {
				break
			}
		}
		return core.View{Style: core.Style{Gap: 4}, Children: rows}
	})
}
