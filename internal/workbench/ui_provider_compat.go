//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func compatibilityLabels(flag string) (string, string) {
	switch flag {
	case "supportsStrictMode":
		return apptext.T("严格工具参数校验"), apptext.T("接口是否接受工具定义中的 strict 字段。")
	case "supportsTemperature":
		return apptext.T("温度参数"), apptext.T("接口是否接受 temperature；部分推理模型不接受。")
	case "forceAdaptiveThinking":
		return apptext.T("强制自适应思考"), apptext.T("供应商要求时启用，通常保持自动。")
	case "supportsStore":
		return apptext.T("响应存储参数"), apptext.T("接口是否接受 store 字段。")
	case "supportsDeveloperRole":
		return apptext.T("Developer 消息角色"), apptext.T("接口是否支持 developer 角色，而不是仅支持 system。")
	case "supportsReasoningEffort":
		return apptext.T("推理强度参数"), apptext.T("接口是否接受 reasoning_effort 字段。")
	case "supportsUsageInStreaming":
		return apptext.T("流式用量统计"), apptext.T("流式响应是否支持返回 token 用量。")
	case "requiresToolResultName":
		return apptext.T("工具结果携带名称"), apptext.T("供应商是否要求在工具结果消息中传递工具名称。")
	case "requiresThinkingAsText":
		return apptext.T("思考内容转为文本"), apptext.T("把思考内容按普通文本格式发送给兼容接口。")
	case "requiresReasoningContentOnAssistantMessages":
		return apptext.T("助手消息携带推理内容"), apptext.T("供应商是否要求助手历史消息包含 reasoning_content。")
	}
	return flag, ""
}

func compatibilityFields(prefix string, revision *core.Signal[int], values func() map[string]bool, change func(string, string)) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = revision.Get()
		colors := ui.ColorsOf(cx)
		var rows []core.Node
		for _, entry := range compatFlags {
			flag := entry
			label, help := compatibilityLabels(flag)
			rows = append(rows, core.View{Style: core.Style{Gap: 5}, Children: []core.Node{
				ui.Text(label, 11.5, ui.Medium, colors.Text),
				core.Text{Content: help, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
				ui.Select[string]{Label: label, TestID: prefix + flag, Options: []ui.Option[string]{{Value: "", Label: apptext.T("自动（继承）")}, {Value: "on", Label: apptext.T("启用")}, {Value: "off", Label: apptext.T("关闭")}}, Value: func() string {
					if v, ok := values()[flag]; ok {
						if v {
							return "on"
						}
						return "off"
					}
					return ""
				}, OnChange: func(value string) { change(flag, value); revision.Update(func(n int) int { return n + 1 }) }, Style: core.Style{Width: core.Pct(100)}},
			}})
		}
		return core.View{Style: core.Style{Gap: 14}, Children: rows}
	})
}
