import catIcon from "../src-tauri/icons/32x32.png";
import { convertFileSrc } from "@tauri-apps/api/core";
import { bind, call, escape, handleError, icon, native, on } from "./bridge";
export interface Clip {
  id: string;
  kind: "text" | "image";
  text: string | null;
  createdAt: number;
  width: number;
  height: number;
  bytes: number;
}
export interface ClipboardState {
  items: Clip[];
  root: string;
  paused: boolean;
  shortcut: string;
  notice?: string | null;
}
const root = document.querySelector<HTMLDivElement>("#app")!;
let state: ClipboardState,
  filter = "all",
  query = "",
  selected = 0,
  using = false;
const visible = () =>
  state.items.filter(
    (i) =>
      (filter === "all" || i.kind === filter) &&
      (!query ||
        (i.text || "图片").toLowerCase().includes(query.toLowerCase())),
  );
const src = (i: Clip & { data?: string }) =>
  i.data || convertFileSrc(`${state.root}/${i.id}-thumb.png`);
export async function clipboard() {
  document.documentElement.style.background = "transparent";
  document.body.className = "clipboard-body";
  root.innerHTML = `<section class="clipboard-shelf" aria-label="截图猫剪贴板"><header class="shelf-header"><div class="shelf-title"><img class="cat-mark" src="${catIcon}" alt="" width="25" height="25"/><strong>截图猫</strong><span>剪贴板</span></div><div class="shelf-filters" aria-label="内容类型"><button data-filter="all" aria-pressed="true">全部</button><button data-filter="text" aria-pressed="false">文字</button><button data-filter="image" aria-pressed="false">图片</button></div><label class="shelf-search">${icon("magnifying-glass")}<input aria-label="搜索剪贴板" placeholder="搜索记录" autocomplete="off"/></label><button class="icon-button" data-clear title="清空记录" aria-label="清空记录">${icon("eraser")}</button><button class="icon-button" data-settings title="偏好设置" aria-label="偏好设置">${icon("sliders-horizontal")}</button><button class="icon-button" data-close title="收起 Esc" aria-label="收起剪贴板">${icon("x")}</button></header><div class="shelf-list" role="listbox" aria-label="剪贴板内容" tabindex="0"></div><footer class="shelf-footer"><span id="shelf-status" role="status"></span><span class="shelf-key-hint">← → 选择 <kbd>Enter</kbd> 粘贴 <kbd>Esc</kbd> 收起</span></footer></section>`;
  const search = root.querySelector("input")!;
  search.addEventListener("input", () => {
    query = search.value;
    selected = 0;
    render();
  });
  bind(root, "[data-filter]", (e) => {
    filter = (e.currentTarget as HTMLElement).dataset.filter!;
    selected = 0;
    render();
  });
  bind(root, "[data-close]", hide);
  bind(root, "[data-settings]", () =>
    call("open_optional_panel", { route: "settings" }),
  );
  bind(root, "[data-clear]", confirmClear);
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      hide().catch(handleError);
      return;
    }
    if (e.target instanceof HTMLInputElement) return;
    const count = visible().length;
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      selected =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? count - 1
            : Math.max(
                0,
                Math.min(
                  count - 1,
                  selected + (e.key === "ArrowRight" ? 1 : -1),
                ),
              );
      render();
      root
        .querySelector<HTMLElement>(`[data-clip-index="${selected}"]`)
        ?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "smooth",
        });
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const clip = visible()[selected];
      if (clip) use(clip.id, true).catch(handleError);
    }
  });
  await on("clipboard-changed", () => load().catch(handleError));
  await on<boolean>("shelf-shown", (manual) => {
    query = "";
    search.value = "";
    filter = "all";
    selected = 0;
    load()
      .then(() => {
        if (manual) root.querySelector<HTMLElement>(".shelf-list")!.focus();
      })
      .catch(handleError);
  });
  await on<string>("clipboard-notice", (message) => {
    status(message);
  });
  await load();
  root.querySelector<HTMLElement>(".shelf-list")!.focus();
}
async function load() {
  state = await call<ClipboardState>("clipboard_items");
  selected = Math.min(selected, Math.max(0, visible().length - 1));
  render();
}
function status(message: string) {
  root.querySelector("#shelf-status")!.textContent = message;
}
function render() {
  const items = visible();
  root
    .querySelectorAll<HTMLElement>("[data-filter]")
    .forEach((el) =>
      el.setAttribute("aria-pressed", String(el.dataset.filter === filter)),
    );
  const list = root.querySelector<HTMLElement>(".shelf-list")!;
  const scroll = list.scrollLeft;
  list.innerHTML = items.length
    ? items
        .map(
          (item, i) =>
            `<article class="clip-card ${i === selected ? "selected" : ""}" role="option" aria-selected="${i === selected}" data-clip-index="${i}" aria-label="${escape(item.kind === "image" ? `图片 ${item.width}×${item.height}` : item.text?.slice(0, 100))}"><button class="clip-content" data-paste="${item.id}" aria-label="粘贴${item.kind === "image" ? "图片" : "文字"} ${i + 1}">${item.kind === "image" ? `<img src="${escape(src(item))}" alt="剪贴板图片" draggable="false" loading="lazy"/>` : `<span class="clip-text">${escape(item.text || "")}</span>`}</button><div class="clip-caption"><span>${item.kind === "image" ? `${item.width} × ${item.height}` : `${[...(item.text || "")].length} 字`}</span><span>${new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span><button class="clip-mini" data-copy="${item.id}" aria-label="仅复制 ${i + 1}" title="仅复制，不粘贴">复制</button>${item.kind === "image" ? `<button class="clip-mini" data-edit="${item.id}" aria-label="标注图片 ${i + 1}" title="标注图片">${icon("pencil-simple")}</button>` : ""}</div></article>`,
        )
        .join("")
    : `<div class="shelf-empty"><strong>${query ? "没有匹配的内容" : "复制一点什么吧"}</strong><span>${query ? "试试其他关键词" : "复制文字或图片后，会自动保存在这里。"}</span></div>`;
  list.scrollLeft = scroll;
  bind(list, "[data-paste]", (e) =>
    use((e.currentTarget as HTMLElement).dataset.paste!, true),
  );
  bind(list, "[data-copy]", (e) =>
    use((e.currentTarget as HTMLElement).dataset.copy!, false),
  );
  bind(list, "[data-edit]", (e) =>
    call("edit_clipboard", {
      id: (e.currentTarget as HTMLElement).dataset.edit,
    }),
  );
  status(
    state.notice ||
      (state.paused
        ? "已暂停记录 · 现有内容仍可粘贴"
        : `${state.items.length} 条 · 仅保存在本机 · ${state.shortcut} 呼出`),
  );
}
async function use(id: string, paste: boolean) {
  if (using) return;
  using = true;
  try {
    const result = await call<{ pasted: boolean; message: string }>(
      "use_clipboard",
      { id, paste },
    );
    if (!native && paste) status(result.message);
    else if (!paste) status(result.message);
  } finally {
    using = false;
  }
}
async function hide() {
  if (native) await call("hide_clipboard");
  else document.body.hidden = true;
}
function confirmClear() {
  const dialog = document.createElement("dialog");
  dialog.className = "clear-dialog";
  dialog.innerHTML =
    '<h2>清空剪贴板记录？</h2><p>删除本机保存的文字和图片记录，系统剪贴板中的当前内容会保留。</p><div><button class="button" data-cancel>取消</button><button class="button primary" data-confirm>清空记录</button></div>';
  document.body.append(dialog);
  dialog.showModal();
  bind(dialog, "[data-cancel]", () => dialog.close());
  bind(dialog, "[data-confirm]", async () => {
    await call("clear_clipboard_history");
    dialog.close();
    await load();
  });
  dialog.addEventListener("close", () => dialog.remove());
}
