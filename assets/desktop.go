//go:build !js && !android && !ios

package assets

import (
	_ "embed"
)

// StarterPrompts seeds the desktop's prompt library.
//
//go:embed prompts/starter.json
var StarterPrompts []byte

// SkillMCPSetup is pi's MCP configuration guide, installed into pi's own
// skills folder so the terminal pi can use it too.
//
//go:embed skills/mcp-setup/SKILL.md
var SkillMCPSetup []byte

// SkillPiDeck is this app's capability router. It lives outside pi's
// discovery root and is passed with --skill, so the terminal pi does not
// carry a desktop-only skill in its prompt.
//
//go:embed skills/pideck/SKILL.md
var SkillPiDeck []byte

// OfficialPrompts is PiDeck's prompt-template pack, offered in the prompt
// store instead of being written into the user's library unasked.
//
//go:embed prompts/official.json
var OfficialPrompts []byte
