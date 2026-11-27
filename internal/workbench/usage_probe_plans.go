//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"math"
	"strings"
	"time"
)

func usageProbeParseKimi(body any) (usageProbeValues, bool) {
	values := usageProbeValues{}
	read := func(scope any, key string) usageProbeWindow {
		w := usageProbeWindow{key: key, total: usageProbeN(scope, "limit"), used: usageProbeN(scope, "used"), remaining: usageProbeN(scope, "remaining")}
		if w.remaining == nil && w.total != nil && w.used != nil {
			w.remaining = usageProbeNumber(math.Max(0, *w.total-*w.used))
		}
		return w
	}
	limits, _ := usageProbeGet(body, "limits").([]any)
	for _, entry := range limits {
		detail := usageProbeGet(entry, "detail")
		if usageProbeObject(detail) == nil {
			continue
		}
		key := usageProbeString(usageProbeGet(detail, "name"))
		duration := usageProbeN(entry, "window.duration")
		unit := strings.TrimPrefix(strings.ToUpper(usageProbeString(usageProbeGet(entry, "window.timeUnit"))), "TIME_UNIT_")
		if duration != nil && *duration > 0 && unit != "" {
			if *duration == 300 && unit == "MINUTE" {
				key = "fiveHour"
			} else {
				suffix := strings.ToLower(unit)
				for prefix, short := range map[string]string{"HOUR": "h", "DAY": "d", "MIN": "m"} {
					if strings.HasPrefix(unit, prefix) {
						suffix = short
					}
				}
				key = fmt.Sprintf("%g%s", *duration, suffix)
			}
		}
		if key == "" {
			key = "window"
		}
		w := read(detail, key)
		if w.total != nil || w.used != nil || w.remaining != nil {
			values.windows = append(values.windows, w)
		}
	}
	weekly := read(usageProbeGet(body, "usage"), "weekly")
	if weekly.total != nil || weekly.used != nil || weekly.remaining != nil {
		values.windows = append(values.windows, weekly)
	}
	if quota := usageProbeObject(usageProbeGet(body, "totalQuota")); quota != nil {
		month := read(quota, "monthly")
		if month.total == nil {
			month.total = usageProbeFloat(100)
		}
		if month.used != nil && *month.used > 0 {
			month.used, month.remaining = month.total, usageProbeFloat(0)
		} else {
			if month.used == nil {
				used := 0.0
				if month.remaining != nil {
					used = math.Max(0, *month.total-*month.remaining)
				}
				month.used = usageProbeNumber(used)
			}
			if month.remaining == nil && month.used != nil {
				month.remaining = usageProbeNumber(math.Max(0, *month.total-*month.used))
			}
		}
		values.windows = append(values.windows, month)
	}
	values.booster = usageProbeParseBooster(body, &usageProbeBoosterSpec{
		balancePath: "boosterWallet.balance.amountLeft", totalPath: "boosterWallet.balance.amount", currencyPath: "boosterWallet.monthlyUsed.currency",
		monthlyUsedPath: "boosterWallet.monthlyUsed.priceInCents", monthlyLimitPath: "boosterWallet.monthlyChargeLimit.priceInCents", monthlyEnabledPath: "boosterWallet.monthlyChargeLimitEnabled",
		fixedPointPerCent: 1_000_000,
	})
	values.total, values.used, values.remaining = weekly.total, weekly.used, weekly.remaining
	if len(values.windows) > 0 {
		first := values.windows[0]
		if values.total == nil {
			values.total = first.total
		}
		if values.used == nil {
			values.used = first.used
		}
		if values.remaining == nil {
			values.remaining = first.remaining
		}
	}
	return values, len(values.windows) > 0
}

func usageProbeEpoch(raw any, millis bool) time.Time {
	n := usageProbeNumber(raw)
	if n == nil || *n <= 0 {
		return time.Time{}
	}
	seconds := *n
	if millis || seconds > 1e12 {
		seconds /= 1000
	}
	// Keep conversion within RFC3339's supported calendar, before int64 casts.
	if seconds > 253402300799 {
		return time.Time{}
	}
	return time.Unix(int64(seconds), int64((seconds-math.Floor(seconds))*1e9)).UTC()
}

