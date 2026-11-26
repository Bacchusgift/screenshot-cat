import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import { call, bind, handleError, icon, on, toast } from "./bridge";
import { native } from "./bridge";
import { Drawing, type Tool } from "./drawing";
import { annotationTools, bindAnnotationTools } from "./annotations";
import type { Entry, Init, Rect, Selection, Settings } from "./types";
const root = document.querySelector<HTMLDivElement>("#app")!;
export async function overlay() {
  document.documentElement.style.background = "transparent";
  document.body.className = "overlay-body";
  const selection = await call<Selection>("overlay_data");
  const isImage = selection.mode === "image";
  const hasFrozen = Boolean(selection.image);
  root.innerHTML = `<div class="selection-overlay">${hasFrozen ? `<img class="screen-image" src="${selection.image}" alt="待截取屏幕" draggable="false"/>` : ""}<div class="selection-shade"></div><div class="selection-hint">${icon("corners-out")} ${isImage ? "点击窗口或拖动框选 · 右键/Esc 取消" : "拖动选择录制区域 · Esc 取消"}${isImage ? `${hasFrozen ? " <kbd>C 取色</kbd>" : ""} <kbd>Shift 调框</kbd>` : ""}</div><div class="selection-box" hidden><div class="selection-size"></div>${isImage ? `<span class="resize-handle" data-handle="nw"></span><span class="resize-handle" data-handle="n"></span><span class="resize-handle" data-handle="ne"></span><span class="resize-handle" data-handle="e"></span><span class="resize-handle" data-handle="se"></span><span class="resize-handle" data-handle="s"></span><span class="resize-handle" data-handle="sw"></span><span class="resize-handle" data-handle="w"></span>` : ""}</div>${isImage && hasFrozen ? `<div class="selection-loupe" hidden><canvas width="121" height="121"></canvas><div class="loupe-meta"><span class="loupe-swatch"></span><span class="loupe-hex">#000000</span><span class="loupe-pos">0, 0</span></div><div class="loupe-tip">按 C 复制色值 · Shift 切换 RGB</div></div>` : ""}${isImage ? `<div class="selection-actions" hidden><div class="selection-buttons"><button class="button" data-reselect>重选</button><button class="button" data-copy-only title="仅复制到剪贴板">复制</button><button class="button primary" data-confirm title="贴在桌面并复制 (Enter)">贴图并复制 ${icon("check")}</button></div></div>` : `<div class="selection-actions" hidden><div class="selection-buttons"><button class="button" data-reselect>重新选择</button><button class="button primary" data-confirm>下一步 ${icon("check")}</button></div></div>`}</div>`;
  const container = root.querySelector<HTMLElement>(".selection-overlay")!;
  const crosshairX = document.createElement("div");
  crosshairX.className = "selection-crosshair-x";
  crosshairX.hidden = true;
  const crosshairY = document.createElement("div");
  crosshairY.className = "selection-crosshair-y";
  crosshairY.hidden = true;
  if (isImage) container.append(crosshairX, crosshairY);
  const screenImage = root.querySelector<HTMLImageElement>(".screen-image");
  const hint = root.querySelector<HTMLElement>(".selection-hint")!;
  const box = root.querySelector<HTMLElement>(".selection-box")!;
  const sizeLabel = box.querySelector<HTMLElement>(".selection-size")!;
  const actions = root.querySelector<HTMLElement>(".selection-actions");
  const loupe = root.querySelector<HTMLElement>(".selection-loupe");
  const loupeCanvas = loupe?.querySelector<HTMLCanvasElement>("canvas");
  const loupeCtx = loupeCanvas?.getContext("2d");
  const loupeSwatch = loupe?.querySelector<HTMLElement>(".loupe-swatch");
  const loupeHex = loupe?.querySelector<HTMLElement>(".loupe-hex");
  const loupePos = loupe?.querySelector<HTMLElement>(".loupe-pos");
  let start: { x: number; y: number } | null = null,
    rect: Rect | null = null,
    hoveredWindow: Rect | null = null,
    locked = false,
    recording = false,
    adjusting = false,
    dragMode: string | null = null,
    dragOrigin: { x: number; y: number; rect: Rect } | null = null,
    lastPointer = { x: 0, y: 0 },
    rgbMode = false,
    currentColor = "";
  let sampleCanvas: HTMLCanvasElement | null = null;
  let sampleCtx: CanvasRenderingContext2D | null = null;
  if (isImage && screenImage) {
    const loadSample = () => {
      if (!screenImage.naturalWidth || !screenImage.naturalHeight) return;
      sampleCanvas = document.createElement("canvas");
      sampleCanvas.width = screenImage.naturalWidth;
      sampleCanvas.height = screenImage.naturalHeight;
      sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
      sampleCtx?.drawImage(screenImage, 0, 0);
    };
    if (screenImage.complete) loadSample();
    else screenImage.addEventListener("load", loadSample, { once: true });
  }
  const point = (e: PointerEvent) => ({
    x: Math.max(0, Math.min(innerWidth, e.clientX)),
    y: Math.max(0, Math.min(innerHeight, e.clientY)),
  });
  const toCssRect = (physical: Rect): Rect => {
    const sx = innerWidth / selection.width;
    const sy = innerHeight / selection.height;
    return {
      x: physical.x * sx,
      y: physical.y * sy,
      width: physical.width * sx,
      height: physical.height * sy,
    };
  };
  const cssWindows = (selection.windows ?? []).map(toCssRect);
  const findWindowAt = (p: { x: number; y: number }): Rect | null => {
    const hits = cssWindows.filter(
      (candidate) =>
        p.x >= candidate.x &&
        p.x <= candidate.x + candidate.width &&
        p.y >= candidate.y &&
        p.y <= candidate.y + candidate.height,
    );
    if (!hits.length) return null;
    hits.sort((a, b) => a.width * a.height - b.width * b.height);
    return { ...hits[0] };
  };
  let hitStack: Rect[] = [];
  let hitIndex = 0;
  const findWindowStackAt = (p: { x: number; y: number }): Rect[] => {
    const hits = cssWindows.filter(
      (candidate) =>
        p.x >= candidate.x &&
        p.x <= candidate.x + candidate.width &&
        p.y >= candidate.y &&
        p.y <= candidate.y + candidate.height,
    );
    hits.sort((a, b) => a.width * a.height - b.width * b.height);
    return hits.map((candidate) => ({ ...candidate }));
  };
  const renderBox = (target: Rect | null, isHover = false) => {
    if (!target) {
      box.hidden = true;
      box.classList.remove("selection-hover", "selection-adjustable");
      return;
    }
    box.hidden = false;
    box.classList.toggle("selection-hover", isHover);
    box.classList.toggle("selection-adjustable", adjusting && !isHover);
    Object.assign(box.style, {
      left: `${target.x}px`,
      top: `${target.y}px`,
      width: `${target.width}px`,
      height: `${target.height}px`,
    });
    const pw = Math.round((target.width * selection.width) / innerWidth);
    const ph = Math.round((target.height * selection.height) / innerHeight);
    sizeLabel.textContent = `${pw} × ${ph} px`;
    sizeLabel.style.top = target.y < 36 ? "6px" : "-30px";
  };
  const placeActions = (target: Rect) => {
    if (!actions) return;
    actions.hidden = false;
    const { width, height } = actions.getBoundingClientRect();
    actions.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, target.x + target.width - width))}px`;
    const below = target.y + target.height + 10;
    const above = target.y - height - 10;
    const top = below + height <= innerHeight - 8 || above < 8 ? below : above;
    actions.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, top))}px`;
  };
  const updateLoupe = (p: { x: number; y: number }) => {
    if (adjusting || recording) {
      if (loupe) loupe.hidden = true;
      crosshairX.hidden = true;
      crosshairY.hidden = true;
      return;
    }
    crosshairX.hidden = false;
    crosshairY.hidden = false;
    crosshairX.style.top = `${p.y}px`;
    crosshairY.style.left = `${p.x}px`;
    if (!loupe || !loupeCtx || !sampleCtx || !sampleCanvas) {
      if (loupe) loupe.hidden = true;
      return;
    }
    const px = Math.max(
      0,
      Math.min(
        sampleCanvas.width - 1,
        Math.floor((p.x * sampleCanvas.width) / innerWidth),
      ),
    );
    const py = Math.max(
      0,
      Math.min(
        sampleCanvas.height - 1,
        Math.floor((p.y * sampleCanvas.height) / innerHeight),
      ),
    );
    const patch = 11;
    const half = 5;
    const cell = 11;
    loupeCtx.imageSmoothingEnabled = false;
    loupeCtx.fillStyle = "#182420";
    loupeCtx.fillRect(0, 0, 121, 121);
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const sx = px + dx;
        const sy = py + dy;
        if (sx < 0 || sy < 0 || sx >= sampleCanvas.width || sy >= sampleCanvas.height) {
          continue;
        }
        const pixel = sampleCtx.getImageData(sx, sy, 1, 1).data;
        loupeCtx.fillStyle = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
        loupeCtx.fillRect((dx + half) * cell, (dy + half) * cell, cell, cell);
        if (dx === 0 && dy === 0) {
          const hex = `#${[pixel[0], pixel[1], pixel[2]]
            .map((v) => v.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase()}`;
          currentColor = rgbMode
            ? `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`
            : hex;
          if (loupeSwatch) loupeSwatch.style.background = hex;
          if (loupeHex) loupeHex.textContent = currentColor;
          if (loupePos) loupePos.textContent = `${px}, ${py}`;
        }
      }
    }
    loupeCtx.strokeStyle = "#ffffff55";
    loupeCtx.lineWidth = 1;
    for (let i = 1; i < patch; i++) {
      const offset = i * cell + 0.5;
      loupeCtx.beginPath();
      loupeCtx.moveTo(offset, 0);
      loupeCtx.lineTo(offset, 121);
      loupeCtx.moveTo(0, offset);
      loupeCtx.lineTo(121, offset);
      loupeCtx.stroke();
    }
    loupeCtx.strokeStyle = "#007AFF";
    loupeCtx.lineWidth = 2;
    loupeCtx.strokeRect(half * cell + 1, half * cell + 1, cell - 2, cell - 2);
    loupe.hidden = false;
    const lw = 148;
    const lh = 178;
    const left = p.x + 20 + lw <= innerWidth - 8 ? p.x + 20 : Math.max(8, p.x - lw - 20);
    const top = p.y + 20 + lh <= innerHeight - 8 ? p.y + 20 : Math.max(8, p.y - lh - 20);
    loupe.style.left = `${left}px`;
    loupe.style.top = `${top}px`;
  };
  container.addEventListener("contextmenu", (e) => {
    if (recording) return;
    e.preventDefault();
    if (adjusting && rect) {
      adjusting = false;
      locked = false;
      rect = null;
      if (actions) actions.hidden = true;
      renderBox(null);
      return;
    }
    if (!submitting) call("cancel_capture").catch(handleError);
  });
  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    const p = point(e);
    lastPointer = p;
    if (adjusting && rect) {
      const handleEl = (e.target as Element).closest<HTMLElement>("[data-handle]");
      if (handleEl) {
        dragMode = handleEl.dataset.handle!;
        dragOrigin = { x: p.x, y: p.y, rect: { ...rect } };
        container.setPointerCapture(e.pointerId);
        return;
      }
      if (
        p.x >= rect.x &&
        p.x <= rect.x + rect.width &&
        p.y >= rect.y &&
        p.y <= rect.y + rect.height
      ) {
        dragMode = "move";
        dragOrigin = { x: p.x, y: p.y, rect: { ...rect } };
        container.setPointerCapture(e.pointerId);
        return;
      }
      adjusting = false;
      locked = false;
      if (actions) actions.hidden = true;
    }
    if (locked) return;
    rect = null;
    start = p;
    hint.hidden = true;
    container.setPointerCapture(e.pointerId);
    renderBox({ x: p.x, y: p.y, width: 0, height: 0 });
  });
  container.addEventListener("pointermove", (e) => {
    const p = point(e);
    lastPointer = p;
    if (dragMode && dragOrigin && rect) {
      const dx = p.x - dragOrigin.x;
      const dy = p.y - dragOrigin.y;
      const base = dragOrigin.rect;
      let x1 = base.x;
      let y1 = base.y;
      let x2 = base.x + base.width;
      let y2 = base.y + base.height;
      if (dragMode === "move") {
        const nx = Math.max(0, Math.min(innerWidth - base.width, base.x + dx));
        const ny = Math.max(0, Math.min(innerHeight - base.height, base.y + dy));
        x1 = nx;
        y1 = ny;
        x2 = nx + base.width;
        y2 = ny + base.height;
      } else {
        if (dragMode.includes("w")) x1 = Math.max(0, Math.min(x2 - 4, base.x + dx));
        if (dragMode.includes("e")) x2 = Math.min(innerWidth, Math.max(x1 + 4, base.x + base.width + dx));
        if (dragMode.includes("n")) y1 = Math.max(0, Math.min(y2 - 4, base.y + dy));
        if (dragMode.includes("s")) y2 = Math.min(innerHeight, Math.max(y1 + 4, base.y + base.height + dy));
      }
      rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      renderBox(rect);
      placeActions(rect);
      return;
    }
    if (!start) {
      if (isImage && !locked && !adjusting) {
        hitStack = findWindowStackAt(p);
        if (hitIndex >= hitStack.length) hitIndex = 0;
        hoveredWindow = hitStack[hitIndex] ?? findWindowAt(p);
        renderBox(hoveredWindow, true);
        updateLoupe(p);
      }
      return;
    }
    rect = {
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      width: Math.abs(p.x - start.x),
      height: Math.abs(p.y - start.y),
    };
    renderBox(rect);
    updateLoupe(p);
  });
  container.addEventListener("pointercancel", () => {
    dragMode = null;
    dragOrigin = null;
    if (!start) return;
    start = null;
    rect = null;
    renderBox(null);
  });
  container.addEventListener("pointerup", (e) => {
    if (dragMode) {
      dragMode = null;
      dragOrigin = null;
      return;
    }
    if (!start) return;
    start = null;
    const isSmallClick = !rect || (rect.width < 4 && rect.height < 4);
    if (isSmallClick && isImage && hoveredWindow) {
      rect = { ...hoveredWindow };
      renderBox(rect);
    } else if (!rect || rect.width < 4 || rect.height < 4) {
      renderBox(null);
      return;
    }
    if (isImage && !e.shiftKey) {
      locked = true;
      if (loupe) loupe.hidden = true;
      crosshairX.hidden = true;
      crosshairY.hidden = true;
      finishSelection(true).catch(handleError);
      return;
    }
    locked = true;
    adjusting = isImage;
    if (loupe) loupe.hidden = true;
    crosshairX.hidden = true;
    crosshairY.hidden = true;
    renderBox(rect);
    box.classList.add("selection-locked");
    placeActions(rect);
  });
  bind(root, "[data-reselect]", () => {
    locked = false;
    adjusting = false;
    box.classList.remove("selection-locked");
    renderBox(null);
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
  const finishSelection = async (pinResult = true) => {
    if (!rect || submitting) return;
    submitting = true;
    const buttons = actions?.querySelectorAll("button");
    buttons?.forEach((button) => (button.disabled = true));
    try {
      await call(
        "select_region",
        pinResult ? { rect: actualRect(rect) } : { rect: actualRect(rect), pin: false },
      );
    } catch (error) {
      if (isImage) {
        locked = false;
        adjusting = false;
        renderBox(null);
        rect = null;
      }
      throw error;
    } finally {
      submitting = false;
      buttons?.forEach((button) => (button.disabled = false));
    }
  };
  bind(root, "[data-confirm]", () => finishSelection(true));
  bind(root, "[data-copy-only]", () => finishSelection(false));
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || recording || submitting) return;
    if (e.key === "Escape") {
      if (adjusting) {
        adjusting = false;
        locked = false;
        rect = null;
        if (actions) actions.hidden = true;
        renderBox(null);
        return;
      }
      call("cancel_capture").catch(handleError);
      return;
    }
    if (isImage && !adjusting && !locked) {
      const key = e.key.toLowerCase();
      if (e.key === "Tab" && hitStack.length > 1) {
        e.preventDefault();
        hitIndex = (hitIndex + 1) % hitStack.length;
        hoveredWindow = hitStack[hitIndex];
        renderBox(hoveredWindow, true);
        return;
      }
      if (key === "shift") {
        rgbMode = !rgbMode;
        updateLoupe(lastPointer);
        return;
      }
      if (key === "c" && currentColor) {
        e.preventDefault();
        call("copy_overlay_color", { text: currentColor })
          .then(() => call("cancel_capture"))
          .catch(handleError);
        return;
      }
    }
    if (adjusting && rect) {
      if (e.key === "Enter") {
        e.preventDefault();
        finishSelection(true).catch(handleError);
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const pxStepX = (step * innerWidth) / selection.width;
      const pxStepY = (step * innerHeight) / selection.height;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        const dx =
          e.key === "ArrowLeft" ? -pxStepX : e.key === "ArrowRight" ? pxStepX : 0;
        const dy =
          e.key === "ArrowUp" ? -pxStepY : e.key === "ArrowDown" ? pxStepY : 0;
        if (e.altKey) {
          rect = {
            x: rect.x,
            y: rect.y,
            width: Math.max(4, Math.min(innerWidth - rect.x, rect.width + dx)),
            height: Math.max(4, Math.min(innerHeight - rect.y, rect.height + dy)),
          };
        } else {
          rect = {
            x: Math.max(0, Math.min(innerWidth - rect.width, rect.x + dx)),
            y: Math.max(0, Math.min(innerHeight - rect.height, rect.y + dy)),
            width: rect.width,
            height: rect.height,
          };
        }
        renderBox(rect);
        placeActions(rect);
      }
    }
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
  if (native) {
    if (screenImage) await screenImage.decode().catch(() => {});
    await new Promise((r) => requestAnimationFrame(r));
    try {
      const win = getCurrentWindow();
      await win.show().catch(() => {});
      await win.setFocus().catch(() => {});
    } catch {}
  }
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
  let scale = 1;
  let opacity = 1;
  let hudTimer = 0;
  image.src = entry.data;
  if (native) {
    await image.decode().catch(() => {});
    await new Promise((r) => requestAnimationFrame(r));
    try {
      await windowHandle.show().catch(() => {});
      await windowHandle.setFocus().catch(() => {});
    } catch {}
  }
  const hud = document.createElement("div");
  hud.className = "pin-hud";
  hud.hidden = true;
  root.append(hud);
  function showHud(text: string) {
    hud.textContent = text;
    hud.hidden = false;
    clearTimeout(hudTimer);
    hudTimer = window.setTimeout(() => {
      hud.hidden = true;
    }, 900);
  }
  function setScale(next: number) {
    const clamped = Math.round(Math.max(0.25, Math.min(3, next)) * 100) / 100;
    if (clamped === scale) return;
    scale = clamped;
    call("resize_pin", { id, scale }).catch(handleError);
    showHud(`${Math.round(scale * 100)}%`);
  }
  function setOpacity(next: number) {
    const clamped = Math.round(Math.max(0.2, Math.min(1, next)) * 100) / 100;
    if (clamped === opacity) return;
    opacity = clamped;
    image.style.opacity = String(opacity);
    canvas.style.opacity = String(opacity);
    showHud(`透明度 ${Math.round(opacity * 100)}%`);
  }
  async function copyPin() {
    annotation?.commitText();
    const data = drawing?.strokes.length
      ? canvas.toDataURL("image/png")
      : edited;
    await call("copy_pin_image", { id, data });
    showHud("已复制");
  }

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
    { text: "复制图片", action: () => copyPin().catch(handleError) },
    { text: "恢复 100% 大小", action: () => setScale(1) },
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
  image.addEventListener("dblclick", (event) => {
    if (!drawing && event.button === 0) {
      event.preventDefault();
      close();
    }
  });
  root.addEventListener(
    "wheel",
    (event) => {
      if (drawing) return;
      event.preventDefault();
      const step = event.deltaY < 0 ? 0.1 : -0.1;
      if (event.ctrlKey || event.metaKey) setOpacity(opacity + step);
      else setScale(scale + step);
    },
    { passive: false },
  );
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
    else if (modified && key === "c") copyPin().catch(handleError);
    else if (modified && key === "s") saveAs().catch(handleError);
    else if (modified && key === "enter" && drawing)
      saveEdits().catch(handleError);
    else if (key === "escape") {
      if (drawing) cancelEdit();
      else close();
    } else if (!drawing && (key === "=" || key === "+")) setScale(scale + 0.1);
    else if (!drawing && key === "-") setScale(scale - 0.1);
    else if (!drawing && key === "0") setScale(1);
    else if (key === "contextmenu" || (event.shiftKey && key === "f10"))
      popup(Math.min(12, innerWidth / 2), Math.min(12, innerHeight / 2));
    else return;
    event.preventDefault();
  });
}
