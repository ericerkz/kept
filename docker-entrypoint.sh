#!/bin/sh
# Kept container entrypoint.
#
# Goals (in priority order):
#   1. The app must be able to write to /app/data, no matter how the bind
#      mount got created on the host.
#   2. Files written into /app/data should be owned by the host user that
#      ran `docker compose up`, so backups/inspection work without sudo.
#   3. The Node process should never run as root.
#
# How it works:
#   - The image starts as root (so we can chown).
#   - We figure out the desired UID/GID:
#       a) If PUID/PGID env vars are set explicitly, use them.
#       b) Otherwise, if /app/data exists and has a non-root owner already
#          (user pre-created it on the host), inherit that ownership so
#          host files stay owned by whoever made the directory.
#       c) Otherwise fall back to 1000:1000 (the default "node" user).
#   - chown /app/data recursively (cheap unless it's a huge dataset).
#   - Re-exec the original CMD as that UID via su-exec.
#
# Skip ownership fixing entirely with KEPT_SKIP_CHOWN=1 (e.g. on a giant
# data dir where you've already gotten the ownership right and the recursive
# chown is slow).

set -e

DATA_DIR=/app/data

# Decide target UID/GID.
TARGET_UID="${PUID:-}"
TARGET_GID="${PGID:-}"

if [ -z "$TARGET_UID" ] || [ -z "$TARGET_GID" ]; then
  if [ -d "$DATA_DIR" ]; then
    DIR_UID=$(stat -c '%u' "$DATA_DIR" 2>/dev/null || echo 0)
    DIR_GID=$(stat -c '%g' "$DATA_DIR" 2>/dev/null || echo 0)
    if [ "$DIR_UID" -ne 0 ]; then
      [ -z "$TARGET_UID" ] && TARGET_UID="$DIR_UID"
      [ -z "$TARGET_GID" ] && TARGET_GID="$DIR_GID"
    fi
  fi
  TARGET_UID="${TARGET_UID:-1000}"
  # When only UID is known (e.g. PUID set but $GID unset on bash hosts so
  # PGID came in empty), use it for the group too — single-user accounts
  # on Linux almost always have primary GID == UID.
  TARGET_GID="${TARGET_GID:-$TARGET_UID}"
fi

# Make sure the data directory exists (covers the case where Docker
# auto-created it as root and we're about to take it over).
mkdir -p "$DATA_DIR"

# Fix ownership unless explicitly skipped or unless we'd be a no-op.
if [ "${KEPT_SKIP_CHOWN:-0}" != "1" ]; then
  CURRENT_OWNER=$(stat -c '%u:%g' "$DATA_DIR" 2>/dev/null || echo "0:0")
  if [ "$CURRENT_OWNER" != "${TARGET_UID}:${TARGET_GID}" ]; then
    chown -R "${TARGET_UID}:${TARGET_GID}" "$DATA_DIR" || true
  fi
fi

# Make sure a matching user exists in /etc/passwd so Node has a sane HOME
# and tooling that calls getpwuid() works. If the alpine "node" user (1000)
# is what we're targeting, it's already there.
if ! getent passwd "$TARGET_UID" >/dev/null 2>&1; then
  addgroup -g "$TARGET_GID" -S kept 2>/dev/null || true
  adduser -u "$TARGET_UID" -G kept -S -D -H kept 2>/dev/null || true
fi

exec su-exec "${TARGET_UID}:${TARGET_GID}" "$@"
