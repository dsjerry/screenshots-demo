#!/bin/sh
# 构建 window-probe 探针：universal binary（arm64 + x86_64）+ ad-hoc 签名。
# 需要 Xcode CLT；产物 window-probe 提交进仓库，运行机器上不需要构建工具。
# 显式用 CLT 的 clang 而不是 xcrun/PATH 里的：xcode-select 指向完整版
# Xcode 时，未接受其许可会导致 clang 直接失败，而 CLT 工具链不受此限。
set -e
cd "$(dirname "$0")"
CLANG=/Library/Developer/CommandLineTools/usr/bin/clang
[ -x "$CLANG" ] || CLANG=clang
SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
[ -d "$SDK" ] || SDK="$(dirname "$CLANG")/../SDKs/MacOSX.sdk"
"$CLANG" -isysroot "$SDK" -arch arm64 -arch x86_64 -O2 -mmacosx-version-min=11.0 \
  -framework Foundation -framework AppKit -framework CoreGraphics \
  window-probe.m -o window-probe
codesign --force --sign - window-probe
echo "built: $(pwd)/window-probe"
# lipo 同样避开完整版 Xcode（未接受许可会被 xcode-select 派发挡住）
LIPO=/Library/Developer/CommandLineTools/usr/bin/lipo
[ -x "$LIPO" ] || LIPO=lipo
"$LIPO" -info window-probe
