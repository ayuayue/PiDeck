//go:build !js && !android && !ios

package workbench

// The composer's modes and delivery: what the next prompt asks for (a
// plan, a goal that keeps going, or a picture), how a message joins a
// running turn (steering before its next call, or a follow-up after the
// turn ends), and how a blank session changes backend.

import (
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui"
)

// The composer's modes.
const (
	modeNormal = "normal"
	modePlan   = "plan"
	modeGoal   = "goal"
	modeImage  = "imagegen"
)

// How a message reaches a running turn.
const (
	deliverySteer    = "steer"
	deliveryFollowUp = "followUp"
	// deliveryParallel starts the message in a session of its own instead.
	deliveryParallel = "parallel"
)

// goalMaxRounds bounds a goal before it pauses for the user.
const goalMaxRounds = 12

// goalDoneMark ends a goal's final answer.
const goalDoneMark = "目标已完成"

// goalBlockedMark ends an answer that cannot go on alone.
const goalBlockedMark = "需要你的决定"

// queuedMessage keeps the complete input while it waits for delivery.
type queuedMessage struct {
	ID        string
	Text      string
	Images    []remotewire.Image
	At        time.Time
	QueueText string // pi's expanded text, used to reconcile its text-only queue events
	Pending   bool   // the enqueue command has not been acknowledged yet
}

// modeOf is the session's mode, normal when unset.
func modeOf(s *session) string {
	if s == nil || s.agentMode == nil {
		return modeNormal
	}
	if m := s.agentMode.GetUntracked(); m != "" {
		return m
	}
	return modeNormal
}

// modeOn reports whether the session is in one of the given modes.
func modeOn(s *session, modes ...string) bool {
	m := modeOf(s)
	for _, want := range modes {
		if m == want {
			return true
		}
	}
	return false
}

// setAgentMode switches the composer's mode and clears what the old one
// held.
func (a *app) setAgentMode(s *session, mode string) {
	if s == nil || s.agentMode == nil {
		return
	}
	if mode == "" {
		mode = modeNormal
	}
	s.agentMode.Set(mode)
	s.modeOpen.Set(false)
	if mode != modeGoal {
		s.goalRounds = 0
		s.goalPaused.Set(false)
	}
}

// togglePlanMode flips the next turn between planning and doing.
func (a *app) togglePlanMode(s *session) {
	if s == nil {
		return
	}
	if modeOf(s) == modePlan {
		a.setAgentMode(s, modeNormal)
		return
	}
	a.setAgentMode(s, modePlan)
	a.toast(ui.ToastInfo, "计划模式已开启", "下一轮会先给计划，确认后再执行。")
}

// toggleGoalMode starts or stops a goal that goes on by itself.
func (a *app) toggleGoalMode(s *session) {
	if s == nil {
		return
	}
	if modeOf(s) == modeGoal {
		a.setAgentMode(s, modeNormal)
		return
	}
	a.setAgentMode(s, modeGoal)
	s.goalRounds = 0
	a.toast(ui.ToastInfo, "目标模式已开启", "发一句话当目标：没完成时它会自己继续，停下或说完成为止。")
}

// toggleImageMode turns the composer into a picture prompt.
func (a *app) toggleImageMode(s *session) {
	if s == nil {
		return
	}
	if modeOf(s) == modeImage {
		a.setAgentMode(s, modeNormal)
		return
	}
	a.setAgentMode(s, modeImage)
	if a.imageProviderForComposer() == "" {
		a.toast(ui.ToastInfo, "还没有生图供应商", "到 设置 → 模型与认证 里配置一个支持 /images/generations 的供应商。")
		return
	}
	if strings.TrimSpace(a.cfg.ImageModel) == "" {
		a.toast(ui.ToastInfo, "还没有生图模型", "点输入框里的「生图设置」填模型名，或打开生图对话框。")
	}
}

// goalPrompt wraps a request as a goal that may take several turns.
func goalPrompt(text string) string {
	return apptext.T("这是一个需要多轮推进的目标。每轮只做当前最重要的一步，做完用一两句说明改了什么、怎么验证；") + "\n" +
		apptext.T("没完成就不要停下等我确认，我会让你继续。") + "\n" +
		apptext.T("全部完成时，最后一行只写「%s」；需要我决定时，最后一行写「%s：…」。", goalDoneMark, goalBlockedMark) + "\n\n" +
		apptext.T("目标：") + "\n" + text
}

