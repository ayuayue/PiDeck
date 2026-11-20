//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestShareExportExcludesSystemNotes(t *testing.T) {
	note := turnStep{Note: "Private system note", Text: "Private summary body"}
	tests := []struct {
		name   string
		turn   turn
		prompt string
		answer string
	}{
		{"note_only", turn{Steps: []turnStep{note}}, "", ""},
		{"prompt_and_note", turn{Prompt: "Keep the question", Steps: []turnStep{note}}, "Keep the question", ""},
		{"assistant_before_note", turn{Steps: []turnStep{{Text: "Keep the answer"}, note}}, "", "Keep the answer"},
		{"assistant_after_note", turn{Steps: []turnStep{note, {Text: "Keep the answer"}}}, "", "Keep the answer"},
		{"final_before_note", turn{Steps: []turnStep{note}, Final: "Keep the final answer"}, "", "Keep the final answer"},
		{"blank_final", turn{Steps: []turnStep{{Text: "Keep the answer"}, note}, Final: " \n"}, "", "Keep the answer"},
		{"multiple_notes", turn{Steps: []turnStep{note, {Thinking: "Private reasoning"}, note}}, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := exportData{Turns: []turn{tt.turn}}
			before := cloneTranscriptTurns(d.Turns)
			shared := shareExport(d, nil)
			if tt.prompt == "" && tt.answer == "" {
				if len(shared.Turns) != 0 {
					t.Fatalf("system-only share contains %d turns, want none", len(shared.Turns))
				}
			} else if len(shared.Turns) != 1 || shared.Turns[0].Prompt != tt.prompt || shared.Turns[0].Final != tt.answer {
				t.Fatalf("share turns = %+v, want prompt %q and answer %q", shared.Turns, tt.prompt, tt.answer)
			}
			for _, out := range []string{renderSessionHTML(shared), renderSessionMarkdown(shared)} {
				for _, private := range []string{note.Note, note.Text, "Private reasoning"} {
					if strings.Contains(out, private) {
						t.Errorf("share contains system content %q", private)
					}
				}
			}
			if !reflect.DeepEqual(d.Turns, before) {
				t.Fatal("sharing changed the source transcript")
			}
		})
	}
}

func TestShareExportExcludesHistorySummaries(t *testing.T) {
	// These are pi's message roles, before the read-only transcript projection.
	var msgs []piMessage
	if err := json.Unmarshal([]byte(`[
		{"role":"compactionSummary","summary":"Private compacted context"},
		{"role":"user","content":"Keep this prompt"},
		{"role":"assistant","content":[{"type":"text","text":"Keep this explanation"},{"type":"toolCall","id":"call","name":"read","arguments":{"path":"note.txt"}}]},
		{"role":"branchSummary","summary":"Private branch context"},
		{"role":"custom","customType":"Private extension note","content":"Private extension body"}
	]`), &msgs); err != nil {
		t.Fatal(err)
	}
	d := exportData{Turns: turnsFromMessages(msgs)}
	shared := shareExport(d, nil)
	if len(shared.Turns) != 1 || shared.Turns[0].Prompt != "Keep this prompt" || shared.Turns[0].Final != "Keep this explanation" {
		t.Fatalf("share history = %+v, want only the conversation", shared.Turns)
	}
	for _, render := range []func(exportData) string{renderSessionHTML, renderSessionMarkdown} {
		original, out := render(d), render(shared)
		for _, private := range []string{"Private compacted context", "Private branch context", "Private extension body"} {
			if strings.Contains(out, private) {
				t.Errorf("share contains history context %q", private)
			}
			if !strings.Contains(original, private) {
				t.Errorf("original export lost history context %q", private)
			}
		}
	}
}

func TestRenderSessionMarkdownPreservesSteps(t *testing.T) {
	thinking := "Original thinking\n```nested code```"
	output := "Original tool output\n````nested output````"
	d := exportData{Turns: []turn{{
		Prompt: "Original question",
		Steps: []turnStep{
			{Thinking: thinking, Text: "First assistant explanation", Tools: []toolRun{{
				Action: "read", Detail: "first.txt", Output: output,
			}}},
			{Note: "Original system note", Text: "Original note body"},
			{Text: "Second assistant explanation", Tools: []toolRun{{
				Action: "read", Detail: "second.txt", Output: "Second tool output",
			}}},
		},
		Final: "Original final answer",
		Err:   "Original failure details",
	}}}
	out := renderSessionMarkdown(d)
	previous := -1
	for _, want := range []string{
		"Original question", thinking, "First assistant explanation", "first.txt", output,
		"Original system note", "Original note body", "Second assistant explanation", "second.txt",
		"Second tool output", "Original final answer", "Original failure details",
	} {
		at := strings.Index(out, want)
		if at < 0 {
			t.Errorf("original Markdown lacks %q", want)
		} else if at <= previous {
			t.Errorf("original Markdown reordered %q: at %d, previous %d", want, at, previous)
		}
		previous = max(previous, at)
	}
	for _, text := range []string{thinking, output, "Original note body", "Second tool output"} {
		if !strings.Contains(out, mdFence(text)) {
			t.Errorf("original Markdown did not fence %q", text)
		}
	}
}

func TestRenderSessionHTMLSystemNotes(t *testing.T) {
	d := exportData{Turns: []turn{{Steps: []turnStep{{
		Note: `<script>note title</script>`, Text: `<img src="private.example">note body`,
	}}}}}
	out := renderSessionHTML(d)
	for _, unsafe := range []string{"<script>", `<img src=`} {
		if strings.Contains(out, unsafe) {
			t.Errorf("original HTML did not escape %q", unsafe)
		}
	}
	for _, escaped := range []string{"&lt;script&gt;note title&lt;/script&gt;", "&lt;img src=&#34;private.example&#34;&gt;note body"} {
		if strings.Count(out, escaped) != 1 {
			t.Errorf("original HTML lacks one escaped copy of %q", escaped)
		}
	}
}

func TestRenderSessionExportsDoNotDuplicateFinal(t *testing.T) {
	const answer = "Distinct final answer"
	tests := []struct {
		name  string
		steps []turnStep
		count int
	}{
		{"separate_final", []turnStep{{Text: "Intermediate explanation"}}, 1},
		{"mirrored_final", []turnStep{{Text: answer}}, 1},
		{"mirrored_with_tools", []turnStep{{Text: answer, Tools: []toolRun{{Action: "read", Output: "tool output"}}}}, 1},
		{"earlier_repeated_text", []turnStep{{Text: answer}, {Text: "Later explanation"}}, 2},
		{"note_is_distinct", []turnStep{{Note: "System note", Text: answer}}, 2},
	}
	for _, tt := range tests {
		for _, format := range []struct {
			name   string
			render func(exportData) string
		}{{"html", renderSessionHTML}, {"markdown", renderSessionMarkdown}} {
			t.Run(tt.name+"/"+format.name, func(t *testing.T) {
				out := format.render(exportData{Turns: []turn{{Steps: tt.steps, Final: answer}}})
				if got := strings.Count(out, answer); got != tt.count {
					t.Fatalf("final answer appears %d times, want %d:\n%s", got, tt.count, out)
				}
			})
		}
	}
}
