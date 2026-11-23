//go:build !js && !android && !ios

package workbench

// The usage panel's two numbers pi does not report: how fast the last reply
// came, and how much of every prompt the cache served. The panel reads both
// from s.perf, and this file is the only place that writes them.

import "time"

// cacheHitShare is a prompt's cached share, the way pi's footer counts it:
// cacheRead over input, cacheRead and cacheWrite. A prompt with no tokens
// at all is -1, unknown.
func cacheHitShare(u usageInfo) float64 {
	total := u.Input + u.CacheRead + u.CacheWrite
	if total <= 0 {
		return -1
	}
	return float64(u.CacheRead) * 100 / float64(total)
}

// messageUsage is what a committed message reported it spent.
func messageUsage(m piMessage) usageInfo {
	if m.Usage == nil {
		return usageInfo{}
	}
	return usageInfo{Input: m.Usage.Input, Output: m.Usage.Output, CacheRead: m.Usage.CacheRead,
		CacheWrite: m.Usage.CacheWrite, Total: m.Usage.Total, Cost: m.Usage.Cost.Total}
}

// historyPerf counts a transcript's cache record: the last cached share and
// the mean over its messages, so a session that was opened from its file
// shows the same numbers it showed while it ran.
func historyPerf(msgs []piMessage) replyPerf {
	var p replyPerf
	for _, m := range msgs {
		if m.Role != "assistant" {
			continue
		}
		if hit := cacheHitShare(messageUsage(m)); hit >= 0 {
			p.HitLast, p.HasHit = hit, true
			p.HitSum += hit
			p.HitCount++
		}
	}
	return p
}

// publishHistoryPerf keeps a loaded transcript's cache record on the
// session, leaving the last reply's pace alone: a live turn may have a
// fresher one.
func (a *app) publishHistoryPerf(s *session, msgs []piMessage) {
	if s == nil || len(msgs) == 0 {
		return
	}
	hist := historyPerf(msgs)
	if !hist.HasHit {
		return
	}
	s.perf.Update(func(old replyPerf) replyPerf {
		old.HitLast, old.HasHit, old.HitSum, old.HitCount = hist.HitLast, true, hist.HitSum, hist.HitCount
		return old
	})
}

// noteReplyPerf publishes the reply that just ended: how long it took, what
// it wrote, and its cached share of the prompt.
func (a *app) noteReplyPerf(s *session, usage usageInfo) {
	now := a.cx.Now()
	start, ttft := s.replyStart, s.replyTTFT
	s.replyStart, s.replyTTFT = time.Time{}, 0
	hit := cacheHitShare(usage)
	s.perf.Update(func(p replyPerf) replyPerf {
		if !start.IsZero() {
			p.Total, p.HasReplySpeed = now.Sub(start), true
			p.TTFT, p.HasTTFT = ttft, ttft > 0
			p.Output = usage.Output
		}
		if usage.Total > 0 {
			p.LastPrompt = usage.Total
		}
		if hit >= 0 {
			p.HitLast, p.HasHit = hit, true
			p.HitSum += hit
			p.HitCount++
		}
		return p
	})
}

// noteFirstToken records when a reply's first token showed, from the
// message that started it.
func (a *app) noteFirstToken(s *session) {
	if s.replyStart.IsZero() || s.replyTTFT != 0 {
		return
	}
	s.replyTTFT = a.cx.Now().Sub(s.replyStart)
}
