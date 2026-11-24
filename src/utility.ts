import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import { call, bind, escape, handleError, icon, on, toast } from "./bridge";
import { Drawing, type Tool } from "./drawing";
import type { Entry, Init, Rect, Selection, Settings } from "./types";
import { convertFileSrc } from "@tauri-apps/api/core";
const root = document.querySelector<HTMLDivElement>("#app")!;
export async function overlay() {
  document.documentElement.style.background = "transparent";
  document.body.className = "overlay-body";
  const selection = await call<Selection>("overlay_data");
  root.innerHTML = `<div class="selection-overlay"><img class="screen-image" src="${selection.image}" alt="待截取屏幕" draggable="false"/><div class="selection-shade"></div><div class="selection-hint">${icon("corners-out")} 拖动选择${selection.mode === "image" ? "截图" : "录制"}区域 <kbd>Esc 取消</kbd></div><div class="selection-box" hidden><div class="selection-size"></div></div><div class="selection-actions" hidden><button class="button" data-reselect>重新选择</button><button class="button primary" data-confirm>${selection.mode === "image" ? "确认截图" : "下一步"} ${icon("check")}</button></div></div>`;
  const container = root.querySelector<HTMLElement>(".selection-overlay")!;
  const box = root.querySelector<HTMLElement>(".selection-box")!;
  const actions = root.querySelector<HTMLElement>(".selection-actions")!;
  let start: { x: number; y: number } | null = null,
    rect: Rect | null = null,
    locked = false,
    recording = false;
  const point = (e: PointerEvent) => ({
    x: Math.max(0, Math.min(innerWidth, e.clientX)),
    y: Math.max(0, Math.min(innerHeight, e.clientY)),
  });
  container.addEventListener("pointerdown", (e) => {
    if (locked || e.button !== 0 || (e.target as Element).closest("button"))
      return;
    start = point(e);
    container.setPointerCapture(e.pointerId);
    box.hidden = false;
  });
  container.addEventListener("pointermove", (e) => {
    if (!start) return;
    const p = point(e);
    rect = {
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      width: Math.abs(p.x - start.x),
      height: Math.abs(p.y - start.y),
    };
    Object.assign(box.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    box.querySelector(".selection-size")!.textContent =
      `${Math.round((rect.width * selection.width) / innerWidth)} × ${Math.round((rect.height * selection.height) / innerHeight)} px`;
  });
  container.addEventListener("pointerup", () => {
    if (!start) return;
    start = null;
    if (!rect || rect.width < 4 || rect.height < 4) {
      box.hidden = true;
      return;
    }
    locked = true;
    actions.hidden = false;
    actions.style.left = `${Math.max(8, Math.min(innerWidth - 290, rect.x + rect.width - 280))}px`;
    actions.style.top = `${Math.max(8, Math.min(innerHeight - 60, rect.y + rect.height + 12))}px`;
  });
  bind(root, "[data-reselect]", () => {
    locked = false;
    box.hidden = true;
    actions.hidden = true;
    rect = null;
  });
  bind(root, "[data-confirm]", async () => {
    if (!rect) return;
    const sx = selection.width / innerWidth,
      sy = selection.height / innerHeight;
    const actual = {
      x: Math.floor(rect.x * sx),
      y: Math.floor(rect.y * sy),
      width: Math.floor(rect.width * sx),
      height: Math.floor(rect.height * sy),
    };
    await call("select_region", { rect: actual });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !recording)
      call("cancel_capture").catch(handleError);
  });
  let drawing: Drawing | undefined;
  await on<Rect>("selection-ready", (r) => {
    recording = true;
    container.innerHTML = `<div class="record-region" style="inset:0;width:100%;height:100%"><canvas aria-label="录制标注画布"></canvas></div>`;
    const canvas = container.querySelector("canvas")!;
    drawing = new Drawing(canvas, r.width, r.height);
    container.classList.add("recording-overlay");
  });
  await on<boolean>("drawing-mode", (enabled) =>
    container.classList.toggle("drawing-active", enabled),
  );
  await on<{ tool?: Tool; color?: string; clear?: boolean; undo?: boolean }>(
    "drawing-tool",
    (config) => {
      if (!drawing) return;
      if (config.tool) drawing.tool = config.tool;
      if (config.color) drawing.color = config.color;
      if (config.clear) drawing.clear();
      if (config.undo) drawing.undo();
    },
  );
}
export async function controls() {
  document.body.className = "controls-body";
  const mode = new URLSearchParams(location.search).get("mode");
  let started = false,
    starting = false,
    drawing = false,
    elapsed = 0,
    timer = 0,
    countdown = 3;
  // Settings are supplied by the selection command, not broad main-window permissions.
  root.innerHTML = `<div class="record-controls"><span class="control-grip" data-drag title="拖动控制条">${icon("dots-six-vertical")}</span><span class="record-timer"><span class="record-dot"></span><span id="time">准备录制</span></span><span class="divider"></span><button class="control-button" data-draw disabled>${icon("pencil-simple")}<span>绘制</span></button><button class="tool" data-tool="pen" aria-label="画笔" title="画笔" disabled>${icon("pencil-simple")}</button><button class="tool" data-tool="arrow" aria-label="箭头" title="箭头" disabled>${icon("arrow-up-right")}</button><button class="tool" data-tool="rectangle" aria-label="矩形" title="矩形" disabled>${icon("rectangle")}</button><button class="tool" data-clear aria-label="清空标注" title="清空标注" disabled>${icon("eraser")}</button><span class="divider"></span><button class="button primary record-start" data-start>${icon("record")} 开始录制</button><button class="icon-button" data-cancel aria-label="取消录制">${icon("x")}</button></div>`;
  const time = root.querySelector("#time")!;
  const startButton = root.querySelector<HTMLButtonElement>("[data-start]")!;
  const settings = await call<Settings>("recording_settings");
  countdown = settings.countdown;
  bind(root, "[data-drag]", () => getCurrentWindow().startDragging());
  bind(root, "[data-cancel]", async () => {
    if (started || starting) await call("stop_recording");
    else await call("cancel_recording");
  });
  bind(root, "[data-start]", async () => {
    if (started) {
      startButton.disabled = true;
      startButton.textContent = "正在保存…";
      await call("stop_recording");
      return;
    }
    if (starting) return;
    starting = true;
    startButton.disabled = true;
    root.querySelector<HTMLButtonElement>("[data-cancel]")!.disabled = true;
    try {
      for (let i = countdown; i > 0; i--) {
        time.textContent = `${i} 秒后开始`;
        await new Promise((r) => setTimeout(r, 1000));
      }
      time.textContent = "正在启动…";
      await call("start_recording");
      started = true;
      time.textContent = "00:00";
      const begin = Date.now();
      timer = window.setInterval(() => {
        elapsed = Math.floor((Date.now() - begin) / 1000);
        time.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}${mode === "gif" ? " / 15s" : ""}`;
      }, 250);
      startButton.disabled = false;
      startButton.classList.add("stop-button");
      startButton.innerHTML = `${icon("stop")} 停止录制`;
      root
        .querySelectorAll<HTMLButtonElement>(
          "[data-draw],[data-tool],[data-clear]",
        )
        .forEach((b) => (b.disabled = false));
    } catch (e) {
      starting = false;
      startButton.disabled = false;
      startButton.textContent = "重试录制";
      handleError(e);
    } finally {
      const cancel = root.querySelector<HTMLButtonElement>("[data-cancel]");
      if (cancel) cancel.disabled = false;
    }
  });
  bind(root, "[data-draw]", () => call("toggle_drawing"));
  bind(root, "[data-tool]", async (e) => {
    const tool = (e.currentTarget as HTMLElement).dataset.tool!;
    if (!drawing) await call("toggle_drawing");
    await emitTo("overlay", "drawing-tool", { tool });
    root
      .querySelectorAll("[data-tool]")
      .forEach((b) => b.classList.toggle("selected", b === e.currentTarget));
  });
  bind(root, "[data-clear]", () =>
    emitTo("overlay", "drawing-tool", { clear: true }),
  );
  await on<boolean>("drawing-mode", (value) => {
    drawing = value;
    const b = root.querySelector("[data-draw]")!;
    b.classList.toggle("selected", value);
    b.setAttribute("aria-pressed", String(value));
    b.querySelector("span")!.textContent = value ? "操作原窗口" : "绘制";
  });
  window.addEventListener("unload", () => clearInterval(timer));
}
export async function pin() {
  document.body.className = "pin-body";
  const id = new URLSearchParams(location.search).get("id");
  const e = await call<Entry & { path: string }>("pin_data", { id });
  root.innerHTML = `<div class="pin-title"><span data-drag>${icon("push-pin")} 桌面贴图 <small>${e.width} × ${e.height}</small></span><button class="icon-button" data-close aria-label="关闭贴图">${icon("x")}</button></div><img class="pinned-image" src="${escape(convertFileSrc(e.path))}" alt="桌面置顶截图" draggable="false"/>`;
  bind(root, "[data-drag]", () => getCurrentWindow().startDragging());
  bind(root, "[data-close]", () => getCurrentWindow().close());
}