func usageProbeParseVolcengine(body any) (usageProbeValues, bool) {
	values := usageProbeValues{}
	result := usageProbeGet(body, "Result")
	if result == nil {
		result = body
	}
	for _, field := range []string{"QuotaUsage", "Usages", "Details"} {
		list, ok := usageProbeGet(result, field).([]any)
		if !ok {
			continue
		}
		for _, entry := range list {
			key := ""
			for _, field := range []string{"Level", "Type", "Period", "Label", "Window"} {
				switch strings.ToLower(usageProbeString(usageProbeGet(entry, field))) {
				case "session", "5h", "fivehour", "five_hour", "rolling_5h":
					key = "rolling"
				case "weekly", "week", "7d":
					key = "weekly"
				case "monthly", "month":
					key = "monthly"
				}
				if key != "" {
					break
				}
			}
			percent := usageProbeNumber(usageProbeFirst(entry, "Percent", "UsedPercent", "UsagePercent"))
			if key == "" || percent == nil {
				continue
			}
			values.windows = append(values.windows, usageProbeWindow{key: key, percent: usageProbeFloat(usageProbeClamp(*percent)), resetsAt: usageProbeEpoch(usageProbeFirst(entry, "ResetTimestamp", "ResetTime"), false)})
		}
		return values, len(values.windows) > 0
	}
	for _, tier := range []struct{ key, field string }{{"rolling", "AFPFiveHour"}, {"weekly", "AFPWeekly"}, {"monthly", "AFPMonthly"}} {
		entry := usageProbeGet(result, tier.field)
		quota, used := usageProbeN(entry, "Quota"), usageProbeN(entry, "Used")
		if quota == nil || *quota <= 0 || used == nil {
			continue
		}
		percent := usageProbeNumber(*used / *quota * 100)
		if percent != nil {
			values.windows = append(values.windows, usageProbeWindow{key: tier.key, percent: usageProbeFloat(usageProbeClamp(*percent)), resetsAt: usageProbeEpoch(usageProbeFirst(entry, "ResetTime", "ResetTimestamp"), false)})
		}
	}
	return values, len(values.windows) > 0
}

func usageProbeParseMinimax(body any) (usageProbeValues, bool) {
	values := usageProbeValues{}
	if code := usageProbeN(body, "base_resp.status_code"); code != nil && *code != 0 {
		return values, false
	}
	list, _ := usageProbeGet(body, "model_remains").([]any)
	var chosen any
	for _, entry := range list {
		if usageProbeObject(entry) == nil {
			continue
		}
		model := usageProbeString(usageProbeGet(entry, "model_name"))
		if model == "general" {
			chosen = entry
			break
		}
		if chosen == nil && model != "video" {
			chosen = entry
		}
	}
	for _, tier := range []struct{ key, prefix, reset string }{{"rolling", "current_interval", "end_time"}, {"weekly", "current_weekly", "weekly_end_time"}} {
		var percent *float64
		if remaining := usageProbeN(chosen, tier.prefix+"_remaining_percent"); remaining != nil {
			percent = usageProbeFloat(usageProbeClamp(100 - *remaining))
		} else {
			total, remaining := usageProbeN(chosen, tier.prefix+"_total_count"), usageProbeN(chosen, tier.prefix+"_usage_count")
			if total != nil && *total > 0 && remaining != nil {
				used := *total - math.Min(math.Max(*remaining, 0), *total)
				percent = usageProbeNumber(used / *total * 100)
			}
		}
		if percent != nil {
			values.windows = append(values.windows, usageProbeWindow{key: tier.key, percent: usageProbeFloat(math.Round(usageProbeClamp(*percent)*10) / 10), resetsAt: usageProbeEpoch(usageProbeGet(chosen, tier.reset), true)})
		}
	}
	return values, len(values.windows) > 0
}
