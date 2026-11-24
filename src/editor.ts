import { Drawing, type Tool } from "./drawing";
import { bind, call, handleError, icon, native, toast } from "./bridge";
import type { Entry } from "./types";
export async function editImage(data: string, onSaved: () => Promise<void>) {
  const image = new Image();
  image.src = data;
  await image.decode();
  const dialog = document.createElement("dialog");
  dialog.className = "editor-dialog";
  dialog.innerHTML = `<div class="dialog-header"><div><strong>编辑截图</strong><span>${image.width} × ${image.height} px</span></div><button class="icon-button" data-close aria-label="关闭编辑器">${icon("x")}</button></div><div class="editor-tools" role="toolbar" aria-label="标注工具">${[
    ["pen", "pencil-simple", "画笔"],
    ["arrow", "arrow-up-right", "箭头"],
    ["rectangle", "rectangle", "矩形"],
  ]
    .map(
      ([tool, i, name]) =>
        `<button class="tool ${tool === "pen" ? "selected" : ""}" data-tool="${tool}" aria-label="${name}" title="${name}" aria-pressed="${tool === "pen"}">${icon(i)}</button>`,
    )
    .join(
      "",
    )}<span class="divider"></span>${["#e5484d", "#117c66", "#265ec2", "#e2a129"].map((color, i) => `<button class="swatch ${i === 0 ? "selected" : ""}" style="--swatch:${color}" data-color="${color}" aria-label="${["红色", "绿色", "蓝色", "黄色"][i]}"></button>`).join("")}<label class="stroke-label">粗细 <input aria-label="画笔粗细" type="range" min="2" max="18" value="4"/></label><button class="tool" data-undo title="撤销" aria-label="撤销">${icon("arrow-counter-clockwise")}</button><button class="tool" data-clear title="清空标注" aria-label="清空标注">${icon("eraser")}</button></div><div class="editor-stage"><canvas aria-label="可绘制的截图"></canvas></div><div class="dialog-footer"><span>拖动画笔，直接在图片上标注</span><div><button class="button" data-close>取消</button><button class="button primary" data-save>${icon("check")} 保存截图</button></div></div>`;
  document.body.append(dialog);
  const canvas = dialog.querySelector("canvas")!;
  const drawing = new Drawing(canvas, image.width, image.height);
  drawing.background = image;
  drawing.render();
  dialog.showModal();
  dialog.addEventListener("close", () => {
    drawing.destroy();
    dialog.remove();
  });
  bind(dialog, "[data-close]", () => dialog.close());
  bind(dialog, "[data-tool]", (e) => {
    const el = e.currentTarget as HTMLElement;
    drawing.tool = el.dataset.tool as Tool;
    dialog.querySelectorAll("[data-tool]").forEach((b) => {
      b.classList.toggle("selected", b === el);
      b.setAttribute("aria-pressed", String(b === el));
    });
  });
  bind(dialog, "[data-color]", (e) => {
    drawing.color = (e.currentTarget as HTMLElement).dataset.color!;
    dialog
      .querySelectorAll("[data-color]")
      .forEach((b) => b.classList.toggle("selected", b === e.currentTarget));
  });
  dialog
    .querySelector("input")!
    .addEventListener(
      "input",
      (e) => (drawing.width = +(e.target as HTMLInputElement).value),
    );
  bind(dialog, "[data-undo]", () => drawing.undo());
  bind(dialog, "[data-clear]", () => drawing.clear());
  bind(dialog, "[data-save]", async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "正在保存…";
    try {
      await call<Entry>("save_image", { data: canvas.toDataURL("image/png") });
      await onSaved();
      dialog.close();
      toast("截图已保存到历史记录");
    } finally {
      button.disabled = false;
      button.innerHTML = `${icon("check")} 保存截图`;
    }
  });
}
export async function importImage(onSaved: () => Promise<void>) {
  if (native) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof path === "string")
      await editImage(await call<string>("import_image", { path }), onSaved);
  } else {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 30 * 1024 * 1024) {
        toast("请选择 30 MB 以内的图片", true);
        return;
      }
      const reader = new FileReader();
      reader.onload = () =>
        editImage(String(reader.result), onSaved).catch(handleError);
      reader.readAsDataURL(file);
    };
    input.click();
  }
}
