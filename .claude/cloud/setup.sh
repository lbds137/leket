#!/usr/bin/env bash
# Cloud VM setup for leket (TASK-44 cloud half), run once by .claude/cloud/step0.md.
# Drafted by the Leket session 11-27 from machloket-client's landed setup (TASK-383 S3
# per-repo adoption, drafted by Deck Platform from deck-platform's r1-r8); this repo's
# session owns this file after adoption.
# Deliberately simpler than the fleet's browser-tier setups: the cloud suite is `npm test`
# only (node --test; smoke needs Chromium and stays host-side, see suite.md). No Chromium
# means no unprivileged test user, no playwright, and the suite runs as root. The zip and
# build tests shell out to python3 and the guarded-fetch test to openssl: both checked and
# reported here, python3 installed best effort if the image lacks it; every python call in
# the tests is a stdlib `-I -c` one-liner or a repo CHECK script, so apt's python3 covers
# them. Exit 0 = env file written (failures inside it are best effort and reported);
# 1 = the env file could not be written; 2 = refused (the local host's hostname).
set -u
envf=${CLOUD_ENV_FILE:-/tmp/cloud-env.sh}
local_host=${CLOUD_SETUP_LOCAL_HOST:-steamdeck}   # set it to this machine's name to run the body elsewhere
case "$(uname -n)" in "$local_host") echo "cloud setup: refusing on the Deck ($(uname -n))" >&2; exit 2 ;; esac

echo "== host"
uname -n; nproc; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo "node: $(node --version 2>&1)"
echo "npm: $(npm --version 2>&1)"
for t in git python3 openssl; do
  printf '%s: %s\n' "$t" "$(command -v "$t" || echo MISSING)"
done
nv=$(node --version 2>/dev/null); nvok=   # floor: this repo's CI (ci.yml) runs node 24
case $nv in v[0-9]*.[0-9]*)
  v=${nv#v}; maj=${v%%.*}
  if [ "$maj" -ge 24 ]; then nvok=1; fi ;;
esac
[ "$nvok" = 1 ] || echo "node: VERSION PROBLEM ($nv; this repo's CI uses 24); install Node 24 and rerun"

echo "== installs (best effort)"
# python3 runs the zip and build tests' zip checks and several `-I -c` readers; every call
# is stdlib-only, so apt's python3 covers it. openssl is checked above, never installed:
# the image always has it; if run 1 proves otherwise, add it to this list.
need=()
for t in python3; do
  command -v "$t" >/dev/null || need+=("$t")
done
if [ ${#need[@]} -gt 0 ]; then
  sudo=; [ "$(id -u)" = 0 ] || sudo=sudo
  if command -v apt-get >/dev/null; then
    # apt's own error is kept and its last lines printed on failure (deck-platform r2's
    # update failed with no reason in the log). The update gets one retry.
    alog=$(mktemp) || alog=/dev/null
    apt_tail() { tail -n 3 "$alog" | cut -c1-200 | sed 's/^/  apt: /'; }
    wait_s=${CLOUD_APT_RETRY_SLEEP:-15}   # set 0 to skip the retry wait
    for try in 1 2; do
      if timeout 120 $sudo apt-get update -qq >"$alog" 2>&1; then break; else rc=$?; fi
      if [ "$try" = 1 ]; then echo "apt-get update failed (status $rc), retrying in $wait_s s:"; apt_tail; sleep "$wait_s"
      else echo "apt-get update failed again (status $rc):"; apt_tail; fi
    done
    for p in "${need[@]}"; do
      if timeout 180 $sudo apt-get install -y -qq "$p" >"$alog" 2>&1; then echo "installed $3"
      else rc=$?; echo "install FAILED: $p (status $rc)"; apt_tail; fi
    done
    [ "$alog" = /dev/null ] || rm -f "$alog"
  else
    echo "no apt-get; still missing: ${need[*]}"
  fi
fi

tmp=$(mktemp "$envf.XXXXXX") || { echo "cloud setup: can't create a temp file beside $envf" >&2; exit 1; }
{ echo "# written by .claude/cloud/setup.sh; source before running repo tools"
  # Nothing to export yet: the unit suite reads no toggles (only smoke.mjs reads
  # LEKET_CHROME/CI-style env, and smoke is not in the cloud suite). The file exists so
  # step 1's `. /tmp/cloud-env.sh &&` is uniform with the fleet's suites and a later
  # extension (smoke needs LEKET_CHROME pointing at a VM chromium) has its place.
} > "$tmp" && mv -f "$tmp" "$envf" || { rm -f "$tmp"; echo "cloud setup: can't write $envf" >&2; exit 1; }
echo "user $(id -un) (uid $(id -u))"
echo "== env file $envf"; cat "$envf"

# npm ci in place: the VM checkout is root-owned and the suite runs as root, so no copy
# to a test user is needed (machloket-client copies only for its unprivileged browser
# tier). A FAILED line leaves exit 0: the suite then fails visibly and step 2/5 of
# suite.md carry the reason.
echo "== npm ci"
ciout=$(mktemp) || { echo "cloud setup: can't create the npm ci log" >&2; exit 1; }
if npm ci --no-audit --no-fund >"$ciout" 2>&1; then
  echo "npm ci ok ($(grep -m1 '^added' "$ciout" 2>/dev/null || echo '?'))"
  rm -f "$ciout"
else
  rc=$?; echo "npm ci FAILED (status $rc); tail:"; tail -n 5 "$ciout" 2>/dev/null | cut -c1-200 | sed 's/^/  npm: /'
  echo "  npm: full log kept at $ciout"
fi
