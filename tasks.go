//go:build !js

package main

// Scheduled tasks: a prompt, a project and a cron expression. A
// background ticker finds due occurrences, starts a fresh session on the
// chosen backend (pi or ACP), sends the prompt and records how it went.
// The list and its run history live in tasks.json beside the config.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// Task statuses, as the list and the history show them.
const (
	taskRunning     = "running"
	taskOK          = "ok"
	taskFailed      = "failed"
	taskTimeout     = "timeout"
	taskSkipped     = "skipped"
	taskCancelled   = "cancelled"
	taskInterrupted = "interrupted"
)

// taskHistoryLimit bounds the run list on disk.
const taskHistoryLimit = 200

// defaultTaskTimeout is a run's limit when the task leaves it empty.
const defaultTaskTimeout = 30 * time.Minute

// scheduledTask is one task from tasks.json.
type scheduledTask struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Prompt    string `json:"prompt"`
	Project   string `json:"project"`
	Cron      string `json:"cron"`
	Backend   string `json:"backend,omitempty"`
	ACPPreset string `json:"acpPreset,omitempty"`
	Persona   string `json:"persona,omitempty"`
	Enabled   bool   `json:"enabled"`
	// TimeoutMin bounds a run; 0 uses the default.
	TimeoutMin      int       `json:"timeoutMin,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
	LastScheduledAt time.Time `json:"lastScheduledAt,omitempty"`
	LastRunAt       time.Time `json:"lastRunAt,omitempty"`
	LastStatus      string    `json:"lastStatus,omitempty"`
}

// taskRun is one execution of a task.
type taskRun struct {
	ID        string    `json:"id"`
	TaskID    string    `json:"taskId"`
	TaskName  string    `json:"taskName"`
	SessionID string    `json:"sessionId,omitempty"`
	Trigger   string    `json:"trigger"` // schedule, catch-up, manual
	Status    string    `json:"status"`
	StartedAt time.Time `json:"startedAt"`
	EndedAt   time.Time `json:"endedAt,omitempty"`
	Error     string    `json:"error,omitempty"`
}

// tasksFile is what tasks.json holds.
type tasksFile struct {
	Version int              `json:"version"`
	Tasks   []*scheduledTask `json:"tasks"`
	Runs    []taskRun        `json:"runs"`
}

// tasksPath is where the list lives.
func (a *app) tasksPath() string {
	if a == nil || a.st == nil {
		return ""
	}
	return filepath.Join(a.st.dir, "tasks.json")
}

// loadTasks reads the list and marks runs a restart interrupted.
func (a *app) loadTasks() {
	path := a.tasksPath()
	if path == "" {
		return
	}
	now := time.Now()
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var file tasksFile
	if json.Unmarshal(raw, &file) != nil {
		return
	}
	for _, t := range file.Tasks {
		normalizeTask(t, now)
	}
	for i := range file.Runs {
		if file.Runs[i].Status != taskRunning {
			continue
		}
		file.Runs[i].Status = taskInterrupted
		file.Runs[i].EndedAt = now
		file.Runs[i].Error = T("应用在运行结束前退出")
	}
	a.taskMu.Lock()
	a.tasks = file.Tasks
	a.taskRuns = trimTaskRuns(file.Runs)
	a.taskMu.Unlock()
	a.bumpTaskRev()
}

// normalizeTask fills defaults and trims fields.
func normalizeTask(t *scheduledTask, now time.Time) {
	if t == nil {
		return
	}
	t.ID = strings.TrimSpace(t.ID)
	t.Name = strings.TrimSpace(t.Name)
	t.Prompt = strings.TrimSpace(t.Prompt)
	t.Project = strings.TrimSpace(t.Project)
	t.Cron = strings.TrimSpace(t.Cron)
	if t.Backend != "acp" {
		t.Backend = "pi"
	}
	if t.Cron == "" {
		t.Cron = "0 9 * * *"
	}
	if t.CreatedAt.IsZero() {
		t.CreatedAt = now
	}
	if t.LastScheduledAt.IsZero() {
		t.LastScheduledAt = t.CreatedAt
	}
	if t.TimeoutMin < 0 {
		t.TimeoutMin = 0
	}
}

// trimTaskRuns keeps the newest runs.
func trimTaskRuns(runs []taskRun) []taskRun {
	sort.SliceStable(runs, func(i, j int) bool { return runs[i].StartedAt.After(runs[j].StartedAt) })
	if len(runs) > taskHistoryLimit {
		runs = runs[:taskHistoryLimit]
	}
	return runs
}

// saveTasksLocked writes the list. The caller holds taskMu.
func (a *app) saveTasksLocked() {
	path := a.tasksPath()
	if path == "" {
		return
	}
	data, err := json.MarshalIndent(tasksFile{Version: 1, Tasks: a.tasks, Runs: trimTaskRuns(a.taskRuns)}, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	_ = writeFileAtomic(path, data, 0o644)
}

// taskList is a copy for the UI.
func (a *app) taskList() []*scheduledTask {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	out := make([]*scheduledTask, 0, len(a.tasks))
	for _, t := range a.tasks {
		cp := *t
		out = append(out, &cp)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// taskRunList is a copy of the history, newest first.
func (a *app) taskRunList() []taskRun {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	out := make([]taskRun, len(a.taskRuns))
	copy(out, a.taskRuns)
	return out
}

// taskByID finds one task.
func (a *app) taskByID(id string) *scheduledTask {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	for _, t := range a.tasks {
		if t.ID == id {
			cp := *t
			return &cp
		}
	}
	return nil
}

// bumpTaskRev redraws the task windows when there is a scope.
func (a *app) bumpTaskRev() {
	if a.taskRev != nil {
		a.taskRev.Update(func(n int) int { return n + 1 })
	}
}

// startTaskScheduler ticks in the background. The stop channel is
// package-level so quitting can end it.
func (a *app) startTaskScheduler() {
	taskSchedMu.Lock()
	if taskSchedStop != nil {
		taskSchedMu.Unlock()
		return
	}
	stop := make(chan struct{})
	taskSchedStop = stop
	taskSchedMu.Unlock()
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		// The ticker only whispers; all state changes happen on the UI
		// thread so signals and toasts are safe to touch.
		a.cx.Post(func() { a.taskTick(time.Now()) })
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				a.cx.Post(func() { a.taskTick(time.Now()) })
			}
		}
	}()
}

var (
	taskSchedMu   sync.Mutex
	taskSchedStop chan struct{}
)

// stopTaskScheduler ends the ticker.
func stopTaskScheduler() {
	taskSchedMu.Lock()
	if taskSchedStop != nil {
		close(taskSchedStop)
		taskSchedStop = nil
	}
	taskSchedMu.Unlock()
}

// taskTick starts a run for every task whose next occurrence has passed.
func (a *app) taskTick(now time.Time) {
	type due struct {
		task    scheduledTask
		at      time.Time
		trigger string
	}
	var runnable []due
	changed := false
	a.taskMu.Lock()
	for _, t := range a.tasks {
		if !t.Enabled {
			continue
		}
		last := t.LastScheduledAt
		if last.IsZero() {
			last = t.CreatedAt
		}
		// A long gap (app closed for weeks) only catches up the latest
		// occurrence, never a flood of old ones.
		if now.Sub(last) > 7*24*time.Hour {
			t.LastScheduledAt = now
			changed = true
			continue
		}
		at, ok := latestTaskOccurrence(t.Cron, last, now)
		if !ok {
			continue
		}
		t.LastScheduledAt = at
		changed = true
		trigger := "schedule"
		if now.Sub(at) >= time.Minute {
			trigger = "catch-up"
		}
		runnable = append(runnable, due{task: *t, at: at, trigger: trigger})
	}
	if changed {
		a.saveTasksLocked()
	}
	a.taskMu.Unlock()
	if changed {
		a.bumpTaskRev()
	}
	for _, d := range runnable {
		a.enqueueTaskRun(d.task, d.at, d.trigger)
	}
}

// enqueueTaskRun records a run and starts it, unless the task already has
// one in flight.
func (a *app) enqueueTaskRun(t scheduledTask, at time.Time, trigger string) {
	a.taskMu.Lock()
	if a.taskRunning == nil {
		a.taskRunning = map[string]bool{}
	}
	if a.taskRunning[t.ID] {
		run := taskRun{ID: newSessionID(), TaskID: t.ID, TaskName: t.Name, Trigger: trigger,
			Status: taskSkipped, StartedAt: time.Now(), EndedAt: time.Now(), Error: T("上一次运行还没结束")}
		a.taskRuns = trimTaskRuns(append(a.taskRuns, run))
		a.saveTasksLocked()
		a.taskMu.Unlock()
		a.bumpTaskRev()
		a.toast(ui.ToastWarning, "定时任务跳过了一次", T("%s 上一次运行还没结束。", t.Name))
		return
	}
	a.taskRunning[t.ID] = true
	run := taskRun{ID: newSessionID(), TaskID: t.ID, TaskName: t.Name, Trigger: trigger,
		Status: taskRunning, StartedAt: time.Now()}
	a.taskRuns = trimTaskRuns(append(a.taskRuns, run))
	a.saveTasksLocked()
	a.taskMu.Unlock()
	a.bumpTaskRev()
	go a.runTask(t, run.ID)
}

// taskSession creates the fresh session a run uses.
func (a *app) taskSession(t scheduledTask) (*session, error) {
	var ws *workspace
	for _, w := range a.workspaces.Get() {
		if w.Path == t.Project {
			ws = w
			break
		}
	}
	if ws == nil {
		return nil, fmt.Errorf("%s", T("项目不在列表里：%s", t.Project))
	}
	if !a.projectTrusted(ws) {
		return nil, fmt.Errorf("%s", T("项目还没有被信任"))
	}
	s := a.blankSession("task-"+newSessionID(), ws, t.Name)
	s.backend = "pi"
	if t.Backend == "acp" {
		preset := a.acpPresetByID(t.ACPPreset)
		if preset == nil {
			return nil, fmt.Errorf("%s", T("找不到 ACP 预设：%s", t.ACPPreset))
		}
		s.backend = "acp"
		s.acpPreset = preset.ID
	}
	ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{s}, ss...) })
	a.touch(s)
	if a.st != nil {
		a.st.edit(func(c *config) {
			if c.Titles == nil {
				c.Titles = map[string]string{}
			}
			c.Titles[s.ID] = t.Name
		})
	}
	if t.Persona != "" && a.agentByID(t.Persona) != nil {
		a.setPersona(s, t.Persona)
	}
	a.sessionCreated(s, "task")
	return s, nil
}

// runTask starts the session, sends the prompt and waits for the turn.
func (a *app) runTask(t scheduledTask, runID string) {
	type started struct {
		s   *session
		err error
	}
	ch := make(chan started, 1)
	a.cx.Post(func() {
		s, err := a.taskSession(t)
		if err != nil {
			ch <- started{err: err}
			return
		}
		a.submitTurn(s, t.Prompt, nil, false)
		ch <- started{s: s}
	})
	res := <-ch
	if res.err != nil {
		a.finishTaskRun(t, runID, "", taskFailed, res.err.Error())
		return
	}
	s := res.s
	timeout := defaultTaskTimeout
	if t.TimeoutMin > 0 {
		timeout = time.Duration(t.TimeoutMin) * time.Minute
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !s.runningSig.GetUntracked() {
			break
		}
		time.Sleep(time.Second)
	}
	if s.runningSig.GetUntracked() {
		a.cx.Post(func() { a.stop(s) })
		for i := 0; i < 5 && s.runningSig.GetUntracked(); i++ {
			time.Sleep(time.Second)
		}
		a.finishTaskRun(t, runID, s.ID, taskTimeout, T("运行超过 %s，已停止", taskTimeoutText(timeout)))
		return
	}
	status, why := taskTurnOutcome(s)
	a.finishTaskRun(t, runID, s.ID, status, why)
}

// taskTurnOutcome reads the last turn's result.
func taskTurnOutcome(s *session) (string, string) {
	if s == nil {
		return taskFailed, T("没有创建会话")
	}
	ts := s.turns.GetUntracked()
	if len(ts) == 0 {
		return taskFailed, T("没有开始运行")
	}
	tt := ts[len(ts)-1]
	switch tt.Status {
	case chat.Completed:
		return taskOK, ""
	case chat.Cancelled:
		return taskCancelled, T("运行被停止")
	case chat.Failed:
		if tt.Err != "" {
			return taskFailed, tt.Err
		}
		return taskFailed, T("这一轮失败了")
	}
	return taskFailed, T("会话没有正常结束")
}

// taskTimeoutText says a duration in the task list's words.
func taskTimeoutText(d time.Duration) string {
	if d%time.Minute == 0 {
		return fmt.Sprintf("%d 分钟", int(d/time.Minute))
	}
	return d.Round(time.Second).String()
}

// finishTaskRun closes a run and updates its task.
func (a *app) finishTaskRun(t scheduledTask, runID, sessionID, status, why string) {
	now := time.Now()
	a.taskMu.Lock()
	for i := range a.taskRuns {
		if a.taskRuns[i].ID != runID {
			continue
		}
		a.taskRuns[i].Status = status
		a.taskRuns[i].EndedAt = now
		a.taskRuns[i].Error = why
		if sessionID != "" {
			a.taskRuns[i].SessionID = sessionID
		}
		break
	}
	for _, task := range a.tasks {
		if task.ID == t.ID {
			task.LastRunAt = now
			task.LastStatus = status
			break
		}
	}
	delete(a.taskRunning, t.ID)
	a.saveTasksLocked()
	a.taskMu.Unlock()
	title := taskStatusLabel(status)
	if why != "" {
		title = title + " · " + t.Name
	}
	a.cx.Post(func() {
		a.bumpTaskRev()
		switch status {
		case taskOK:
			a.toast(ui.ToastSuccess, "定时任务完成", t.Name)
		case taskTimeout, taskFailed, taskInterrupted:
			a.toast(ui.ToastError, "定时任务失败", t.Name+"："+why)
		case taskCancelled, taskSkipped:
			a.toast(ui.ToastInfo, title, t.Name)
		}
	})
}

// taskStatusLabel names a run status.
func taskStatusLabel(status string) string {
	switch status {
	case taskRunning:
		return T("运行中")
	case taskOK:
		return T("完成")
	case taskFailed:
		return T("失败")
	case taskTimeout:
		return T("超时")
	case taskSkipped:
		return T("跳过")
	case taskCancelled:
		return T("已停止")
	case taskInterrupted:
		return T("已中断")
	}
	return status
}

// taskNextRun is the next time the task fires, zero when it cannot.
func taskNextRun(t *scheduledTask, now time.Time) time.Time {
	if t == nil || !t.Enabled {
		return time.Time{}
	}
	at, err := nextTaskCron(t.Cron, now)
	if err != nil {
		return time.Time{}
	}
	return at
}

// taskScheduleText describes the next run.
func (a *app) taskScheduleText(t *scheduledTask) string {
	next := taskNextRun(t, time.Now())
	if next.IsZero() {
		if !t.Enabled {
			return T("已暂停")
		}
		return T("表达式无效")
	}
	return T("下次 ") + next.Format("01-02 15:04")
}

// --- task editor ---

// openTaskDialog shows the list.
func (a *app) openTaskDialog() {
	a.taskErr.Set("")
	a.taskOpen.Set(true)
}

// openTaskForm starts a new task with the active project filled in.
func (a *app) openTaskForm() {
	a.taskEditID.Set("")
	a.taskName.Set("")
	a.taskCron.Set("0 9 * * *")
	a.taskPrompt.Set("")
	project := ""
	if ws := a.activeWorkspace(); ws != nil {
		project = ws.Path
	}
	a.taskProject.Set(project)
	a.taskBackend.Set("pi")
	a.taskPreset.Set("")
	a.taskPersona.Set("")
	a.taskEnabled.Set(true)
	a.taskTimeout.Set("30")
	a.taskErr.Set("")
	a.taskFormOpen.Set(true)
}

// editTask loads one into the form.
func (a *app) editTask(id string) {
	t := a.taskByID(id)
	if t == nil {
		a.taskErr.Set("找不到这个任务")
		return
	}
	a.taskEditID.Set(t.ID)
	a.taskName.Set(t.Name)
	a.taskCron.Set(t.Cron)
	a.taskPrompt.Set(t.Prompt)
	a.taskProject.Set(t.Project)
	a.taskBackend.Set(t.Backend)
	a.taskPreset.Set(t.ACPPreset)
	a.taskPersona.Set(t.Persona)
	a.taskEnabled.Set(t.Enabled)
	if t.TimeoutMin > 0 {
		a.taskTimeout.Set(fmt.Sprint(t.TimeoutMin))
	} else {
		a.taskTimeout.Set("")
	}
	a.taskErr.Set("")
	a.taskFormOpen.Set(true)
}

// saveTaskForm validates the editor and writes the task.
func (a *app) saveTaskForm() {
	name := strings.TrimSpace(a.taskName.GetUntracked())
	cron := strings.TrimSpace(a.taskCron.GetUntracked())
	prompt := strings.TrimSpace(a.taskPrompt.GetUntracked())
	project := strings.TrimSpace(a.taskProject.GetUntracked())
	backend := a.taskBackend.GetUntracked()
	preset := strings.TrimSpace(a.taskPreset.GetUntracked())
	persona := strings.TrimSpace(a.taskPersona.GetUntracked())
	timeoutText := strings.TrimSpace(a.taskTimeout.GetUntracked())
	timeout := 0
	if timeoutText != "" {
		n, err := strconv.Atoi(timeoutText)
		if err != nil || n <= 0 {
			a.taskErr.Set(T("超时时间要写成正整数分钟，留空用 30 分钟。"))
			return
		}
		timeout = n
	}
	switch {
	case name == "" || prompt == "":
		a.taskErr.Set(T("名称和提示词都要填。"))
		return
	case project == "":
		a.taskErr.Set(T("选一个项目。"))
		return
	}
	if _, err := parseTaskCron(cron); err != nil {
		a.taskErr.Set(T("执行时间看不懂：") + err.Error())
		return
	}
	if backend == "acp" {
		if preset == "" {
			if ws := a.workspaceOf(project); ws != nil {
				preset = ws.ACPPreset
			}
		}
		if preset == "" {
			list := a.acpPresetList()
			if len(list) > 0 {
				preset = list[0].ID
			}
		}
		if a.acpPresetByID(preset) == nil {
			a.taskErr.Set(T("ACP 后端要选一个预设。"))
			return
		}
	}
	now := time.Now()
	edited := a.taskEditID.GetUntracked()
	a.taskMu.Lock()
	if edited == "" {
		a.tasks = append(a.tasks, &scheduledTask{ID: newSessionID(), Name: name, Prompt: prompt, Project: project,
			Cron: cron, Backend: backend, ACPPreset: preset, Persona: persona, Enabled: a.taskEnabled.GetUntracked(),
			TimeoutMin: timeout, CreatedAt: now, UpdatedAt: now, LastScheduledAt: now})
	} else {
		found := false
		for _, t := range a.tasks {
			if t.ID != edited {
				continue
			}
			oldCron, oldEnabled := t.Cron, t.Enabled
			t.Name, t.Prompt, t.Project, t.Cron = name, prompt, project, cron
			t.Backend, t.ACPPreset, t.Persona = backend, preset, persona
			t.Enabled, t.TimeoutMin, t.UpdatedAt = a.taskEnabled.GetUntracked(), timeout, now
			// Editing the expression must not replay the old one.
			if oldCron != cron || (!oldEnabled && t.Enabled) {
				t.LastScheduledAt = now
			}
			found = true
			break
		}
		if !found {
			a.taskMu.Unlock()
			a.taskErr.Set(T("找不到这个任务。"))
			return
		}
	}
	a.saveTasksLocked()
	a.taskMu.Unlock()
	a.bumpTaskRev()
	a.taskFormOpen.Set(false)
	a.taskErr.Set("")
	a.toast(ui.ToastSuccess, "已保存定时任务", name)
}

// toggleTask switches one on or off.
func (a *app) toggleTask(id string, enabled bool) {
	a.taskMu.Lock()
	for _, t := range a.tasks {
		if t.ID != id {
			continue
		}
		t.Enabled = enabled
		t.UpdatedAt = time.Now()
		t.LastScheduledAt = time.Now()
		break
	}
	a.saveTasksLocked()
	a.taskMu.Unlock()
	a.bumpTaskRev()
}

// removeTask deletes one and keeps its history.
func (a *app) removeTask(id string) {
	a.taskMu.Lock()
	out := a.tasks[:0]
	for _, t := range a.tasks {
		if t.ID != id {
			out = append(out, t)
		}
	}
	a.tasks = out
	a.saveTasksLocked()
	a.taskMu.Unlock()
	a.bumpTaskRev()
	a.toast(ui.ToastInfo, "已删除定时任务", "")
}

// runTaskNow starts a task by hand.
func (a *app) runTaskNow(id string) {
	t := a.taskByID(id)
	if t == nil {
		a.toast(ui.ToastWarning, "找不到这个任务", "")
		return
	}
	a.enqueueTaskRun(*t, time.Now(), "manual")
}

// taskProjectLabel names a task's project.
func (a *app) taskProjectLabel(t *scheduledTask) string {
	if t == nil || t.Project == "" {
		return T("没有项目")
	}
	if ws := a.workspaceOf(t.Project); ws != nil {
		return ws.label()
	}
	return projectLabel(t.Project)
}

// taskBackendLabel names what a task runs on.
func (a *app) taskBackendLabel(t *scheduledTask) string {
	if t != nil && t.Backend == "acp" {
		label := "ACP"
		if p := a.acpPresetByID(t.ACPPreset); p != nil {
			label = "ACP · " + p.Name
		}
		return label
	}
	return "pi"
}
