#!/bin/sh
set -eu
base_dir="$(pwd)/artifacts/ffmpeg-build"
mkdir -p "$base_dir"
cd "$base_dir"
if [ ! -f ffmpeg-8.0.tar.xz ]; then curl --fail --location --retry 3 https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz -o ffmpeg-8.0.tar.xz; fi
if [ ! -d ffmpeg-8.0 ]; then tar xf ffmpeg-8.0.tar.xz; fi
cd ffmpeg-8.0
# LGPL-only, no x264/x265, no network, no playback tools, no audio subsystem.
# Native H.264 hardware encoders + portable MPEG-4 fallback.
case "$(uname -s)" in
 Darwin) platform_flags="--enable-avfoundation --enable-videotoolbox" ;;
 Linux) platform_flags="--enable-libxcb --enable-libxcb-shm --enable-libxcb-xfixes" ;;
 *) platform_flags="--enable-mediafoundation --enable-d3d11va --target-os=mingw32 --arch=x86_64 --extra-ldflags=-static" ;;
esac
./configure $platform_flags --disable-everything --disable-autodetect --disable-doc --disable-debug \
 --disable-network --disable-ffplay --disable-ffprobe --disable-shared --enable-static \
 --enable-ffmpeg --enable-avdevice --enable-swscale --enable-avfilter \
 --enable-protocol=file,pipe --enable-indev=avfoundation,gdigrab,x11grab \
 --enable-demuxer=mov,rawvideo --enable-muxer=mp4,gif \
 --enable-decoder=h264,mpeg4,rawvideo --enable-parser=h264,mpeg4video \
 --enable-encoder=mpeg4,gif,h264_videotoolbox,h264_mf \
 --enable-filter=crop,pad,fps,scale,split,palettegen,paletteuse,format,null \
 --extra-cflags=-Os \
 --enable-small
make -j "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
if [ -f ffmpeg.exe ]; then cp ffmpeg.exe ../ffmpeg.exe; else cp ffmpeg ../ffmpeg; fi
cd ../../..
mkdir -p src-tauri/binaries/licenses
cp artifacts/ffmpeg-build/ffmpeg-8.0/COPYING.LGPLv2.1 src-tauri/binaries/licenses/FFmpeg-LGPL-2.1.txt
