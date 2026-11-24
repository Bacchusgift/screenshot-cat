import { icon } from "./bridge";
import type { Drawing, Tool } from "./drawing";

const tools = [
  ["pen", "pencil-simple", "画笔", "B"],
  ["arrow", "arrow-up-right", "箭头", "A"],
  ["rectangle", "rectangle", "矩形", "R"],
  ["text", "", "文字", "T"],
  ["number", "", "连续编号", "N"],
] as const;
const colors = [
  ["#e5484d", "红色"],
  ["#117c66", "绿色"],
  ["#265ec2", "蓝色"],
  ["#a45900", "橙色"],
];
export const annotationTools = `<div class="annotation-tools" role="group" aria-label="截图标注工具">${tools.map(([tool, i, name, key]) => `<button type="button" class="tool" data-mark="${tool}" aria-label="${name}" aria-keyshortcuts="${key}" title="${name} (${key})">${i ? icon(i) : tool === "text" ? "T" : "①"}</button>`).join("")}<span class="divider"></span>${colors.map(([color, name]) => `<button type="button" class="swatch" data-ink="${color}" aria-label="${name}" title="${name}" style="--swatch:${color}"></button>`).join("")}<span class="divider"></span><button type="button" class="tool" data-mark-undo aria-label="撤销标注" title="撤销 (⌘/Ctrl+Z)">${icon("arrow-counter-clockwise")}</button></div>`;

export function bindAnnotationTools(toolbar: HTMLElement, drawing: Drawing) {
  const abort = new AbortController();
  const options = { signal: abort.signal };
  const toolButtons =
    toolbar.querySelectorAll<HTMLButtonElement>("[data-mark]");
  const colorButtons =
    toolbar.querySelectorAll<HTMLButtonElement>("[data-ink]");
  let pending:
    { input: HTMLInputElement; commit: (text: string) => void } | undefined;
  function closeText(save: boolean) {
    const item = pending;
    pending = undefined;
    item?.input.remove();
    if (item && save) item.commit(item.input.value);
  }
  function choose(tool: Tool) {
    closeText(true);
    drawing.tool = tool;
    for (const button of toolButtons) {
      const selected = button.dataset.mark === tool;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }
  function ink(color: string) {
    closeText(true);
    drawing.color = color;
    for (const button of colorButtons) {
      const selected = button.dataset.ink === color;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }
  for (const button of toolButtons)
    button.addEventListener(
      "click",
      () => choose(button.dataset.mark as Tool),
      options,
    );
  for (const button of colorButtons)
    button.addEventListener("click", () => ink(button.dataset.ink!), options);
  const undo = () => {
    closeText(true);
    drawing.undo();
  };
  toolbar
    .querySelector("[data-mark-undo]")
    ?.addEventListener("click", undo, options);
  const keys = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.target instanceof HTMLInputElement ||
      event.altKey ||
      event.shiftKey
    )
      return;
    const key = event.key.toUpperCase();
    if ((event.metaKey || event.ctrlKey) && key === "Z") {
      event.preventDefault();
      undo();
    } else if (!event.metaKey && !event.ctrlKey) {
      const tool = tools.find((item) => item[3] === key)?.[0];
      if (tool) {
        event.preventDefault();
        choose(tool);
      }
    }
  };
  document.addEventListener("keydown", keys, options);
  drawing.requestText = (point, commit) => {
    closeText(true);
    const input = document.createElement("input");
    input.className = "capture-text-input";
    input.type = "text";
    input.maxLength = 200;
    input.placeholder = "输入文字，回车确认";
    input.setAttribute("aria-label", "标注文字");
    const bounds = drawing.canvas.getBoundingClientRect();
    input.style.left = `${Math.max(8, Math.min(innerWidth - 238, bounds.left + (point.x * bounds.width) / drawing.canvas.width))}px`;
    input.style.top = `${Math.max(8, Math.min(innerHeight - 44, bounds.top + (point.y * bounds.height) / drawing.canvas.height))}px`;
    pending = { input, commit };
    input.addEventListener(
      "pointerdown",
      (event) => event.stopPropagation(),
      options,
    );
    input.addEventListener("blur", () => closeText(true), options);
    input.addEventListener(
      "keydown",
      (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeText(event.key === "Enter");
        }
      },
      options,
    );
    (toolbar.closest("dialog") ?? document.body).append(input);
    input.focus();
  };
  choose("pen");
  ink(drawing.color);
  return {
    selectTool: choose,
    commitText: () => closeText(true),
    destroy: () => {
      abort.abort();
      closeText(false);
    },
  };
}
