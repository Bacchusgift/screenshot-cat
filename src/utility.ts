import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import { call, bind, handleError, icon, on, toast } from "./bridge";
import { Drawing, type Tool } from "./drawing";
import { annotationTools, bindAnnotationTools } from "./annotations";
import type { Entry, Init, Rect, Selection, Settings } from "./types";
const root = document.querySelector<HTMLDivElement>("#app")!;
export async function overlay() {
  document.documentElement.style.background = "transparent";
  document.body.className = "overlay-body";
  const selection = await call<Selection>("overlay_data");
  const isImage = selection.mode === "image";
  root.innerHTML = `<div class="selection-overlay"><img class="screen-image" src="${selection.image}" alt="待截取屏幕" draggable="false"/><div class="selection-shade"></div><div class="selection-hint">${icon("corners-out")} 拖动选择${isImage ? "截图" : "录制"}区域 <kbd>Esc 取消</kbd></div><div class="selection-box" hidden><div class="selection-size"></div></div>${isImage ? "" : `<div class="selection-actions" hidden><div class="selection-buttons"><button class="button" data-reselect>重新选择</button><button class="button primary" data-confirm>下一步 ${icon("check")}</button></div></div>`}</div>`;
  const container = root.querySelector<HTMLElement>(".selection-overlay")!;
  const box = root.querySelector<HTMLElement>(".selection-box")!;
  const actions = root.querySelector<HTMLElement>(".selection-actions");
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
    rect = null;
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
  container.addEventListener("pointercancel", () => {
    if (!start) return;
    start = null;
    rect = null;
    box.hidden = true;
  });
  container.addEventListener("pointerup", () => {
    if (!start) return;
    start = null;
    if (!rect || rect.width < 4 || rect.height < 4) {
      box.hidden = true;
      return;
    }
    locked = true;
    if (!actions) {
      finishSelection().catch(handleError);
      return;
    }
    box.classList.add("selection-locked");
    actions.hidden = false;
    const { width, height } = actions.getBoundingClientRect();
    actions.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.x + rect.width - width))}px`;
    const below = rect.y + rect.height + 10;
    const above = rect.y - height - 10;
    const top = below + height <= innerHeight - 8 || above < 8 ? below : above;
    actions.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, top))}px`;
  });
  bind(root, "[data-reselect]", () => {
    locked = false;
    box.classList.remove("selection-locked");
    box.hidden = true;
    if (actions) actions.hidden = true;
    rect = null;
  });
  function actualRect(r: Rect): Rect {
    const sx = selection.width / innerWidth;
    const sy = selection.height / innerHeight;
    const x = Math.floor(r.x * sx);
    const y = Math.floor(r.y * sy);
    return {
      x,
      y,
      width: Math.floor((r.x + r.width) * sx) - x,
      height: Math.floor((r.y + r.height) * sy) - y,
    };
  }
  let submitting = false;
  const finishSelection = async () => {
    if (!rect || submitting) return;
    submitting = true;
    const buttons = actions?.querySelectorAll("button");
    buttons?.forEach((button) => (button.disabled = true));
    try {
      await call("select_region", { rect: actualRect(rect) });
    } catch (error) {
      if (isImage) {
        locked = false;
        box.hidden = true;
        rect = null;
      }
      throw error;
    } finally {
      submitting = false;
      buttons?.forEach((button) => (button.disabled = false));
    }
  };
  bind(root, "[data-confirm]", finishSelection);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && !recording && !submitting)
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
  document.documentElement.classList.add("pin-document");
  document.body.className = "pin-body";
  const id = new URLSearchParams(location.search).get("id");
  const entry = await call<Entry & { data: string }>("pin_data", { id });
  const windowHandle = getCurrentWindow();
  root.innerHTML = `<img class="pinned-image" alt="桌面置顶截图" draggable="false"/><canvas class="pin-canvas" aria-label="贴图标注画布" hidden></canvas><div class="pin-tools" role="toolbar" aria-label="贴图工具栏" hidden>${annotationTools}<div class="pin-actions"><button type="button" class="tool" data-pin-cancel title="取消 (Esc)" aria-label="取消标注">${icon("x")}</button><button type="button" class="tool" data-pin-done title="保存 (⌘/Ctrl+Enter)">${icon("check")} 保存</button></div></div>`;
  const image = root.querySelector<HTMLImageElement>("img")!;
  const canvas = root.querySelector<HTMLCanvasElement>("canvas")!;
  const toolbar = root.querySelector<HTMLElement>(".pin-tools")!;
  let edited: string | null = null;
  let drawing: Drawing | undefined;
  let annotation: ReturnType<typeof bindAnnotationTools> | undefined;
  const saveButton =
    toolbar.querySelector<HTMLButtonElement>("[data-pin-done]")!;
  let saving = false;
  let exporting = false;
  let hovered = false;
  let hideUntilExit = false;
  image.src = entry.data;

  function syncToolbar() {
    toolbar.hidden = !drawing && (!hovered || hideUntilExit);
  }
  root.addEventListener("pointerenter", () => {
    hovered = true;
    syncToolbar();
  });
  root.addEventListener("pointerleave", () => {
    hovered = false;
    hideUntilExit = false;
    syncToolbar();
  });

  function edit(tool: Tool = "pen") {
    if (
      drawing ||
      saving ||
      exporting ||
      !image.naturalWidth ||
      !image.complete
    )
      return;
    hideUntilExit = false;
    drawing = new Drawing(canvas, entry.width, entry.height);
    drawing.width = Math.max(4, Math.round(4 * devicePixelRatio));
    drawing.background = image;
    drawing.render();
    annotation = bindAnnotationTools(toolbar, drawing);
    annotation.selectTool(tool);
    root.classList.add("pin-editing");
    canvas.hidden = false;
    syncToolbar();
  }
  function endEdit() {
    annotation?.destroy();
    drawing?.destroy();
    drawing = undefined;
    annotation = undefined;
    canvas.hidden = true;
    root.classList.remove("pin-editing");
    hideUntilExit = hovered;
    syncToolbar();
  }
  async function saveEdits() {
    if (!drawing || saving) return;
    annotation?.commitText();
    if (!drawing.strokes.length) {
      endEdit();
      return;
    }
    saving = true;
    toolbar.inert = true;
    canvas.style.pointerEvents = "none";
    saveButton.textContent = "保存中…";
    try {
      const data = canvas.toDataURL("image/png");
      await call("save_pin_edit", { id, data });
      edited = data;
      image.src = data;
      await image.decode().catch(() => {});
      endEdit();
    } finally {
      saving = false;
      toolbar.inert = false;
      canvas.style.pointerEvents = "";
      saveButton.innerHTML = `${icon("check")} 保存`;
    }
  }
  function cancelEdit() {
    if (drawing && !saving) endEdit();
  }
  async function saveAs() {
    if (exporting || saving) return;
    exporting = true;
    try {
      // Export the current canvas without changing the saved version if canceled.
      annotation?.commitText();
      const data = drawing?.strokes.length
        ? canvas.toDataURL("image/png")
        : edited;
      if (await call<boolean>("save_pin_as", { id, data })) {
        await windowHandle.close();
      }
    } finally {
      exporting = false;
    }
  }
  const close = () => windowHandle.close().catch(handleError);
  const baseMenu = [
    { text: "另存为…", action: () => saveAs().catch(handleError) },
    { text: "关闭贴图", action: close },
  ];
  // Native menus can extend outside the image, even for very small crops.
  let viewMenu: Promise<Menu> | undefined;
  let editMenu: Promise<Menu> | undefined;
  function popup(x: number, y: number) {
    const menu = drawing
      ? (editMenu ??= Menu.new({
          items: [
            { text: "保存标注", action: () => saveEdits().catch(handleError) },
            { text: "取消标注", action: cancelEdit },
            ...(
              [
                ["pen", "画笔"],
                ["arrow", "箭头"],
                ["rectangle", "矩形"],
                ["text", "文字"],
                ["number", "连续编号"],
              ] as const
            ).map(([tool, text]) => ({
              text,
              action: () =>
                toolbar
                  .querySelector<HTMLButtonElement>(`[data-mark="${tool}"]`)
                  ?.click(),
            })),
            {
              text: "撤销标注",
              action: () =>
                toolbar
                  .querySelector<HTMLButtonElement>("[data-mark-undo]")
                  ?.click(),
            },
            ...baseMenu.map((item) => ({ ...item })),
          ],
        }))
      : (viewMenu ??= Menu.new({
          items: [
            { text: "编辑贴图", action: () => edit() },
            ...baseMenu.map((item) => ({ ...item })),
          ],
        }));
    menu.then((m) => m.popup(new LogicalPosition(x, y))).catch(handleError);
  }
  document.addEventListener("contextmenu", (event) => {
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    popup(event.clientX, event.clientY);
  });
  image.addEventListener("mousedown", (event) => {
    if (!drawing && event.button === 0 && !event.ctrlKey) {
      event.preventDefault();
      windowHandle.startDragging().catch(handleError);
    }
  });
  bind(toolbar, "[data-mark]", (event) => {
    if (!drawing)
      edit((event.currentTarget as HTMLButtonElement).dataset.mark as Tool);
  });
  bind(toolbar, "[data-pin-done]", saveEdits);
  bind(toolbar, "[data-pin-cancel]", cancelEdit);
  document.addEventListener("keydown", (event) => {
    if (event.isComposing || event.defaultPrevented) return;
    const modified = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (modified && key === "w") close();
    else if (modified && key === "s") saveAs().catch(handleError);
    else if (modified && key === "enter" && drawing)
      saveEdits().catch(handleError);
    else if (key === "escape" && drawing) cancelEdit();
    else if (key === "contextmenu" || (event.shiftKey && key === "f10"))
      popup(Math.min(12, innerWidth / 2), Math.min(12, innerHeight / 2));
    else return;
    event.preventDefault();
  });
}