// goalContinuePrompt asks for the goal's next step.
func goalContinuePrompt(round int) string {
	return apptext.T("继续推进上面的目标，接着做下一步（第 %d 轮）。", round) + "\n" +
		apptext.T("完成后最后一行只写「%s」；需要我决定时写「%s：…」。", goalDoneMark, goalBlockedMark)
}

// goalState is how a goal's answer leaves it.
type goalState int

const (
	goalGoOnState goalState = iota
	goalFinishedState
	goalBlockedState
)

// goalNext decides what follows a goal turn.
func goalNext(s *session, status, answer string, rounds int) goalState {
	if s == nil {
		return goalBlockedState
	}
	return goalNextFor(modeOf(s), status, answer, rounds)
}

// goalNextFor is goalNext's decision, apart from the session.
func goalNextFor(mode, status, answer string, rounds int) goalState {
	if mode != modeGoal {
		return goalBlockedState
	}
	if status != "completed" {
		return goalBlockedState
	}
	if strings.Contains(answer, goalDoneMark) {
		return goalFinishedState
	}
	if strings.Contains(answer, goalBlockedMark) {
		return goalBlockedState
	}
	if rounds >= goalMaxRounds {
		return goalBlockedState
	}
	return goalGoOnState
}

// onGoalTurn carries a goal on when a turn ends.
func (a *app) onGoalTurn(ev appEvent) {
	s := ev.Session
	if s == nil || modeOf(s) != modeGoal || s.goalPaused.GetUntracked() {
		return
	}
	switch goalNext(s, ev.Data["status"], ev.Data["answer"], s.goalRounds) {
	case goalFinishedState:
		s.goalRounds = 0
		s.goalPaused.Set(false)
		a.setAgentMode(s, modeNormal)
		a.bumpSessionUI(s)
		a.toast(ui.ToastSuccess, "目标已完成", "已切回普通模式，可以接着聊。")
		a.emit(eventPlanFinished, appEvent{Session: s, Data: map[string]string{"status": "finished", "mode": modeGoal}})
	case goalBlockedState:
		s.goalPaused.Set(true)
		a.bumpSessionUI(s)
		a.toast(ui.ToastInfo, "目标已暂停", "这一轮没推进完，或到了轮次上限；点目标标签继续。")
	case goalGoOnState:
		// A queued message goes first: the user asked for it.
		if len(s.sending.GetUntracked()) > 0 {
			return
		}
		// A beat after the turn closes: the app has written its last delta
		// and the stop button is live again if the user wants it.
		a.cx.AfterFunc(400*time.Millisecond, func() {
			if modeOf(s) != modeGoal || s.goalPaused.GetUntracked() || s.busyNow() {
				return
			}
			a.submitGoalTurn(s)
		})
	}
}

// submitGoalTurn sends the goal's next round.
func (a *app) submitGoalTurn(s *session) {
	if s == nil || s.busyNow() {
		return
	}
	s.goalRounds++
	a.bumpSessionUI(s)
	a.submitTurn(s, goalContinuePrompt(s.goalRounds), nil, false)
}

// resumeGoal lets a paused goal go on after the user stopped it.
func (a *app) resumeGoal(s *session) {
	if s == nil {
		return
	}
	s.goalPaused.Set(false)
	a.bumpSessionUI(s)
	if !s.busyNow() {
		a.submitGoalTurn(s)
	}
}

// pauseGoal holds a goal until the user asks for the next round.
func (a *app) pauseGoal(s *session) {
	if s == nil {
		return
	}
	s.goalPaused.Set(true)
	a.bumpSessionUI(s)
	a.toast(ui.ToastInfo, "目标已暂停", "点目标标签继续，或按停止结束这一轮。")
}

// delivery is how a message goes into a running turn right now: the
// session's own choice, or steering before the next call.
func delivery(s *session) string {
	if s == nil {
		return deliverySteer
	}
	chosen := ""
	if s.sendMode != nil {
		chosen = s.sendMode.GetUntracked()
	}
	return deliveryFor(s.backend, chosen)
}

