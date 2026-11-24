// Browser preview only. Native monitoring, focus restoration and paste live in Rust.
import type { Clip } from "./clipboard";
type PreviewClip = Clip & { data?: string };
const database = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("screenshot-cat-clipboard", 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore("clips", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction("clips", mode),
      request = operation(tx.objectStore("clips"));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
export const items = async () =>
  ((await transaction("readonly", (s) => s.getAll())) as PreviewClip[]).sort(
    (a, b) => b.createdAt - a.createdAt,
  );
export async function addText(text: string) {
  const existing = (await items()).find(
    (i) => i.kind === "text" && i.text === text,
  );
  const clip: PreviewClip = {
    id: existing?.id || `preview-${crypto.randomUUID()}`,
    kind: "text",
    text,
    createdAt: Date.now(),
    width: 0,
    height: 0,
    bytes: new Blob([text]).size,
  };
  await transaction("readwrite", (s) => s.put(clip));
  await trim();
  return clip;
}
export async function addImage(data: string) {
  const image = new Image();
  image.src = data;
  await image.decode();
  const clip: PreviewClip = {
    id: `preview-${crypto.randomUUID()}`,
    kind: "image",
    text: null,
    createdAt: Date.now(),
    width: image.width,
    height: image.height,
    bytes: data.length,
    data,
  };
  await transaction("readwrite", (s) => s.put(clip));
  await trim();
  return clip;
}
async function trim() {
  for (const clip of (await items()).slice(100))
    await transaction("readwrite", (s) => s.delete(clip.id));
}
export async function command(name: string, args: Record<string, unknown>) {
  if (name === "clipboard_items")
    return {
      items: await items(),
      root: "",
      paused: false,
      shortcut: "⌘ Control V · 网页预览",
    };
  if (name === "save_clipboard_text") return addText(String(args.text));
  if (name === "clear_clipboard_history") {
    await transaction("readwrite", (s) => s.clear());
    return;
  }
  if (name === "use_clipboard") {
    const clip = (await items()).find((i) => i.id === args.id);
    if (!clip) throw new Error("记录不存在");
    if (clip.kind === "text") await navigator.clipboard.writeText(clip.text!);
    else
      await navigator.clipboard.write([
        new ClipboardItem({
          "image/png": await (await fetch(clip.data!)).blob(),
        }),
      ]);
    return { pasted: false, message: "已复制；网页预览请切换窗口后手动粘贴" };
  }
  if (name === "clipboard_image_data") {
    const clip = (await items()).find((i) => i.id === args.id);
    if (!clip?.data) throw new Error("图片不存在");
    return clip.data;
  }
  throw new Error("此功能需要桌面版");
}
