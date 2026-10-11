#!/bin/sh
# Compiles basis.c to WebAssembly and embeds it in web/static/mapgen/noise.js
# (as BASIS_WASM, base64). Needs clang with the wasm32 target and wasm-ld.
set -e
here=$(cd "$(dirname "$0")" && pwd)
noise="$here/../../../web/static/mapgen/noise.js"
tmp=$(mktemp -d)
clang --target=wasm32 -O3 -msimd128 -mnontrapping-fptoint -ffp-contract=off -nostdlib \
  -Wl,--no-entry -Wl,--strip-all -o "$tmp/basis.wasm" "$here/basis.c"
b64=$(base64 -w0 "$tmp/basis.wasm")
sed -i "s|^  var BASIS_WASM = '.*';$|  var BASIS_WASM = '$b64';|" "$noise"
rm -rf "$tmp"
echo "embedded $(echo -n "$b64" | wc -c) bytes of base64 in $noise"
