//go:build !js && !android && !ios

package workbench

import "time"

const (
	acpSilenceDefault = 120 // seconds
	acpSilenceMin     = 30
	acpSilenceMax     = 900
	acpStopGrace      = 8 * time.Second
)

type acpStopReason uint8

const (
	acpStopNone acpStopReason = iota
	acpStopManual
	acpStopTimeout
)

func acpSilenceSeconds(seconds int) int {
	if seconds < acpSilenceMin || seconds > acpSilenceMax {
		return acpSilenceDefault
	}
	return seconds
}

// armACPWatchdog watches the interval between updates, rather than the
// total length of a turn. Time spent on an approval is the user's time.
func (a *app) armACPWatchdog(s *session, c *acpClient, turnID string) {
	period := time.Duration(acpSilenceSeconds(a.cfg.ACPSilenceSec)) * time.Second
	s.acpProgress = a.cx.Now()
	s.acpStopReason = acpStopNone
	var check func()
	check = func() {
		if s.acp != c || s.acpTurnID != turnID || s.acpStopReason != acpStopNone {
			return
		}
		if s.ask.GetUntracked() != nil {
			s.acpProgress = a.cx.Now()
			a.cx.AfterFunc(period, check)
			return
		}
		if remaining := period - a.cx.Now().Sub(s.acpProgress); remaining > 0 {
			a.cx.AfterFunc(remaining, check)
			return
		}
		a.stopACPTurn(s, acpStopTimeout)
	}
	a.cx.AfterFunc(period, check)
}

func (a *app) stopACPTurn(s *session, reason acpStopReason) {
	if s.acpStopReason != acpStopNone {
		return
	}
	if s.acpTurnID == "" {
		a.cancelACPStartingTurn(s)
		return
	}
	c, sid, turnID := s.acp, s.acpSID, s.acpTurnID
	if c == nil {
		return
	}
	s.acpStopReason = reason
	s.status.Set(statusWaiting)
	go c.cancel(sid)
	a.cx.AfterFunc(acpStopGrace, func() {
		if s.acp != c || s.acpTurnID != turnID {
			return
		}
		// Detach first: late replies or an exit from the old process cannot
		// settle the turn a second time or affect the next connection.
		s.acp = nil
		s.acpGeneration++
		s.readySig.Set(false)
		go func() {
			_ = c.cmd.Process.Kill()
			c.stop()
		}()
		a.acpFinish(s, turnID, "cancelled", nil)
	})
}

func (a *app) cancelACPStartingTurn(s *session) {
	if !s.starting {
		return
	}
	ts := s.turns.GetUntracked()
	if len(ts) == 0 || !ts[len(ts)-1].running() {
		return
	}
	s.waiters = nil
	s.acpTurnID = ts[len(ts)-1].ID
	s.acpStopReason = acpStopManual
	a.acpFinish(s, s.acpTurnID, "cancelled", nil)
}

func (a *app) detachACP(s *session) <-chan struct{} {
	s.acpGeneration++
	c, pending := s.acp, s.acpStarting
	s.acp, s.acpStarting = nil, nil
	done := make(chan struct{})
	go func() {
		defer close(done)
		if c == nil && pending != nil {
			c = <-pending
		}
		if c != nil {
			c.stop()
		}
	}()
	s.sending.Set(nil)
	if s.acpTurnID != "" {
		s.acpStopReason = acpStopManual
		a.acpFinish(s, s.acpTurnID, "cancelled", nil)
	} else {
		a.cancelACPStartingTurn(s)
	}
	s.starting = false
	s.waiters = nil
	s.readySig.Set(false)
	s.acpOptionBusy.Set(false)
	s.status.Set(statusIdle)
	s.notice.Set("")
	a.cancelAsks(s)
	return done
}
