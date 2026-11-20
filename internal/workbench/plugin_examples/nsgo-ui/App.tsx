import { host, mount, signal, Storage, Text, View } from "nsgo";

// This is a signed NSGo package example, not a Lite v2 manifest. The test
// host grants only context.read; no network, files, shell or session text.
const project = signal("正在读取项目…");
const status = signal("正在读取状态…");
const marks = signal(0);
const ready = signal(false);

host.call("context.read").then(
  (value) => project.set(String((value as { projectName: string }).projectName)),
  () => project.set("宿主未授予项目信息权限"),
);

Storage.getItem("marks").then(
  (value) => {
    const count = Number(value ?? 0);
    marks.set(Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0);
    ready.set(true);
    status.set("准备完成");
  },
  () => status.set("无法读取插件存储"),
);

function mark() {
  if (!ready()) return;
  const count = marks() + 1;
  marks.set(count);
  status.set("正在保存…");
  Storage.setItem("marks", String(count)).then(
    () => status.set("已保存"),
    () => status.set("保存失败"),
  );
}

function ProjectCard() {
  return (
    <View class="gap-3 p-4 rounded-xl bg-white dark:bg-neutral-900">
      <Text testID="example-project" class="text-lg font-semibold text-neutral-900 dark:text-white">
        {project}
      </Text>
      <Text testID="example-marks" class="text-sm text-neutral-600 dark:text-neutral-300">
        {() => `标记次数：${marks()}`}
      </Text>
      <View testID="example-mark" role="button" onPress={mark}
        class="self-start rounded-lg px-3 py-2 bg-neutral-900 dark:bg-white">
        <Text class="text-sm text-white dark:text-neutral-900">添加标记</Text>
      </View>
      <Text testID="example-status" class="text-sm text-neutral-500">{status}</Text>
    </View>
  );
}

mount(ProjectCard);
