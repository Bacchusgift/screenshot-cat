// Optional panel. Nothing in this module is needed by tray capture or clipboard monitoring.
import {
  bind,
  call,
  escape,
  handleError,
  icon,
  mediaUrl,
  native,
  on,
  toast,
} from "./bridge";
import { editImage, importImage } from "./editor";
import type { Entry, Init } from "./types";
const root = document.querySelector<HTMLDivElement>("#app")!;
let state: Init,
  tab = "history";
export async function launch() {
  try {
    state = await call<Init>("init");
    await on("library-changed", refresh);
    await on<string>("panel-route", (route) =>
      routeTo(route).catch(handleError),
    );
    await on("notice", toast);
    await on("recording-finished", refresh);
    window.addEventListener("focus", () => {
      if (tab === "settings") void checkScreenPermission().catch(handleError);
    });
    document.addEventListener("click", (event) => {
      for (const menu of root.querySelectorAll<HTMLDetailsElement>(
        ".setting-picker[open]",
      )) {
        if (!menu.contains(event.target as Node)) menu.open = false;
      }
    });
    render();
    await routeTo(
      new URLSearchParams(location.search).get("panel") || "history",
    );
  } catch (e) {
    handleError(e);
  }
}
async function refresh() {
  state = await call<Init>("init");
  render();
}
async function routeTo(route: string) {
  if (route.startsWith("edit:")) {
    tab = "history";
    render();
    const data = await call<string>("clipboard_image_data", {
      id: route.slice(5),
    });
    await editImage(data, refresh);
    return;
  }
  tab = route === "settings" ? "settings" : "history";
  render();
  if (tab === "settings") await checkScreenPermission();
}
async function checkScreenPermission() {
  state.screenPermission = await call<boolean>("screen_permission_status");
  const note = root.querySelector<HTMLElement>(".permission-note");
  if (note) note.hidden = state.screenPermission !== false;
}
function render() {
  root.innerHTML = `<div class="optional-panel"><header class="panel-header"><div><h1>截图猫</h1><p>平时只在托盘待命，需要时再来这里。</p></div><nav aria-label="辅助面板"><button data-tab="history" aria-current="${tab === "history" ? "page" : "false"}">截图与视频</button><button data-tab="settings" aria-current="${tab === "settings" ? "page" : "false"}">偏好设置</button></nav></header>${tab === "settings" ? settings() : history()}</div>`;
  bind(root, "[data-tab]", (e) =>
    routeTo((e.currentTarget as HTMLElement).dataset.tab!),
  );
  bind(root, "[data-import]", () => importImage(refresh));
  bind(root, "[data-save-settings]", saveSettings);
  bind(root, "[data-entry]", (e) =>
    preview(
      state.entries.find(
        (i) => i.id === (e.currentTarget as HTMLElement).dataset.entry,
      )!,
    ),
  );
  bind(root, "[data-permission]", async () => {
    const ready = await call<boolean>("request_screen_permission");
    toast(ready ? "屏幕权限已就绪" : "授权后退出并重新打开截图猫");
    await checkScreenPermission();
  });
  for (const picker of root.querySelectorAll<HTMLDetailsElement>(
    ".setting-picker",
  )) {
    const trigger = picker.querySelector("summary")!;
    picker.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && picker.open) {
        event.preventDefault();
        picker.open = false;
        trigger.focus();
      }
    });
    picker.addEventListener("change", (event) => {
      const option = event.target as HTMLInputElement;
      trigger.querySelector("span")!.textContent = option.dataset.label!;
    });
    for (const input of picker.querySelectorAll("input")) {
      input.addEventListener("click", () => {
        picker.open = false;
        trigger.focus();
      });
    }
  }
}
function history() {
  return `<section><div class="panel-section-heading"><span>${state.entries.length} 条本地记录</span><button class="button" data-import>${icon("upload-simple")} 导入图片</button></div>${state.entries.length ? `<div class="panel-history">${state.entries.map((e) => `<button class="history-item" data-entry="${e.id}" aria-label="打开${e.kind === "video" ? "视频" : "截图"} ${new Date(e.createdAt).toLocaleString()}"><div class="history-thumb">${e.kind === "video" ? icon("play-circle") : `<img src="${escape(mediaUrl(e, state))}" alt="截图预览" loading="lazy"/>`}</div><span><strong>${e.kind === "video" ? "视频" : e.kind === "gif" ? "GIF" : "截图"}</strong><small>${new Date(e.createdAt).toLocaleString("zh-CN")} · ${e.width}×${e.height}</small></span>${icon("arrow-up-right")}</button>`).join("")}</div>` : '<div class="panel-empty"><strong>还没有截图或视频</strong><p>从托盘菜单截图，或导入图片进行标注。</p></div>'}</section>`;
}
function picker(
  key: string,
  value: string | number,
  options: [string | number, string][],
) {
  const label =
    options.find(([option]) => option === value)?.[1] ?? options[0][1];
  return `<details class="setting-picker" id="${key}"><summary aria-labelledby="${key}-label ${key}-value"><span id="${key}-value">${escape(label)}</span>${icon("caret-down")}</summary><div class="picker-options" role="radiogroup" aria-labelledby="${key}-label">${options.map(([option, name]) => `<label class="picker-option"><input type="radio" name="${key}" value="${option}" data-label="${escape(name)}" ${option === value ? "checked" : ""}><span>${escape(name)}</span>${icon("check")}</label>`).join("")}</div></details>`;
}
function settings() {
  return `<section class="panel-settings"><div class="permission-note" ${state.screenPermission === false ? "" : "hidden"}><div><strong>当前安装的截图猫未获屏幕录制权限</strong><p>如果系统设置里已开启，请移除旧的截图猫条目，重新添加当前安装的截图猫，再退出并重新打开。</p></div><button class="button" data-permission>打开屏幕录制设置</button></div>
  <div class="setting-row"><div><label id="fps-label">视频帧率</label><p>更高帧率会占用更多资源</p></div>${picker(
    "fps",
    state.settings.fps,
    [15, 30, 60].map((n) => [n, `${n} FPS`]),
  )}</div>
  <div class="setting-row"><div><label id="countdown-label">开始前倒计时</label></div>${picker(
    "countdown",
    state.settings.countdown,
    [
      [0, "立即开始"],
      [3, "3 秒"],
      [5, "5 秒"],
    ],
  )}</div>
  <div class="setting-row"><div><label id="encoder-label">编码方式</label></div>${picker(
    "encoder",
    state.settings.encoder,
    [
      ["auto", "自动 · 硬件优先"],
      ["software", "软件 · 兼容优先"],
    ],
  )}</div>
  <div class="settings-action"><button class="button primary" data-save-settings>保存设置</button></div><h2>快捷键</h2>${state.shortcuts.map((s) => `<div class="shortcut-row"><span>${escape(s.label)}${s.registered ? "" : " · 被占用"}</span><kbd>${escape(s.key)}</kbd></div>`).join("")}<p class="settings-note">文字和图片剪贴板最多保留 100 条、128 MiB，可在托盘暂停记录。macOS 自动粘贴需要辅助功能权限；未授权时仍可复制后按 ⌘V。</p><p class="settings-note">录制暂不包含声音。关闭此窗口仍在托盘运行。</p></section>`;
}
async function saveSettings() {
  const choice = (key: string) =>
    root.querySelector<HTMLInputElement>(`#${key} input:checked`)!.value;
  const settings = {
    fps: +choice("fps"),
    countdown: +choice("countdown"),
    encoder: choice("encoder"),
  };
  await call("save_settings", { settings });
  state.settings = settings;
  toast("设置已保存");
}
async function preview(e: Entry) {
  const dialog = document.createElement("dialog");
  dialog.className = "preview-dialog";
  dialog.innerHTML = `<div class="dialog-header"><strong>${e.kind === "video" ? "视频" : "截图"} · ${e.width} × ${e.height}</strong><button class="icon-button" data-close aria-label="关闭预览">${icon("x")}</button></div><div class="preview-stage">${e.kind === "video" ? `<video src="${escape(mediaUrl(e, state))}" controls></video>` : `<img src="${escape(mediaUrl(e, state))}" alt="截图"/>`}</div><div class="dialog-footer"><span>仅保存在本机</span><div>${e.kind === "image" ? `<button class="button" data-edit>标注</button><button class="button" data-pin>桌面贴图</button>` : ""}<button class="button primary" data-export>导出</button></div></div>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener("close", () => dialog.remove());
  bind(dialog, "[data-close]", () => dialog.close());
  bind(dialog, "[data-pin]", async () => {
    await call("pin_entry", { id: e.id });
    toast("已贴到桌面");
  });
  bind(dialog, "[data-edit]", async () => {
    const response = await fetch(mediaUrl(e, state));
    const blob = await response.blob();
    const data = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
    dialog.close();
    await editImage(data, refresh);
  });
  bind(dialog, "[data-export]", async () => {
    if (native) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const destination = await save({ defaultPath: e.name });
      if (destination) {
        await call("export_entry", { id: e.id, destination });
        toast("文件已导出");
      }
    } else {
      const a = document.createElement("a");
      a.href = mediaUrl(e, state);
      a.download = e.name;
      a.click();
    }
  });
}
