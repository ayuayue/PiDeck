#!/usr/bin/env python3
"""PiDeck AI 日更管线的纯逻辑单测。

只测不碰 IO 的函数：字幕折行与 ASS 生成、SRT 解析、时间轴排布、裁剪框换算、
发布文案裁剪。这些都是踩过坑的地方，必须有回归守住：

- libass 不会给无空格的中文断行 → 预折 + `\\N`
- `subtitles=xxx.srt:force_style=` 会把 SRT 当 384×288 脚本分辨率放大 → 自己写 ASS
- ASS 的 Dialogue 字段数必须与 Format 声明一致，多一个空字段行首会多出杂字符
- mp3 容器时长带编码器填充 → 用解码后的 PCM 样本数当权威时长

跑法：
  python video-series/daily/tests/test_daily_pipeline.py
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.daily_deck import crop_box, render_episode  # noqa: E402
from pipeline.publish_copy import clip  # noqa: E402
from pipeline.subtitles import (  # noqa: E402
    Cue,
    build_ass,
    parse_srt,
    read_srt,
    shift_cues,
    to_ass_time,
    trim_cue_text,
    wrap_cjk,
)
from pipeline.timeline import (  # noqa: E402
    ENTER_LEAD,
    TRANSITION,
    build_timeline,
    estimate_durations,
    layer_windows,
    total_duration,
)
from templates.deck_css import FORMATS  # noqa: E402


class WrapCjkTest(unittest.TestCase):
    """中文没有空格，libass 不会自己断行——必须预折。"""

    def test_short_text_keeps_single_line(self):
        self.assertEqual(wrap_cjk("还在手打文件路径？", 20), "还在手打文件路径？")

    def test_long_text_wraps_within_budget(self):
        text = "在输入框敲一个 @，PiDeck 立刻弹出你项目里的文件列表，上下键一选，回车确认，文件就插进消息了。"
        lines = wrap_cjk(text, 20).split("\n")
        self.assertGreater(len(lines), 1)
        for line in lines:
            # 一行 = 一个 CJK 字符或半个 ASCII 字符
            width = sum(1.0 if ord(c) > 0x2E80 else 0.5 for c in line)
            self.assertLessEqual(width, 20 + 0.5)

    def test_breaks_only_at_punctuation_or_space(self):
        # 中文没空格，必须落在标点/空格这类自然边界上，不能把一个词从中间劈开
        text = "选中之后，路径会原样写进消息里，Agent 拿着这个路径就能自己去看源码。"
        lines = wrap_cjk(text, 20).split("\n")
        for line in lines[:-1]:
            self.assertTrue(
                line.endswith(("，", "。", "、", " ", ",", ".")),
                f"断行位置不是自然边界: {line!r}",
            )

    def test_never_starts_line_with_closing_punctuation(self):
        lines = wrap_cjk("一二三四五六七八九十，甲乙丙丁戊己庚辛壬癸，子丑寅卯辰巳午未申酉。", 8).split("\n")
        for line in lines:
            self.assertNotIn(line[0], "，。！？；：、,.!?;:")

    def test_keeps_explicit_newline(self):
        self.assertEqual(wrap_cjk("上\n下", 20), "上\n下")


class TrimCueTextTest(unittest.TestCase):
    """edge-tts 断句会把标点甩到下一条开头，字幕上会看到孤零零的「，」。"""

    def test_strips_leading_punctuation(self):
        self.assertEqual(trim_cue_text("，下期讲会话内查找"), "下期讲会话内查找")

    def test_strips_trailing_punctuation(self):
        self.assertEqual(trim_cue_text("开源免费。"), "开源免费")

    def test_keeps_inner_punctuation(self):
        self.assertEqual(trim_cue_text("开源免费，GitHub 搜就能装"), "开源免费，GitHub 搜就能装")

    def test_blank_becomes_empty(self):
        self.assertEqual(trim_cue_text("，。"), "")


class SrtParseTest(unittest.TestCase):
    def test_parses_cue_times(self):
        cues = parse_srt("1\n00:00:01,250 --> 00:00:03,500\n你好\n")
        self.assertEqual(len(cues), 1)
        self.assertAlmostEqual(cues[0].start, 1.25)
        self.assertAlmostEqual(cues[0].end, 3.5)
        self.assertEqual(cues[0].text, "你好")

    def test_skips_malformed_blocks(self):
        cues = parse_srt("垃圾块\n\n1\n00:00:01,000 --> 00:00:02,000\n正文\n")
        self.assertEqual(len(cues), 1)

    def test_shift_moves_whole_block(self):
        cues = [Cue(1.0, 2.0, "a")]
        shifted = shift_cues(cues, 10.0)
        self.assertAlmostEqual(shifted[0].start, 11.0)
        self.assertAlmostEqual(shifted[0].end, 12.0)

    def test_read_srt_from_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "x.srt"
            path.write_text("1\n00:00:00,100 --> 00:00:01,000\n测试\n", encoding="utf-8")
            cues = read_srt(path)
        self.assertEqual(cues[0].text, "测试")

    def test_to_ass_time_keeps_centiseconds(self):
        self.assertEqual(to_ass_time(1.25), "0:00:01.25")
        self.assertEqual(to_ass_time(67.824), "0:01:07.82")


class BuildAssTest(unittest.TestCase):
    def _build(self, cues, fmt="16x9"):
        with tempfile.TemporaryDirectory() as d:
            out = build_ass(cues, Path(d) / "x.ass", FORMATS[fmt]["width"], FORMATS[fmt]["height"], FORMATS[fmt]["subtitle"])
            return out.read_text(encoding="utf-8")

    def test_playres_matches_frame_size(self):
        text = self._build([Cue(1.25, 3.5, "你好")])
        self.assertIn("PlayResX: 1920", text)
        self.assertIn("PlayResY: 1080", text)
        style_line = next(ln for ln in text.splitlines() if ln.startswith("Style:"))
        self.assertIn(f",{FORMATS['16x9']['subtitle']['size']},", style_line)

    def test_dialogue_field_count_matches_format(self):
        # 字段多一个空位，libass 会把正文顶偏并在行首多出一个杂字符
        text = self._build([Cue(1.25, 3.5, "你好")])
        line = next(ln for ln in text.splitlines() if ln.startswith("Dialogue:"))
        # 正文里的逗号（如 {\fad(130,130)}）不算字段分隔，只按前 9 个逗号切
        fields = line[len("Dialogue:") :].split(",", 9)
        self.assertEqual(len(fields), 10, f"Dialogue 字段数应为 10: {line}")
        self.assertTrue(fields[-1].endswith("你好"), fields[-1])

    def test_event_times_are_converted(self):
        text = self._build([Cue(1.25, 3.5, "你好")])
        self.assertIn("Dialogue: 0,0:00:01.25,0:00:03.50,", text)

    def test_long_cue_is_prewrapped(self):
        text = self._build(
            [Cue(1.0, 5.0, "在输入框敲一个 @，PiDeck 立刻弹出你项目里的文件列表，上下键一选，回车确认，文件就插进消息了。")],
            fmt="3x4",
        )
        self.assertIn("\\N", text)

    def test_fade_tag_is_applied(self):
        text = self._build([Cue(1.0, 2.0, "你好")])
        self.assertIn("{\\fad(", text)

    def test_leading_punctuation_is_trimmed(self):
        text = self._build([Cue(1.0, 2.0, "，下期讲会话内查找")])
        self.assertNotIn("，下期", text)


class TimelineTest(unittest.TestCase):
    def test_durations_are_packed_without_gap(self):
        timings = build_timeline([2.0, 3.0, 4.0])
        self.assertAlmostEqual(timings[0].start, 0.0)
        self.assertAlmostEqual(timings[1].start, 2.0)
        self.assertAlmostEqual(timings[2].start, 5.0)
        self.assertAlmostEqual(total_duration(timings), 9.0)

    def test_layers_start_before_the_narration(self):
        timings = build_timeline([4.0, 4.0])
        windows = layer_windows(timings)
        self.assertAlmostEqual(windows[0].enter_at, 0.0)
        self.assertAlmostEqual(windows[1].enter_at, 4.0 - ENTER_LEAD)

    def test_previous_layer_exits_before_next_enters(self):
        timings = build_timeline([4.0, 4.0])
        windows = layer_windows(timings)
        self.assertLessEqual(windows[0].exit_at, windows[1].enter_at + 1e-6)
        self.assertGreaterEqual(windows[0].exit_at, windows[1].enter_at - TRANSITION)

    def test_last_layer_lives_to_the_end(self):
        timings = build_timeline([4.0, 4.0])
        windows = layer_windows(timings)
        self.assertAlmostEqual(windows[-1].exit_at, 8.0 - TRANSITION)

    def test_estimate_durations_scale_with_chars(self):
        slides = [{"narration": "一" * 44}, {"narration": "一" * 88}]
        durations = estimate_durations(slides)
        self.assertAlmostEqual(durations[0], 10.0, places=3)
        self.assertAlmostEqual(durations[1], 20.0, places=3)


class CropBoxTest(unittest.TestCase):
    def test_ratio_to_pixels(self):
        self.assertEqual(crop_box({"x": 0.5, "y": 0.25, "w": 0.25, "h": 0.5}, (1000, 800)), (500, 200, 250, 400))

    def test_missing_keys_default_to_full_frame(self):
        self.assertEqual(crop_box({}, (1000, 800)), (0, 0, 1000, 800))

    def test_out_of_range_is_clamped(self):
        self.assertEqual(crop_box({"x": -1, "y": 0, "w": 5, "h": 1}, (100, 100)), (0, 0, 100, 100))


class RenderEpisodeTest(unittest.TestCase):
    """整集单页 HTML 的结构约定：图层带时间轴变量，且有首尾淡入淡出层。"""

    def _html(self, fmt="16x9"):
        episode = {
            "title": "t",
            "brand": "PiDeck",
            "slogan": "s",
            "epTag": "Day 001",
            "footRight": "github.com/ayuayue/PiDeck",
            "slides": [
                {"id": "01-hook", "type": "hook", "title": "标题", "kicker": "小标", "lead": "一句话", "narration": "n"},
                {"id": "02-cta", "type": "cta", "title": "标题", "lead": "一句话", "bullets": ["一", "二"], "narration": "n"},
            ],
        }
        timings = build_timeline([4.0, 4.0])
        return render_episode(episode, fmt, layer_windows(timings), total_duration(timings), {})

    def test_layers_carry_timeline_variables(self):
        html = self._html()
        self.assertIn("--in:", html)
        self.assertIn("--out:", html)
        self.assertIn("deck-fade", html)

    def test_each_slide_gets_one_layer(self):
        html = self._html()
        self.assertEqual(html.count('class="layer"'), 2)

    def test_shot_slide_reserves_subtitle_safe_area(self):
        """带整屏截图的页要挂 has-img，底部字幕才不会被烧录字幕压住。"""
        episode = {
            "title": "t",
            "brand": "PiDeck",
            "slogan": "s",
            "epTag": "Day 001",
            "footRight": "github.com/ayuayue/PiDeck",
            "slides": [
                {"id": "01-hook", "type": "hook", "title": "标题", "kicker": "小标", "lead": "一句话", "narration": "n"},
                {"id": "02-shot", "type": "shot", "title": "标题", "image": "docs/images/files.png", "caption": "说明", "narration": "n"},
            ],
        }
        timings = build_timeline([4.0, 4.0])
        html = render_episode(episode, "16x9", layer_windows(timings), total_duration(timings), {})
        self.assertIn('class="layer has-img"', html)
        self.assertEqual(html.count('class="layer"'), 1)


class PublishClipTest(unittest.TestCase):
    def test_short_text_untouched(self):
        self.assertEqual(clip("短标题", 30), "短标题")

    def test_long_text_truncated_with_ellipsis(self):
        out = clip("一" * 50, 30)
        self.assertEqual(len(out), 30)
        self.assertTrue(out.endswith("…"))


if __name__ == "__main__":
    unittest.main()
