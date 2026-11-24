import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test("辅助窗口按需使用：导入、标注、持久保存与设置", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173");
  await expect(
    page.getByRole("heading", { name: "截图猫", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入图片" }).click();
  await (await chooser).setFiles("src-tauri/icons/128x128.png");
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  const before = await canvas.evaluate((c) =>
    (c as HTMLCanvasElement).toDataURL(),
  );
  const r = await canvas.boundingBox();
  await page.mouse.move(r!.x + 15, r!.y + 15);
  await page.mouse.down();
  await page.mouse.move(r!.x + 75, r!.y + 75);
  await page.mouse.up();
  expect(
    await canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL()),
  ).not.toBe(before);
  await page.getByRole("button", { name: "保存截图" }).click();
  await expect(page.locator(".history-item")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".history-item")).toHaveCount(1);
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  const frameRate = page.locator("#fps summary");
  await frameRate.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("radio", { name: "30 FPS" })).toBeChecked();
  await page.getByRole("radio", { name: "60 FPS" }).click();
  await expect(frameRate).toBeFocused();
  await expect(page.getByRole("radio", { name: "60 FPS" })).toBeHidden();
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.reload();
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await expect(frameRate).toHaveText("60 FPS");
});
test("剪贴板文字图片去重、筛选、搜索、键盘选择和清空确认", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173");
  const image = `data:image/png;base64,${readFileSync("src-tauri/icons/128x128.png").toString("base64")}`;
  await page.evaluate(async (image) => {
    const b = await import("/src/bridge.ts");
    await b.call("save_clipboard_text", { text: "第一条文字" });
    await b.call("save_clipboard_text", { text: "第二条备忘录" });
    await b.call("save_clipboard_text", { text: "第一条文字" });
    await b.call("save_image", { data: image });
  }, image);
  await page.goto("http://127.0.0.1:5173/?view=clipboard");
  await expect(page.locator(".clip-card")).toHaveCount(3);
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".clip-card").nth(1)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await expect(page.locator(".clip-card")).toHaveCount(2);
  await page.getByRole("textbox", { name: "搜索剪贴板" }).fill("备忘录");
  await expect(page.locator(".clip-card")).toHaveCount(1);
  await page.getByRole("textbox", { name: "搜索剪贴板" }).fill("");
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await expect(page.locator(".clip-card")).toHaveCount(1);
  await expect(page.getByRole("img", { name: "剪贴板图片" })).toBeVisible();
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.screenshot({ path: "artifacts/shelf-content.png" });
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await page.getByRole("button", { name: "清空记录", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".clip-card")).toHaveCount(1);
  await page.getByRole("button", { name: "清空记录", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "清空记录" })
    .click();
  await expect(page.locator(".clip-card")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("复制一点什么吧")).toBeVisible();
});
for (const width of [1120, 768, 375])
  test(`底部栏 ${width}px 不溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 270 });
    await page.goto("http://127.0.0.1:5173/?view=clipboard");
    await expect(
      page.getByRole("region", { name: "截图猫剪贴板" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await page.screenshot({ path: `artifacts/shelf-${width}.png` });
  });

const pinFixture = `data:image/png;base64,${readFileSync("src-tauri/icons/128x128.png").toString("base64")}`;

test("松开截图选区立即提交，不出现额外按钮", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.addInitScript((image) => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (name: string, args: unknown) => {
          if (name === "overlay_data")
            return {
              mode: "image",
              image,
              width: 1600,
              height: 1200,
              scale: 2,
            };
          if (name === "select_region")
            Object.assign(window, { captureSubmission: args });
        },
      },
    });
  }, pinFixture);
  await page.goto("http://127.0.0.1:5173/?view=overlay");
  await expect(page.getByText("拖动选择截图区域")).toBeVisible();
  await page.mouse.move(110, 150);
  await page.mouse.down();
  await page.mouse.move(520, 380, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { captureSubmission?: unknown })
            .captureSubmission,
      ),
    )
    .toEqual({
      rect: { x: 220, y: 300, width: 820, height: 460 },
    });
  await expect(page.getByRole("button")).toHaveCount(0);
});

test("贴图悬停显示工具栏；直接编辑、保存、另存和关闭", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 260 });
  await page.addInitScript((data) => {
    type Item = { text: string; handler: { id: number } };
    const callbacks: ((message: unknown) => void)[] = [];
    let nextResource = 0;
    let exportConfirmed = false;
    Object.assign(window, {
      confirmNextExport: () => {
        exportConfirmed = true;
      },
    });
    const messageIndices = new Map<number, number>();
    const menuItems = new Map<number, Item[]>();
    const nativeLog = {
      actions: [] as string[],
      exportArgs: undefined as unknown,
      savedEdit: undefined as unknown,
    };
    Object.assign(window, {
      isTauri: true,
      nativeLog,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "pin-sample" } },
        transformCallback: (cb: (message: unknown) => void) =>
          callbacks.push(cb) - 1,
        invoke: async (
          name: string,
          args: { options: { items: Item[] }; rid: number },
        ) => {
          if (name === "pin_data") return { data, width: 128, height: 128 };
          if (name === "plugin:menu|new") {
            menuItems.set(++nextResource, args.options.items);
            return [nextResource, String(nextResource)];
          }
          if (name === "plugin:menu|popup") {
            document.querySelector("#native-menu")?.remove();
            const menu = document.createElement("div");
            menu.id = "native-menu";
            menu.style.cssText =
              "position:fixed;inset:30px auto auto 30px;background:white;z-index:100";
            for (const { text, handler } of menuItems.get(args.rid)!) {
              const item = document.createElement("button");
              item.textContent = text;
              item.onclick = () => {
                menu.remove();
                const index = messageIndices.get(handler.id) ?? 0;
                messageIndices.set(handler.id, index + 1);
                callbacks[handler.id]({ index, message: null });
              };
              menu.append(item);
            }
            document.body.append(menu);
          }
          if (name === "save_pin_edit") nativeLog.savedEdit = args;
          if (name === "save_pin_as") {
            nativeLog.exportArgs = args;
            return exportConfirmed;
          }
          nativeLog.actions.push(name);
        },
      },
    });
  }, pinFixture);
  await page.goto("http://127.0.0.1:5173/?view=pin&id=sample");
  // Leave room to move the pointer off the pin regardless of the initial cursor position.
  await page.addStyleTag({ content: ".pin-body #app { width: 320px; height: 240px; }" });
  await page.mouse.move(350, 250);
  const image = page.getByRole("img", { name: "桌面置顶截图" });
  await expect(image).toBeVisible();
  expect(await image.boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 320,
    height: 240,
  });
  await expect(page.getByRole("button")).toHaveCount(0);
  await image.hover();
  const toolbar = page.getByRole("toolbar", { name: "贴图工具栏" });
  await expect(toolbar).toBeVisible();
  await expect(
    toolbar.getByRole("button", { name: "箭头", exact: true }),
  ).toBeVisible();
  await toolbar.getByRole("button", { name: "连续编号" }).click();
  const canvas = page.getByLabel("贴图标注画布");
  const pixels = () => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await expect(canvas).toBeVisible();
  expect(
    await canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height]),
  ).toEqual([128, 128]);
  const original = await pixels();
  await canvas.click({ position: { x: 50, y: 115 } });
  const first = await pixels();
  expect(first).not.toBe(original);
  await canvas.click({ position: { x: 180, y: 115 } });
  expect(await pixels()).not.toBe(first);
  await page.getByRole("button", { name: "撤销标注" }).click();
  expect(await pixels()).toBe(first);
  await toolbar.getByRole("button", { name: "文字", exact: true }).click();
  await canvas.click({ position: { x: 70, y: 140 } });
  await page.getByRole("textbox", { name: "标注文字" }).fill("这里有说明");
  await page.keyboard.press("Enter");
  const withText = await pixels();
  expect(withText).not.toBe(first);
  await page.getByRole("button", { name: "箭头", exact: true }).click();
  await page.mouse.move(115, 165);
  await page.mouse.down();
  await page.mouse.move(250, 190, { steps: 6 });
  await page.mouse.up();
  const annotated = await pixels();
  expect(annotated).not.toBe(withText);
  await toolbar.getByRole("button", { name: "保存", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { nativeLog?: { savedEdit: unknown } }).nativeLog
          ?.savedEdit,
    ),
  ).toEqual({ id: "sample", data: annotated });
  await expect(image).toHaveAttribute("src", annotated);
  await expect(page.getByRole("button")).toHaveCount(0);
  await image.click({ button: "right" });
  await page.getByRole("button", { name: "另存为…" }).click();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { nativeLog?: { exportArgs: unknown } }).nativeLog
          ?.exportArgs,
    ),
  ).toEqual({ id: "sample", data: annotated });
  await expect(image).toBeVisible();
  const closeCount = () =>
    page.evaluate(
      () =>
        (
          window as Window & { nativeLog?: { actions: string[] } }
        ).nativeLog?.actions.filter((cmd) => cmd === "plugin:window|close")
          .length,
    );
  expect(await closeCount()).toBe(0);
  await page.evaluate(() =>
    (
      window as Window & { confirmNextExport?: () => void }
    ).confirmNextExport?.(),
  );
  await image.click({ button: "right" });
  await page.getByRole("button", { name: "另存为…" }).click();
  await expect.poll(closeCount).toBe(1);
  await image.click({ button: "right" });
  await page.getByRole("button", { name: "关闭贴图" }).click();
  await expect.poll(closeCount).toBe(2);
});