// deliveryFor is delivery's decision, apart from the session: ACP has no
// steering channel, so its messages wait for the turn's end.
func deliveryFor(backend, chosen string) string {
	if backend == "acp" {
		return deliveryFollowUp
	}
	if chosen == deliveryFollowUp || chosen == deliverySteer {
		return chosen
	}
	return deliverySteer
}

// send submits the draft: a prompt when idle, a steer or follow-up when
// busy, a picture in image mode.
func (a *app) send() {
	s := a.active()
	if s.filesLoading() {
		return
	}
	if s != nil && !modeOn(s, modeImage) {
		if script, ok := shellDraft(s.draft.GetUntracked()); ok {
			a.runShellDraft(s, script)
			return
		}
	}
	a.sendDraft(s, "")
}

// sendDraft sends the draft with one delivery behavior, "" for the
// session's chosen one.
func (a *app) sendDraft(s *session, behavior string) {
	if s == nil || s.filesLoading() {
		return
	}
	text := strings.TrimSpace(s.draft.GetUntracked())
	if text == "" {
		// A voice input method draws its sentence without committing it.
		// Send takes it as the draft instead of staying dead until Return.
		if composing := pastedTextComposing(s); composing != "" {
			text = composing
			s.sentComposition = composing
			clearComposing(s)
		}
	}
	images := s.images.GetUntracked()
	if text == "" && len(images) == 0 && len(pastedFiles(s)) == 0 {
		return
	}
	if modeOf(s) == modeImage {
		if text == "" {
			return
		}
		s.draft.Set("")
		a.generateComposerImage(s, text)
		return
	}
	if ws := a.workspaceFor(s.Target, s.WS); ws != nil && !a.projectTrusted(ws) {
		a.askTrust(ws, func() {
			s.draft.Set(text)
			s.images.Set(images)
			a.sendDraft(s, behavior)
		})
		return
	}
	// Long pastes join the message just before it goes, wherever it goes.
	text = a.foldPastedText(s, text)
	if behavior == deliveryParallel {
		s.draft.Set("")
		s.images.Set(nil)
		a.parallelSend(s, text)
		return
	}
	if s.busyNow() {
		s.draft.Set("")
		s.images.Set(nil)
		switch behavior {
		case deliverySteer, deliveryFollowUp:
		default:
			behavior = delivery(s)
		}
		if behavior == deliveryFollowUp || backendOf(s) == "acp" {
			a.queueFollowUp(s, text, images)
			return
		}
		a.steer(s, text, images)
		return
	}
	s.draft.Set("")
	s.images.Set(nil)
	a.submit(s, text, images)
}

// submit starts a turn and asks pi to answer it, as the mode says.
func (a *app) submit(s *session, text string, images []remotewire.Image) {
	a.submitTurn(s, text, images, modeOn(s, modePlan))
}

// queueFollowUp holds a message for the end of the running turn.
func (a *app) queueFollowUp(s *session, text string, images []remotewire.Image) {
	if s == nil || (strings.TrimSpace(text) == "" && len(images) == 0) {
		return
	}
	msg := newQueuedMessage(a.cx.Now(), text, images)
	s.sending.Update(func(list []queuedMessage) []queuedMessage {
		return append(append([]queuedMessage(nil), list...), msg)
	})
	a.toast(ui.ToastInfo, "已排队", "这一轮结束后自动发出去。")
}

// flushFollowUps sends the oldest queued message once the turn is over.
func (a *app) flushFollowUps(s *session) {
	if s == nil || s.busyNow() || s.queueWorking() {
		return
	}
	list := s.sending.GetUntracked()
	if len(list) == 0 {
		return
	}
	rest, first := popQueued(list)
	if first == nil {
		return
	}
	s.sending.Set(rest)
	a.submit(s, first.Text, first.Images)
}

// onQueuedTurn sends the oldest held follow-up once a turn is over.
func (a *app) onQueuedTurn(ev appEvent) {
	s := ev.Session
	if s == nil || len(s.sending.GetUntracked()) == 0 {
		return
	}
	// After the finished turn's own cleanup, so the next prompt finds an
	// idle session.
	a.cx.AfterFunc(120*time.Millisecond, func() { a.flushFollowUps(s) })
}

