# Third-party notices

## FFmpeg 8.0

Copyright (c) the FFmpeg developers. https://ffmpeg.org/

The default build bundles an unmodified FFmpeg 8.0 executable under the GNU Lesser General Public License, version 2.1 or later. It is a separate executable, invoked by Rust; it is not linked into the application. GPL and nonfree components are disabled.

- Full license: bundled `binaries/licenses/FFmpeg-LGPL-2.1.txt`.
- Exact original source: https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz
- Reproduction: run `sh scripts/build-ffmpeg.sh`; compiler flags and enabled components are recorded in `binaries/BUILD-INFO.txt`.
- No FFmpeg source modifications are made. Users may replace the bundled executable with a compatible build. When distributing, keep the source archive available beside the application downloads, with this notice, license and build instructions.

A custom FFMPEG_PATH build can have different licensing requirements. Its distributor must supply its own matching licenses and corresponding source material rather than use the default build's metadata.

## Other components

Tauri: MIT / Apache-2.0. https://github.com/tauri-apps/tauri

xcap: MIT. https://github.com/nashaofu/xcap

Phosphor Icons: MIT. https://github.com/phosphor-icons/web

Arboard: MIT / Apache-2.0. https://github.com/1Password/arboard

SHA-2 (RustCrypto): MIT / Apache-2.0. https://github.com/RustCrypto/hashes

Pixel cat artwork was generated for Screenshot Cat and is distributed under this project’s MIT license.
