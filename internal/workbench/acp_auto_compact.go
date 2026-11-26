//go:build !js && !android && !ios

package workbench

import "example.com/pideck-v2/internal/remotewire"

const acpAutoCompactThreshold = 80

// updateACPContextUsage projects an ACP usage_update into the same context
// figures the session overview already reads.
func updateACPContextUsage(stats sessionStats, used, size int) (sessionStats, bool) {
	if used < 0 || size <= 0 {
		return stats, false
	}
	stats.ContextTokens = used
	stats.ContextWindow = size
	stats.ContextPercent = float64(used) * 100 / float64(size)
	return stats, true
}

func acpContextAboveThreshold(used, size int) bool {
	return size > 0 && used >= 0 && float64(used)*100 >= float64(size)*acpAutoCompactThreshold
}

// acpShouldAutoCompact permits only Codex's advertised native command, and
// only for a threshold crossing observed from ACP usage updates.
func acpShouldAutoCompact(presetID string, stats sessionStats, commands []acpCommand, pending bool) bool {
	if presetID != "codex" || !pending || !acpContextAboveThreshold(stats.ContextTokens, stats.ContextWindow) {
		return false
	}
	for _, command := range commands {
		if command.Name == "compact" {
			return true
		}
	}
	return false
}

// promptWithAutoCompact runs Codex's native compact command before the user's
// prompt. A failed compact does not discard or block the user's request.
func (c *acpClient) promptWithAutoCompact(sessionID, text string, images []remotewire.Image, compact bool, onCompact func(error, bool)) (stop string, err, compactErr error, compacted bool) {
	if compact {
		c.compacting.Store(true)
		compactStop, err := c.prompt(sessionID, "/compact")
		c.compacting.Store(false)
		compactErr = err
		if compactStop == "cancelled" {
			if onCompact != nil {
				onCompact(compactErr, false)
			}
			return compactStop, nil, compactErr, false
		}
		compacted = err == nil
		if onCompact != nil {
			onCompact(compactErr, compacted)
		}
	}
	stop, err = c.prompt(sessionID, text, images...)
	return stop, err, compactErr, compacted
}