// popQueued takes the oldest held message off the list.
func popQueued(list []queuedMessage) ([]queuedMessage, *queuedMessage) {
	if len(list) == 0 {
		return list, nil
	}
	first := list[0]
	rest := append([]queuedMessage(nil), list[1:]...)
	if rest == nil {
		rest = []queuedMessage{}
	}
	return rest, &first
}

// takeQueued drops one held message and returns it.
func takeQueued(list []queuedMessage, id string) ([]queuedMessage, *queuedMessage) {
	out := make([]queuedMessage, 0, len(list))
	var found *queuedMessage
	for _, m := range list {
		if m.ID == id && found == nil {
			cp := m
			found = &cp
			continue
		}
		out = append(out, m)
	}
	return out, found
}

// clearQueue drops pending messages without racing a steering command.
func (a *app) clearQueue(s *session) {
	a.editQueue(s, "", deliverySteer, queueDelete, nil)
}

// parallelSend starts the draft in a session of its own, so it works while
// this conversation carries on.
func (a *app) parallelSend(s *session, text string) {
	text = strings.TrimSpace(text)
	if s == nil || text == "" {
		return
	}
	ws := a.workspaceOf(s.WS)
	if ws == nil {
		if w := a.activeWorkspace(); w != nil {
			ws = w
		}
	}
	if ws == nil {
		a.toast(ui.ToastInfo, "先选一个项目", "并行会话要在项目里运行。")
		return
	}
	prev := a.activeID.GetUntracked()
	ns := a.blankSession(newSessionID(), ws, apptext.T("并行")+" · "+viewkit.FirstLine(text, 30))
	ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{ns}, ss...) })
	a.submit(ns, text, nil)
	a.touch(ns)
	a.sessionCreated(ns, "parallel")
	if prev != "" && a.byID[prev] != nil {
		a.selectSession(a.byID[prev])
	}
	a.toastAction(ui.ToastSuccess, "已并行发送", viewkit.FirstLine(text, 60), "打开", func() {
		if a.byID[ns.ID] != nil {
			a.selectSession(ns)
		}
	})
}

// imageProviderForComposer is the provider a composer picture uses.
func (a *app) imageProviderForComposer() string {
	if id := strings.TrimSpace(a.cfg.ImageProvider); id != "" {
		for _, cfg := range readProviderConfigs() {
			if cfg.ID == id {
				return id
			}
		}
	}
	for _, cfg := range readProviderConfigs() {
		return cfg.ID
	}
	return ""
}

// generateComposerImage draws the draft and puts the picture in the
// composer, ready to send or save.
func (a *app) generateComposerImage(s *session, prompt string) {
	if s == nil {
		return
	}
	if a.aiBusy.GetUntracked() != "" {
		a.toast(ui.ToastInfo, "还在生成上一张", "等它出来再发。")
		return
	}
	id := a.imageProviderForComposer()
	var cfg *providerConfig
	for _, p := range readProviderConfigs() {
		if p.ID == id {
			cp := p
			cfg = &cp
			break
		}
	}
	if cfg == nil {
		a.toast(ui.ToastError, "生图失败", "先到 设置 → 模型与认证 里配置一个生图供应商。")
		return
	}
	model := strings.TrimSpace(a.cfg.ImageModel)
	if model == "" {
		a.toast(ui.ToastInfo, "先选生图模型", "点输入框里的「生图设置」填模型名。")
		return
	}
	size := firstNonEmpty(a.cfg.ImageSize, "1024x1024")
	a.aiBusy.Set("image")
	go func() {
		images, err := generateImage(*cfg, model, prompt, size, 1)
		a.cx.Post(func() {
			a.aiBusy.Set("")
			if err != nil {
				s.draft.Set(prompt)
				a.toast(ui.ToastError, "生图失败", viewkit.FirstLine(err.Error(), 160))
				return
			}
			for _, img := range images {
				a.addImage(s, remotewire.Image{Data: img.Data, MimeType: img.Mime, Name: "generated." + strings.TrimPrefix(imageExt(img.Mime), ".")})
			}
			// Back to a normal prompt: the picture is what gets sent now,
			// not another description.
			a.setAgentMode(s, modeNormal)
			a.toast(ui.ToastSuccess, "已生成图片", "已经放进输入框，可以直接发给 pi，或在生图对话框里另存。")
			a.emit(eventImageGenerated, appEvent{Session: s, Data: map[string]string{
				"provider": cfg.ID, "model": model, "size": size, "count": "1", "from": "composer",
			}})
		})
	}()
}

