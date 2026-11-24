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
  await page.getByLabel("视频帧率", { exact: true }).selectOption("60");
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.reload();
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await expect(page.getByLabel("视频帧率", { exact: true })).toHaveValue("60");
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
  await page.screenshot({path:"artifacts/shelf-content.png"});
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
