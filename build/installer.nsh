# 安装器/卸载器自定义宏（electron-builder 自动加载 build/installer.nsh）。
#
# 完成页的「运行 PiDeck」必须直接启动本次安装目录里的 exe。
# electron-builder 默认实现把启动目标设成 $launchLink，而 $launchLink 优先取开始菜单 PiDeck.lnk
# （installSection.nsh：`${if} ${FileExists} "$newStartMenuLink"` → `StrCpy $launchLink "$newStartMenuLink"`）。
# .lnk 是用户/历史安装留下的东西，完全可能指向另一份 PiDeck（仓库里的解包构建、旧安装目录），
# 那种构建和发行版同名同版本号（package.json version 一样），装完点「运行」会跑起另一个程序，
# 现象是版本号看着是新的、功能/运行时声明却是旧的，极难定位（2026-10 实际踩坑）。
# 覆盖成 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 后，装完启动的一定是刚装好的这份。
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
