# -*- coding: utf-8 -*-
import json, sys
from fontTools.ttLib import TTFont

text = "三个项目五个会话侧栏树标签栏同时在跑工具调用用量统计看得见的开销改动都在这终端也在里面不用切窗口斜杠命令三种后端一次五路后台一个窗口管住所有回放推近拉远横移快推砸入停滚亮起展开折叠滚动条输入框发送箭头角标数字标记文件树管理面板列表下拉菜单版本浅色深色主题工作台历史时间线计划模式生图信任确认扩展技能提示词商店缓存命中每日模型维度热力图安装包更新下载源码比较"
chars = sorted(set(text))
res = {}
for fam, path in [
    ("NotoSansSC-500", r"C:\Users\14012\.agents\skills\huashu-art-motion\scripts\engine\lib\fonts\NotoSansSC-500.woff"),
    ("NotoSansSC-800", r"C:\Users\14012\.agents\skills\huashu-art-motion\scripts\engine\lib\fonts\NotoSansSC-800.woff"),
    ("LXGWWenKai-500", r"C:\Users\14012\.agents\skills\huashu-art-motion\scripts\engine\lib\fonts\LXGWWenKai-500.woff"),
]:
    f = TTFont(path)
    cmap = set()
    for t in f["cmap"].tables:
        cmap |= set(t.cmap.keys())
    miss = [ch for ch in chars if ord(ch) not in cmap]
    res[fam] = miss
    print(fam, "missing:", "".join(miss), "count:", len(miss))
