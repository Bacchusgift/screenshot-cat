import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Entry, Init } from "./types";
export const native = isTauri();
const db = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("capture-king", 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore("captures", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
async function store<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("captures", mode);
    const r = fn(tx.objectStore("captures"));
    tx.oncomplete = () => {
      d.close();
      resolve(r.result);
    };
    tx.onerror = () => {
      d.close();
      reject(tx.error);
    };
  });
}
export async function call<T = void>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (native) return invoke<T>(command, args);
  if (
    [
      "clipboard_items",
      "save_clipboard_text",
      "clear_clipboard_history",
      "use_clipboard",
      "clipboard_image_data",
    ].includes(command)
  )
    return (await import("./preview-clipboard")).command(
      command,
      args,
    ) as Promise<T>;
  if (command === "init")
    return {
      entries: (await store("readonly", (s) => s.getAll())).sort(
        (a: Entry, b: Entry) => b.createdAt - a.createdAt,
      ),
      settings: JSON.parse(
        localStorage.getItem("settings") ||
          '{"fps":30,"countdown":3,"encoder":"auto"}',
      ),
      library: "浏览器本地存储",
      platform: "preview",
      screenPermission: true,
      shortcuts: [],
      ffmpeg: false,
      pins: [],
    } as T;
  if (command === "save_image") {
    const data = args.data as string;
    const image = new Image();
    image.src = data;
    await image.decode();
    const e: Entry = {
      id: crypto.randomUUID(),
      kind: "image",
      name: `截图_${Date.now()}.png`,
      createdAt: Date.now(),
      width: image.width,
      height: image.height,
      duration: 0,
      data,
    };
    await store("readwrite", (s) => s.put(e));
    await (await import("./preview-clipboard")).addImage(data);
    return e as T;
  }
  if (command === "save_settings") {
    localStorage.setItem("settings", JSON.stringify(args.settings));
    return undefined as T;
  }
  throw new Error(
    "此功能需要桌面版。请在项目目录运行 pnpm dev；网页预览可导入图片、标注和保存。",
  );
}
export const mediaUrl = (entry: Entry, init: Init) =>
  entry.data || convertFileSrc(`${init.library}/${entry.name}`);
export async function on<T>(event: string, handler: (data: T) => void) {
  if (native) return listen<T>(event, (e) => handler(e.payload));
  return () => {};
}
export function escape(text: unknown) {
  return String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export const icon = (name: string, cls = "") =>
  `<i class="ph ph-${name} ${cls}" aria-hidden="true"></i>`;
export function toast(message: string, error = false) {
  let host = document.querySelector<HTMLElement>("#toast");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast";
    host.setAttribute("role", "status");
    document.body.append(host);
  }
  host.className = error ? "toast error" : "toast";
  host.textContent = message;
  host.hidden = false;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    host!.hidden = true;
  }, 6000);
}
let timer = 0;
export const handleError = (error: unknown) =>
  toast(error instanceof Error ? error.message : String(error), true);
export function bind(
  root: ParentNode,
  selector: string,
  handler: (e: Event) => unknown,
) {
  root.querySelectorAll(selector).forEach((el) =>
    el.addEventListener("click", (e) => {
      try {
        Promise.resolve(handler(e)).catch(handleError);
      } catch (error) {
        handleError(error);
      }
    }),
  );
}
