// Build-time only. The installed app never uses Node or downloads an encoder.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  copyFileSync,
  chmodSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
const triple = execFileSync("rustc", ["--print", "host-tuple"], {
  encoding: "utf8",
}).trim();
const ext = process.platform === "win32" ? ".exe" : "";
const target = path.resolve(`src-tauri/binaries/ffmpeg-${triple}${ext}`);
mkdirSync(path.dirname(target), { recursive: true });
let source = process.env.FFMPEG_PATH;
if (!source) {
  if (process.platform === "win32")
    throw new Error(
      "在 MSYS2 中运行 scripts/build-ffmpeg.sh，再用 FFMPEG_PATH 指向生成的 ffmpeg.exe。",
    );
  const result = spawnSync("sh", ["scripts/build-ffmpeg.sh"], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  source = path.resolve("artifacts/ffmpeg-build/ffmpeg");
}
if (!existsSync(source)) throw new Error(`FFmpeg 不存在：${source}`);
const version = execFileSync(source, ["-version"], { encoding: "utf8" });
if (process.platform === "darwin") {
  const linked = execFileSync("otool", ["-L", source], { encoding: "utf8" });
  const lines = linked.split("\n").slice(1).filter(Boolean);
  if (lines.some((line) => !/^\s*\/(usr\/lib|System\/Library)\//.test(line)))
    throw new Error(
      "此 FFmpeg 依赖外部 dylib，无法独立分发。请使用默认源码裁剪构建。",
    );
}
const devices = execFileSync(source, ["-hide_banner", "-devices"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const requiredDevice =
  process.platform === "darwin"
    ? "avfoundation"
    : process.platform === "win32"
      ? "gdigrab"
      : "x11grab";
if (!devices.includes(requiredDevice))
  throw new Error(
    `FFmpeg 缺少屏幕采集模块 ${requiredDevice}，不能用于此安装包。`,
  );
copyFileSync(source, target);
if (process.platform !== "win32") chmodSync(target, 0o755);
writeFileSync(
  "src-tauri/binaries/BUILD-INFO.txt",
  `${version}\nSource: https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz\nBuild: scripts/build-ffmpeg.sh\nNo source modifications.\n`,
);
console.log(`内置 FFmpeg 已就绪：${target}`);
