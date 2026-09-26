#!/bin/bash
# The shebang is load-bearing: AWS-RunShellScript otherwise executes this with
# /bin/sh (dash on Ubuntu), which cannot parse the [[ ]] regex tests below.
set -euo pipefail

TARGET_SHA="__TARGET_SHA__"
MODE="__MODE__"
ARTIFACT_SHA256="__ARTIFACT_SHA256__"
S3_KEY="__S3_KEY__"

CURRENT=/var/www/dinify-admin
RELEASE_ROOT=/var/www/dinify-admin-releases
AWS_BIN=/usr/local/bin/aws
PY_BIN=/usr/bin/python3
BUCKET=dinify-deploy-artifacts-767397669083-eu-west-2
PUBLIC_HOST=admin.dinifyapp.com
# Floor for INSTALLING a new release. Deliberately generous against a ~500 KB
# artifact, because the failure it prevents is a half-written release.
MIN_FREE_KB=524288

fail() { echo "DEPLOY-FAILED: $*" >&2; exit 1; }

# ---- re-validate everything the workflow handed over ----
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "TARGET_SHA is not 40 lowercase hex"
case "$MODE" in
  deploy|rollback) ;;
  *) fail "MODE must be deploy or rollback" ;;
esac

FINAL_RELEASE="${RELEASE_ROOT}/${TARGET_SHA}"
echo "ADMIN-DEPLOY: mode=${MODE} target=${TARGET_SHA}"

# ---- preconditions, before any mutation ----
[ -x "$PY_BIN" ] || fail "python3 not found at ${PY_BIN}"
[ -d "$RELEASE_ROOT" ] || fail "release root ${RELEASE_ROOT} is not a directory"
RELEASE_ROOT_REAL="$(readlink -f "$RELEASE_ROOT")" || fail "cannot resolve ${RELEASE_ROOT}"
[ -L "$CURRENT" ] || fail "${CURRENT} is not a symlink; refusing to touch it"
PREV_TARGET="$(readlink -f "$CURRENT")" || fail "cannot resolve ${CURRENT}"
[ -n "$PREV_TARGET" ] || fail "${CURRENT} resolves to nothing"

