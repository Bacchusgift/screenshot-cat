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
    await refresh();
  });
}
function history() {
  return `<section><div class="panel-section-heading"><span>${state.entries.length} 条本地记录</span><button class="button" data-import>${icon("upload-simple")} 导入图片</button></div>${state.entries.length ? `<div class="panel-history">${state.entries.map((e) => `<button class="history-item" data-entry="${e.id}" aria-label="打开${e.kind === "video" ? "视频" : "截图"} ${new Date(e.createdAt).toLocaleString()}"><div class="history-thumb">${e.kind === "video" ? icon("play-circle") : `<img src="${escape(mediaUrl(e, state))}" alt="截图预览" loading="lazy"/>`}</div><span><strong>${e.kind === "video" ? "视频" : e.kind === "gif" ? "GIF" : "截图"}</strong><small>${new Date(e.createdAt).toLocaleString("zh-CN")} · ${e.width}×${e.height}</small></span>${icon("arrow-up-right")}</button>`).join("")}</div>` : '<div class="panel-empty"><strong>还没有截图或视频</strong><p>从托盘菜单截图，或导入图片进行标注。</p></div>'}</section>`;
}
function settings() {
  return `<section class="panel-settings">${state.screenPermission === false ? '<div class="permission-note"><div><strong>需要屏幕录制权限</strong><p>允许后才能截取完整窗口和录制桌面。</p></div><button class="button" data-permission>设置屏幕权限</button></div>' : ""}<div class="setting-row"><div><label for="fps">视频帧率</label><p>更高帧率会占用更多资源</p></div><select id="fps">${[15, 30, 60].map((n) => `<option value="${n}" ${state.settings.fps === n ? "selected" : ""}>${n} FPS</option>`).join("")}</select></div><div class="setting-row"><div><label for="countdown">开始前倒计时</label></div><select id="countdown">${[0, 3, 5].map((n) => `<option value="${n}" ${state.settings.countdown === n ? "selected" : ""}>${n ? `${n} 秒` : "立即开始"}</option>`).join("")}</select></div><div class="setting-row"><div><label for="encoder">编码方式</label></div><select id="encoder"><option value="auto" ${state.settings.encoder === "auto" ? "selected" : ""}>自动 · 硬件优先</option><option value="software" ${state.settings.encoder === "software" ? "selected" : ""}>软件 · 兼容优先</option></select></div><div class="settings-action"><button class="button primary" data-save-settings>保存设置</button></div><h2>快捷键</h2>${state.shortcuts.map((s) => `<div class="shortcut-row"><span>${escape(s.label)}${s.registered ? "" : " · 被占用"}</span><kbd>${escape(s.key)}</kbd></div>`).join("")}<p class="settings-note">文字和图片剪贴板最多保留 100 条、128 MiB，可在托盘暂停记录。macOS 自动粘贴需要辅助功能权限；未授权时仍可复制后按 ⌘V。</p><p class="settings-note">录制暂不包含声音。关闭此窗口仍在托盘运行。</p></section>`;
}
async function saveSettings() {
  const settings = {
    fps: +root.querySelector<HTMLSelectElement>("#fps")!.value,
    countdown: +root.querySelector<HTMLSelectElement>("#countdown")!.value,
    encoder: root.querySelector<HTMLSelectElement>("#encoder")!.value,
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
