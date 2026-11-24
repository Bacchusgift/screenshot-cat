import { Drawing } from "./drawing";
import { annotationTools, bindAnnotationTools } from "./annotations";
import { bind, call, handleError, icon, native, toast } from "./bridge";
import type { Entry } from "./types";
export async function editImage(data: string, onSaved: () => Promise<void>) {
  const image = new Image();
  image.src = data;
  await image.decode();
  const dialog = document.createElement("dialog");
  dialog.className = "editor-dialog";
  dialog.innerHTML = `<div class="dialog-header"><div><strong>编辑截图</strong><span>${image.width} × ${image.height} px</span></div><button class="icon-button" data-close aria-label="关闭编辑器">${icon("x")}</button></div><div class="editor-tools" role="toolbar" aria-label="标注工具">${annotationTools}<label class="stroke-label">粗细 <input aria-label="画笔粗细" type="range" min="2" max="18" value="4"/></label><button class="tool" data-clear title="清空标注" aria-label="清空标注">${icon("eraser")}</button></div><div class="editor-stage"><canvas aria-label="可绘制的截图"></canvas></div><div class="dialog-footer"><span>选择工具，在图片上标注</span><div><button class="button" data-close>取消</button><button class="button primary" data-save>${icon("check")} 保存截图</button></div></div>`;
  document.body.append(dialog);
  const canvas = dialog.querySelector("canvas")!;
  const drawing = new Drawing(canvas, image.width, image.height);
  drawing.background = image;
  drawing.render();
  const annotation = bindAnnotationTools(dialog, drawing);
  dialog.showModal();
  dialog.addEventListener("close", () => {
    annotation.destroy();
    drawing.destroy();
    dialog.remove();
  });
  bind(dialog, "[data-close]", () => dialog.close());
  dialog
    .querySelector("input")!
    .addEventListener(
      "input",
      (e) => (drawing.width = +(e.target as HTMLInputElement).value),
    );
  bind(dialog, "[data-clear]", () => {
    annotation.commitText();
    drawing.clear();
  });
  bind(dialog, "[data-save]", async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    annotation.commitText();
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
