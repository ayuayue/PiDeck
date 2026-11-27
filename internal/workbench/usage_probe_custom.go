//go:build !js && !android && !ios

package workbench

import "math"

func usageProbeParseCustom(body any, resolver string) (usageProbeValues, bool) {
	switch resolver {
	case "xai-billing":
		return usageProbeParseXAI(body)
	case "codex-usage":
		return usageProbeParseCodex(body)
	case "commandcode-credits":
		return usageProbeParseCommandCode(body)
	case "kimi-credits":
		return usageProbeParseKimi(body)
	case "sub2api-usage":
		return usageProbeParseSub2API(body)
	case "volcengine-plan":
		return usageProbeParseVolcengine(body)
	case "minimax-plan":
		return usageProbeParseMinimax(body)
	}
	return usageProbeValues{}, false
}

func usageProbeParseXAI(body any) (usageProbeValues, bool) {
	values := usageProbeValues{}
	config := usageProbeObject(usageProbeGet(body, "config"))
	if config == nil {
		return values, false
	}
	cents := func(path string) *float64 {
		if n := usageProbeN(config, path+".val"); n != nil {
			return usageProbeFloat(*n / 100)
		}
		return nil
	}
	if percent := usageProbeN(config, "creditUsagePercent"); percent != nil && *percent >= 0 && *percent <= 100 {
		values.windows = append(values.windows, usageProbeWindow{key: "included", total: usageProbeFloat(100), used: percent})
	} else if total, used := cents("monthlyLimit"), cents("used"); total != nil || used != nil {
		if total == nil {
			total = used
		}
		if used == nil {
			used = usageProbeFloat(0)
		}
		values.windows = append(values.windows, usageProbeWindow{key: "included", total: total, used: used})
	}
	if total, used := cents("onDemandCap"), cents("onDemandUsed"); total != nil || used != nil {
		if total == nil {
			total = used
		}
		if used == nil {
			used = usageProbeFloat(0)
		}
		values.windows = append(values.windows, usageProbeWindow{key: "onDemand", total: total, used: used})
	}
	return values, len(values.windows) > 0
}

func usageProbeParseCodex(body any) (usageProbeValues, bool) {
	values := usageProbeValues{}
	for _, position := range []string{"primary", "secondary"} {
		if used := usageProbeN(body, "rate_limit."+position+"_window.used_percent"); used != nil {
			values.windows = append(values.windows, usageProbeWindow{key: position, used: usageProbeFloat(usageProbeClamp(*used)), total: usageProbeFloat(100)})
		}
	}
	balance := usageProbeN(body, "credits.balance")
	unlimited := usageProbeGet(body, "credits.has_credits") == true && usageProbeGet(body, "credits.unlimited") == true
	if !unlimited {
		values.remaining = balance
	}
	// An unlimited balance without a numeric window has nothing to display.
	return values, len(values.windows) > 0 || values.remaining != nil
}

func usageProbeFirst(body any, paths ...string) any {
	for _, path := range paths {
		if value := usageProbeGet(body, path); value != nil {
			return value
		}
	}
	return nil
}

func usageProbeParseCommandCode(body any) (usageProbeValues, bool) {
	values := usageProbeValues{}
	monthly := usageProbeNumber(usageProbeFirst(body, "credits.monthlyCredits", "credits.monthly_credits", "monthlyCredits", "monthly_credits"))
	if monthly == nil {
		return values, false
	}
	box := usageProbeFirst(body, "credits.windowLimits", "credits.window_limits", "windowLimits", "window_limits")
	var fiveCap, weeklyCap *float64
	for _, key := range []string{"fiveHour", "weekly"} {
		paths := []string{key}
		if key == "fiveHour" {
			paths = append(paths, "five_hour")
		}
		window := usageProbeFirst(box, paths...)
		cap := usageProbeNumber(usageProbeFirst(window, "cap", "limit"))
		if cap == nil || *cap <= 0 {
			continue
		}
		if key == "fiveHour" {
			fiveCap = cap
		} else {
			weeklyCap = cap
		}
		if used := usageProbeN(window, "used"); used != nil {
			values.windows = append(values.windows, usageProbeWindow{key: key, total: cap, used: usageProbeFloat(math.Max(0, *used))})
		}
	}
	month := usageProbeWindow{key: "monthly", remaining: monthly}
	// The monthly cap is absent on the wire. Infer it only from an exact pair
	// of official rolling caps, and only if the reported balance fits it.
	for _, plan := range [][3]float64{{10, 3, 6}, {70, 14, 35}, {80, 16, 40}, {150, 45, 90}, {300, 90, 180}} {
		if fiveCap != nil && weeklyCap != nil && *fiveCap == plan[1] && *weeklyCap == plan[2] && *monthly <= plan[0] {
			month.total = usageProbeFloat(plan[0])
			month.used = usageProbeFloat(math.Max(0, math.Min(plan[0], plan[0]-*monthly)))
			break
		}
	}
	values.remaining = monthly
	values.windows = append(values.windows, month)
	return values, true
}

func usageProbeParseSub2API(body any) (usageProbeValues, bool) {
	values := usageProbeValues{currency: usageProbeCurrency(usageProbeGet(body, "unit"))}
	if balance := usageProbeN(body, "balance"); balance != nil && usageProbeObject(usageProbeGet(body, "subscription")) == nil {
		values.balance = balance
		return values, true
	}
	values.total = usageProbeN(body, "quota.limit")
	if values.total != nil && *values.total <= 0 {
		values.total = nil
	}
	if values.total != nil {
		values.used = usageProbeN(body, "quota.used")
	} else {
		values.used = usageProbeN(body, "usage.total.actual_cost")
	}
	values.remaining = usageProbeN(body, "remaining")
	if values.remaining == nil || *values.remaining < 0 {
		values.remaining = usageProbeN(body, "quota.remaining")
	}
	if values.remaining != nil && *values.remaining < 0 {
		values.remaining = nil
	}
	list, _ := usageProbeGet(body, "rate_limits").([]any)
	for _, entry := range list {
		key := map[string]string{"5h": "fiveHour", "1d": "daily", "7d": "weekly"}[usageProbeString(usageProbeGet(entry, "window"))]
		total, used := usageProbeN(entry, "limit"), usageProbeN(entry, "used")
		if key != "" && (total != nil || used != nil) {
			values.windows = append(values.windows, usageProbeWindow{key: key, total: total, used: used})
		}
	}
	for _, tier := range []string{"daily", "weekly", "monthly"} {
		total := usageProbeN(body, "subscription."+tier+"_limit_usd")
		used := usageProbeN(body, "subscription."+tier+"_usage_usd")
		if tier == "monthly" && (total == nil || *total <= 0) {
			total, used = usageProbeN(body, "subscription.total_quota"), usageProbeN(body, "subscription.used_quota")
		}
		if total != nil && *total > 0 {
			if used == nil {
				used = usageProbeFloat(0)
			}
			values.windows = append(values.windows, usageProbeWindow{key: tier, total: total, used: usageProbeFloat(math.Max(0, *used))})
		}
	}
	return values, values.total != nil || values.used != nil || values.remaining != nil || len(values.windows) > 0
}
