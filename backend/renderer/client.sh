#!/bin/sh
# design-render client — what TASKFLOW_DESIGN_RENDERER points at inside the
# backend image. Same argument contract as design-render.mjs
# (see plugins/taskflow-design/src/screenshots.rs), but instead of launching
# Chromium here, next to the backend's secrets, it asks the `renderer`
# sidecar (./server.mjs) for the PNG.
#
# Like design-render.mjs, it leaves `<out>.json` = {"warnings": [...], "data": …}
# beside the PNG, decoded from the sidecar's X-Render-Warnings/-Data headers.
#
# The backend reports the LAST stderr line as the failure reason, so every
# failure path ends with one plain sentence.
set -u

url= width= height= dpr= timeout_ms=20000 out= mobile=0 full_page=0 frame=none device= theme=light max_px=0
while [ $# -ge 2 ]; do
  case "$1" in
    --url) url=$2 ;;
    --width) width=$2 ;;
    --height) height=$2 ;;
    --dpr) dpr=$2 ;;
    --timeout-ms) timeout_ms=$2 ;;
    --out) out=$2 ;;
    --mobile) mobile=$2 ;;
    --full-page) full_page=$2 ;;
    --frame) frame=$2 ;;
    --device) device=$2 ;;
    --theme) theme=$2 ;;
    --max-px) max_px=$2 ;;
  esac
  shift 2
done
[ -n "$url" ] && [ -n "$out" ] || { echo "usage: $0 --url U --width W --height H --dpr D --timeout-ms T --out PNG" >&2; exit 2; }

# The backend kills us at timeout + 2s; stay under that so a slow shot fails
# with the sidecar's reason instead of a bare timeout.
max_secs=$(( timeout_ms / 1000 + 1 ))
headers="$out.headers"

code=$(curl -sS --max-time "$max_secs" -o "$out" -D "$headers" -w '%{http_code}' \
  --data-urlencode "url=$url" \
  --data-urlencode "width=$width" \
  --data-urlencode "height=$height" \
  --data-urlencode "dpr=$dpr" \
  --data-urlencode "timeout_ms=$timeout_ms" \
  --data-urlencode "mobile=$mobile" \
  --data-urlencode "full_page=$full_page" \
  --data-urlencode "frame=$frame" \
  --data-urlencode "device=$device" \
  --data-urlencode "theme=$theme" \
  --data-urlencode "max_px=$max_px" \
  "${DESIGN_RENDERER_URL:-http://renderer:3000}/render") || {
  rm -f "$out" "$headers"
  echo "screenshot sidecar unreachable at ${DESIGN_RENDERER_URL:-http://renderer:3000}" >&2
  exit 1
}

if [ "$code" != 200 ]; then
  reason=$(head -c 300 "$out" 2>/dev/null | tr '\n' ' ')
  rm -f "$out" "$headers"
  echo "screenshot sidecar HTTP $code: ${reason:-no reason given}" >&2
  exit 1
fi

warnings=$(sed -n 's/^[Xx]-[Rr]ender-[Ww]arnings: *//p' "$headers" | tr -d '\r' | base64 -d 2>/dev/null)
data=$(sed -n 's/^[Xx]-[Rr]ender-[Dd]ata: *//p' "$headers" | tr -d '\r' | base64 -d 2>/dev/null)
rm -f "$headers"
printf '{"warnings":%s,"data":%s}' "${warnings:-[]}" "${data:-null}" > "$out.json"
