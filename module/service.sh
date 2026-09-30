#!/system/bin/sh
# Load the module if post-fs-data did not, then start sync-tool: it watches HMA's config,
# evaluates it and pushes the resulting policy over netlink, forever.
MODDIR=${0%/*}
KO="$MODDIR/ko/hma_uidfake.ko"
LOG="$MODDIR/state/sync.log"
mkdir -p "$MODDIR/state"

if [ -f "$KO" ] && [ -x "$MODDIR/lkmloader" ] && ! lsmod | grep -q '^hma_uidfake '; then
  "$MODDIR/lkmloader" "$KO" >>"$LOG" 2>&1
  echo "[load] lkmloader rc=$? $(date '+%m-%d %H:%M:%S')" >>"$LOG"
fi

# The module's own rules live here, outside modules/ so an update does not carry them away. The
# WebUI writes this file; its directory is what sync-tool's watcher binds to, so give it one from
# boot even before a config exists.
mkdir -p /data/adb/hma-uidfake
[ -x "$MODDIR/sync-tool" ] && "$MODDIR/sync-tool" >>"$LOG" 2>&1 &