# Boundary-safe containment: requires a real path separator after the root, so
# a sibling such as /var/www/dinify-admin-releases-evil cannot pass as a
# textual prefix match.
case "$PREV_TARGET" in
  "${RELEASE_ROOT_REAL}"/*) ;;
  *) fail "current symlink target ${PREV_TARGET} is outside ${RELEASE_ROOT_REAL}" ;;
esac
echo "PREVIOUS-TARGET: ${PREV_TARGET}"

# NOTE: the free-space precondition is deliberately NOT here. It belongs only
# to the one path that writes bytes — installing a NEW release. A rollback
# downloads nothing, extracts nothing and installs nothing; gating it on free
# space would withhold emergency recovery in exactly the degraded situation
# that most needs it. Re-promoting an already-installed release is the same.

# ---- release validators (used for staged trees AND existing releases) ----
validate_release() {
  local dir="$1" ctx="$2" got
  [ ! -L "$dir" ] || fail "${ctx}: ${dir} is a symlink"
  [ -d "$dir" ] || fail "${ctx}: ${dir} is not a directory"
  [ -f "$dir/index.html" ] || fail "${ctx}: index.html is missing or not a regular file"
  [ -s "$dir/index.html" ] || fail "${ctx}: index.html is empty"
  [ -f "$dir/release.txt" ] || fail "${ctx}: release.txt is missing or not a regular file"
  got="$(cat "$dir/release.txt")"
  [ "$got" = "$TARGET_SHA" ] || fail "${ctx}: release.txt attests '${got}', expected '${TARGET_SHA}'"
  [ "$(find "$dir" -type f | wc -l)" -ge 1 ] || fail "${ctx}: contains no regular files"
  if find "$dir" -mindepth 1 -type l -print -quit | grep -q .; then
    fail "${ctx}: contains symlinks"
  fi
  if find "$dir" -mindepth 1 ! -type f ! -type d -print -quit | grep -q .; then
    fail "${ctx}: contains entries that are neither regular files nor directories"
  fi
}

# Apache (www-data) must be able to READ the tree and must not be able to
# WRITE any of it. Owner root plus no group-write and no other-write is what
# delivers that; world-read/execute is how www-data is granted access at all.
validate_permissions() {
  local dir="$1" ctx="$2"
  if find "$dir" ! -user root -print -quit | grep -q .; then
    fail "${ctx}: contains entries not owned by root"
  fi
  if find "$dir" -perm /022 -print -quit | grep -q .; then
    fail "${ctx}: contains group- or other-writable entries"
  fi
  if find "$dir" -type d ! -perm -005 -print -quit | grep -q .; then
    fail "${ctx}: contains a directory Apache cannot traverse"
  fi
  if find "$dir" -type f ! -perm -004 -print -quit | grep -q .; then
    fail "${ctx}: contains a file Apache cannot read"
  fi
}

# ---- truly atomic symlink replacement ----
# `ln -sfnT` is NOT sufficient on its own: a forced ln may unlink the old
# destination before creating the replacement, leaving a window in which
# CURRENT does not exist and Apache serves nothing. Creating a temporary
# symlink beside it and rename(2)-ing it over the destination has no such
# window.
#
# The temporary link is created inside a directory made by `mktemp -d`, never
# at a name from `mktemp -u`: -u only PREDICTS a free name and returns without
# claiming it, so anything between the prediction and the `ln` could take it.
# `mktemp -d` creates the directory atomically with 0700, so the name inside it
# cannot be raced. The directory sits beside CURRENT, keeping the rename
# same-filesystem.
atomic_symlink() {
  local target="$1" linkpath="$2" dir tmpdir tmplink rc
  dir="$(dirname "$linkpath")"
  tmpdir="$(mktemp -d "${dir}/.dinify-admin-link.XXXXXXXX")" || return 1
  tmplink="${tmpdir}/link"
  rc=0
  if ! ln -s "$target" "$tmplink"; then
    rc=1
  elif ! mv -Tf "$tmplink" "$linkpath"; then
    rc=1
  fi
  rm -rf "$tmpdir" 2>/dev/null || true
  return "$rc"
}

# ---- install (deploy) or locate (rollback) the target release ----
if [ "$MODE" = "deploy" ]; then
  [[ "$ARTIFACT_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "ARTIFACT_SHA256 is not 64 lowercase hex"
  EXPECTED_KEY="admin/${TARGET_SHA}/${ARTIFACT_SHA256}.tar.gz"
  [ "$S3_KEY" = "$EXPECTED_KEY" ] || fail "S3 key '${S3_KEY}' does not match the expected structure '${EXPECTED_KEY}'"

  if [ -e "$FINAL_RELEASE" ]; then
    # An immutable release is never repaired, overwritten or extracted over.
    # It either validates and becomes eligible for re-promotion, or the deploy
    # fails and a human looks at it. Nothing is written, so no space is needed.
    validate_release "$FINAL_RELEASE" "existing release"
    validate_permissions "$FINAL_RELEASE" "existing release"
    echo "RELEASE-EXISTS: ${FINAL_RELEASE} already installed and valid; skipping download and extraction"
  else
    # This is the ONLY path that writes a new release, so this is where the
    # free-space floor belongs.
    AVAIL_KB="$(df -Pk "$RELEASE_ROOT_REAL" | awk 'NR==2 {print $4}')"
    [ -n "${AVAIL_KB:-}" ] || fail "cannot determine free space on ${RELEASE_ROOT_REAL}"
    [ "$AVAIL_KB" -ge "$MIN_FREE_KB" ] || fail "insufficient free space to install a new release: ${AVAIL_KB} KiB available, need at least ${MIN_FREE_KB} KiB"

    [ -x "$AWS_BIN" ] || fail "AWS CLI not found at ${AWS_BIN}"
    STAGE="$(mktemp -d "${RELEASE_ROOT}/.staging-${TARGET_SHA}.XXXXXXXX")" || fail "cannot create staging directory"
    trap 'rm -rf "$STAGE"' EXIT
    mkdir "${STAGE}/tree"

    "$AWS_BIN" s3 cp "s3://${BUCKET}/${S3_KEY}" "${STAGE}/artifact.tar.gz" --only-show-errors \
      || fail "could not download s3://${BUCKET}/${S3_KEY}"

    GOT_SHA="$(sha256sum "${STAGE}/artifact.tar.gz" | cut -d' ' -f1)"
    [ "$GOT_SHA" = "$ARTIFACT_SHA256" ] \
      || fail "artifact digest mismatch: downloaded ${GOT_SHA}, expected ${ARTIFACT_SHA256}"
    echo "ARTIFACT-VERIFIED: ${GOT_SHA}"

    # Archive members are validated BEFORE anything is written to disk. tar is
    # never pointed at an unvalidated archive: absolute paths, traversal,
    # symlinks, hardlinks, devices, FIFOs and sockets are all rejected outright
    # rather than filtered, so a malformed artifact fails loudly.
    "$PY_BIN" - "${STAGE}/artifact.tar.gz" "${STAGE}/tree" <<'PYEXTRACT'
import os
import sys
import tarfile

src, dest = sys.argv[1], sys.argv[2]
dest = os.path.realpath(dest)

with tarfile.open(src, "r:gz") as tf:
    members = tf.getmembers()
    if not members:
        sys.exit("archive contains no members")
    for m in members:
        if not (m.isfile() or m.isdir()):
            sys.exit("rejected non-regular archive member: %s" % m.name)
        name = m.name
        if name.startswith("/") or os.path.isabs(name):
            sys.exit("rejected absolute path in archive: %s" % name)
        if ".." in name.replace("\\", "/").split("/"):
            sys.exit("rejected path traversal in archive: %s" % name)
        resolved = os.path.realpath(os.path.join(dest, name))
        if resolved != dest and not resolved.startswith(dest + os.sep):
            sys.exit("rejected archive member escaping destination: %s" % name)
    try:
        tf.extractall(dest, members=members, filter="data")
    except TypeError:
        tf.extractall(dest, members=members)
print("ARCHIVE-MEMBERS: %d" % len(members))
PYEXTRACT

    chown -R root:root "${STAGE}/tree"
    find "${STAGE}/tree" -type d -exec chmod 0755 {} +
    find "${STAGE}/tree" -type f -exec chmod 0644 {} +

    validate_release "${STAGE}/tree" "staged release"
    validate_permissions "${STAGE}/tree" "staged release"

    # Same-filesystem rename: the release appears complete and valid, or it
    # does not appear at all. Never a copy or a sync into the final path.
    [ ! -e "$FINAL_RELEASE" ] || fail "${FINAL_RELEASE} appeared while staging; refusing to overwrite"
    mv -T "${STAGE}/tree" "$FINAL_RELEASE" || fail "could not install release into ${FINAL_RELEASE}"

    validate_release "$FINAL_RELEASE" "installed release"
    validate_permissions "$FINAL_RELEASE" "installed release"
    echo "RELEASE-INSTALLED: ${FINAL_RELEASE}"
  fi
else
  # Rollback never downloads, builds, extracts, repairs or rewrites anything.
  # It is a symlink operation against a release that must already be present,
  # and it therefore needs no free space at all.
  [ -e "$FINAL_RELEASE" ] || fail "rollback target ${FINAL_RELEASE} is not installed on this box; rollback never reconstructs a release"
  validate_release "$FINAL_RELEASE" "rollback target"
  validate_permissions "$FINAL_RELEASE" "rollback target"
  echo "ROLLBACK-TARGET-VALID: ${FINAL_RELEASE}"
fi

FINAL_REAL="$(readlink -f "$FINAL_RELEASE")" || fail "cannot resolve ${FINAL_RELEASE}"

# ---- promote ----
atomic_symlink "$FINAL_REAL" "$CURRENT" || fail "could not atomically re-point ${CURRENT}"
PROMOTED="$(readlink -f "$CURRENT")" || fail "cannot resolve ${CURRENT} after promotion"
[ "$PROMOTED" = "$FINAL_REAL" ] || fail "after promotion ${CURRENT} resolves to ${PROMOTED}, expected ${FINAL_REAL}"
echo "PROMOTED: ${CURRENT} -> ${FINAL_REAL}"
# Apache resolves the symlink per request; it is deliberately NOT reloaded.

# ---- post-switch assertions through LOCAL Apache ----
# These return non-zero rather than calling fail(), because their caller must
# stay alive long enough to restore the previous release.
http_probe() {
  local path="$1" outvar_code="$2" outvar_body="$3" raw
  raw="$(curl -sS --max-time 15 \
          --resolve "${PUBLIC_HOST}:443:127.0.0.1" \
          -H 'Cache-Control: no-cache' \
          -w '\n%{http_code}' \
          "https://${PUBLIC_HOST}${path}" 2>/dev/null || true)"
  printf -v "$outvar_code" '%s' "$(printf '%s' "$raw" | tail -n 1)"
  printf -v "$outvar_body" '%s' "$(printf '%s' "$raw" | sed '$d')"
}

post_switch_checks() {
  local code body status attempt

  for attempt in 1 2 3; do
    http_probe "/release.txt" code body
    if [ "$code" = "200" ] && [ "$body" = "$TARGET_SHA" ]; then
      break
    fi
    if [ "$attempt" -lt 3 ]; then
      sleep 2
    fi
  done
  if [ "$code" != "200" ] || [ "$body" != "$TARGET_SHA" ]; then
    echo "CHECK-FAILED: /release.txt returned HTTP ${code} body '${body}', expected 200 and '${TARGET_SHA}'" >&2
    return 1
  fi

  http_probe "/api/admin/v1/health/" code body
  if [ "$code" != "200" ]; then
    echo "CHECK-FAILED: /api/admin/v1/health/ returned HTTP ${code}, expected 200" >&2
    return 1
  fi
  status="$(printf '%s' "$body" | "$PY_BIN" -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || echo "")"
  if [ "$status" != "ok" ]; then
    echo "CHECK-FAILED: /api/admin/v1/health/ parsed status '${status}', expected 'ok'" >&2
    return 1
  fi

  http_probe "/" code body
  if [ "$code" != "200" ]; then
    echo "CHECK-FAILED: / returned HTTP ${code}, expected 200" >&2
    return 1
  fi
  case "$body" in
    *"<html"*|*"<!doctype"*|*"<!DOCTYPE"*) ;;
    *) echo "CHECK-FAILED: / did not return an HTML document" >&2; return 1 ;;
  esac

  http_probe "/restaurants/00000000-0000-0000-0000-000000000000/readiness" code body
  if [ "$code" != "200" ]; then
    echo "CHECK-FAILED: deep SPA route returned HTTP ${code}, expected 200" >&2
    return 1
  fi
  case "$body" in
    *"<html"*|*"<!doctype"*|*"<!DOCTYPE"*) ;;
    *) echo "CHECK-FAILED: deep SPA route did not return an HTML document" >&2; return 1 ;;
  esac

  return 0
}

if ! post_switch_checks; then
  echo "POST-SWITCH-FAILED: restoring ${PREV_TARGET}" >&2
  if atomic_symlink "$PREV_TARGET" "$CURRENT"; then
    RESTORED="$(readlink -f "$CURRENT" || echo '')"
    if [ "$RESTORED" = "$PREV_TARGET" ]; then
      echo "RESTORED-PREVIOUS: ${CURRENT} -> ${PREV_TARGET}" >&2
    else
      echo "RESTORE-VERIFY-FAILED: ${CURRENT} resolves to '${RESTORED}', expected '${PREV_TARGET}'" >&2
    fi
  else
    echo "RESTORE-FAILED: could not re-point ${CURRENT} to ${PREV_TARGET} — MANUAL INTERVENTION REQUIRED" >&2
  fi
  # A successful automatic restoration is NOT a successful deployment.
  exit 1
fi

# Emitted ONLY after every local served-state assertion has passed. This is the
# box's own attestation of what it promoted, and it is the only thing the
# workflow will accept as proof.
echo "DEPLOYED-HEAD: ${TARGET_SHA}"