// backendLocked says whether a session can still change backend: its first
// message fixes where the transcript lives. Speculative startup does not
// lock the choice.
func (a *app) backendLocked(s *session) bool {
	if s == nil {
		return false
	}
	return len(s.turns.GetUntracked()) > 0
}

// backendOf is the session's backend, pi when unset.
func backendOf(s *session) string {
	if s == nil || s.backend == "" {
		return "pi"
	}
	return s.backend
}

// setBackend switches a blank session between pi and an ACP preset.
func (a *app) setBackend(s *session, backend, presetID string) {
	if s == nil {
		return
	}
	if a.backendLocked(s) {
		a.toast(ui.ToastInfo, "这个会话已经开始了", "后端在第一条消息时定下；要换后端请新建会话。")
		return
	}
	cur := backendOf(s)
	if backend == "" {
		backend = "pi"
	}
	if cur == backend && (backend != "acp" || s.acpPreset == presetID) {
		s.backendOpen.Set(false)
		return
	}
	s.backendOpen.Set(false)
	s.cancelPrewarm()
	s.prewarming = false
	s.agentClosed = false
	s.uiSeq.Update(func(v int) int { return v + 1 })
	switch backend {
	case "acp":
		preset := a.acpPresetByID(presetID)
		if preset == nil {
			a.toast(ui.ToastError, "没有这个 ACP 预设", presetID)
			return
		}
		if s.acp != nil || s.acpStarting != nil {
			a.detachACP(s)
		}
		if s.engine != nil || s.piStarting != nil {
			// pi's process is not this session's backend any more: stop it
			// off the UI thread and discard its remaining startup callbacks.
			s.piGeneration.Add(1)
			c, pending := s.engine, s.piStarting
			s.engine, s.piStarting = nil, nil
			s.starting = false
			go func() {
				if c == nil && pending != nil {
					c = <-pending
				}
				if c != nil {
					c.stop()
				}
			}()
		}
		a.releaseWarmPi(s)
		if ws := a.workspaceFor(s.Target, s.WS); ws != nil && ws.ACPPreset != preset.ID {
			// Remember the choice without starting the agent.
			ws.ACPPreset = preset.ID
			a.saveProjects()
		}
		s.waiters = nil
		s.backend = "acp"
		s.acpPreset = preset.ID
		s.acpSID = ""
		if modeOn(s, modeImage) {
			a.setAgentMode(s, modeNormal) // ACP has no picture channel
		}
		s.acpMode.Set("")
		s.acpModes.Set(nil)
		s.acpOptions.Set(nil)
		s.acpCommands.Set(nil)
		s.acpModeOpen.Set(false)
		s.acpThinkOpen.Set(false)
		s.modelOpen.Set(false)
		s.readySig.Set(false)
		s.status.Set(statusIdle)
		a.toast(ui.ToastInfo, "已切到 ACP · "+preset.Name, "agent 的模型、模式和命令会显示在输入框里。")
	default:
		if s.acp != nil || s.acpStarting != nil {
			a.detachACP(s)
		}
		s.backend = ""
		s.acpPreset = ""
		s.acpSID = ""
		s.acpMode.Set("")
		s.acpModes.Set(nil)
		s.acpOptions.Set(nil)
		s.acpCommands.Set(nil)
		s.acpModeOpen.Set(false)
		s.acpThinkOpen.Set(false)
		s.modelOpen.Set(false)
		s.readySig.Set(false)
		s.status.Set(statusIdle)
		a.toast(ui.ToastInfo, "已切回 pi", "")
	}
	a.scheduleSessionPrewarm(s)
}
