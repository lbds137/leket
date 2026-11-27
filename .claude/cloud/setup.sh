#!/usr/bin/env bash
# Cloud VM setup for leket (TASK-44 cloud half), run once by .claude/cloud/step0.md.
# Drafted by the Leket session 11-27 from machloket-client's landed setup (TASK-383 S3
# per-repo adoption, from deck-platform's r1-r8); this repo's session owns this file
# after adoption. Reviewed pre-push by gemini-4-argon-high, round 1 (11-27).
#
# Deliberately simpler than the fleet's browser-tier setups: the cloud suite is `npm test`
# only (node --test; smoke needs Chromium and stays host-side, see suite.md). No Chromium
# means no unprivileged test user, no playwright, and the suite runs as root. The zip and
# build tests shell out to python3, the guarded-fetch test to openssl (slim images carry
# libssl but not the CLI), suite.md's timeout check needs pgrep and host.txt needs free
# (both from procps, not Essential on minimal images), and six test files load a pinned
# CommonMark oracle (test/md-oracle.js) that npm-installs into a cache outside the tree on
# first use. All of that is checked and installed best effort here, so the timed suite
# never installs anything itself. Every python call in the tests is a stdlib `-I -c`
# one-liner or a repo CHECK script.
#
# Node is the one non-best-effort piece: the cloud base image ships whatever node major
# it ships (v22.23.5 on 11-27) and this suite does not survive it (the first VM run's
# runner cancelled 48 tests with 'Promise resolution is still pending'), so when the
# image's node is not the CI major (24), setup provisions a pinned node 24 tarball —
# v24.21.0 linux-x64, its sha256 pinned in this script so a nodejs.org-side change
# fails closed — into /usr/local/lib/leket-cloud-node24 and puts it first on PATH via
# the env file. The tarball is linux-x64: a VM of another architecture fails closed
# with an explicit unsupported-arch line. If the provision fails, setup stops before
# the env file: exit 1, no
# suite run, no verdict off a node the repo is not green on.
#
# Exit 0 = the env file was written (everything after it is best effort and reported);
# 1 = setup could not reach the env-file step (cwd, temp file or write failure, or the
# node 24 provision failed);
# 2 = refused (the local host's hostname). Every failure inside exit 0 prints a line the
# report must carry: MISSING / STILL MISSING, install FAILED,
# npm ci FAILED, oracle warmup FAILED.
set -u
cd -- "$(dirname -- "$0")/../.." || { echo "cloud setup: can't reach the repo root from $0" >&2; exit 1; }
envf=${CLOUD_ENV_FILE:-/tmp/cloud-env.sh}
local_host=${CLOUD_SETUP_LOCAL_HOST:-steamdeck}   # set it to this machine's name to run the body elsewhere
case "$(uname -n)" in "$local_host") echo "cloud setup: refusing on the Deck ($(uname -n))" >&2; exit 2 ;; esac

echo "== host"
uname -n; nproc
. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown os}"
echo "node: $(command -v node >/dev/null && node --version 2>&1 || echo MISSING)"
echo "npm: $(command -v npm >/dev/null && npm --version 2>&1 || echo MISSING)"
for t in git python3 openssl pgrep free; do
  printf '%s: %s\n' "$t" "$(command -v "$t" || echo MISSING)"
done
nv=$(command -v node >/dev/null && node --version 2>/dev/null) || nv=
nvok=   # the suite is green on the CI major (24) and proven broken on the image's 22
case $nv in v[0-9]*.[0-9]*)
  v=${nv#v}; maj=${v%%.*}
  if [ "$maj" -eq 24 ]; then nvok=1; fi ;;
esac
nodepathline=   # non-empty when the provisioned prefix leads PATH; exported into the env file
nodeprefix=${CLOUD_NODE_PREFIX:-/usr/local/lib/leket-cloud-node24}
nver=v24.21.0   # ci.yml's major (24); the minor the authoring Deck runs — pinned, not a knob (the sha below is pinned to it)
# The provisioned prefix, when it already carries $nver, wins over whatever PATH says:
# a setup re-run on a VM that sourced the env file sees the provisioned node as the
# "system" node (nvok=1) and would otherwise rewrite the env file WITHOUT the PATH
# export, silently reverting every later step to the image's node.
have=$("$nodeprefix/bin/node" --version 2>/dev/null)
if [ "$have" = "$nver" ]; then
  export PATH="$nodeprefix/bin:$PATH"
  nodepathline="export PATH=\"$nodeprefix/bin:\$PATH\""
  echo "node: PATH leads with $nodeprefix/bin ($nver); provisioning skipped"
elif [ "$nvok" != 1 ]; then
  # The base image ships whatever node it ships (v22.23.5 on 11-27) and the suite does
  # not survive it: on run task44-adopt-c1b1398fb3-20261127T200427Z the timeout tests
  # hung node 22's runner, which cancelled 48 tests with 'Promise resolution is still
  # pending' and exited 1 with fail 0. So setup provisions the exact node this repo is
  # green on — the same pinned tarball every run, its sha256 pinned in this script —
  # and nothing after this point trusts the system node.
  dlc=
  if command -v curl >/dev/null; then dlc="curl -fsSL --retry 2 -o"
  elif command -v wget >/dev/null; then dlc="wget -q -O"
  fi
  dlp=$(mktemp -d) || dlp=
  ok=1
  if [ -z "$dlc" ]; then echo "node install FAILED: no curl or wget on PATH"; ok=
  elif [ -z "$dlp" ]; then echo "node install FAILED: no temp dir"; ok=
  elif [ "$(uname -m)" != x86_64 ]; then echo "node install FAILED: unsupported arch $(uname -m) (the pinned tarball is linux-x64)"; ok=
  fi
  tgz=node-$nver-linux-x64.tar.gz
  # The tarball's sha256 is pinned here (from nodejs.org's SHASUMS256, 11-27), so "the
  # same pinned tarball every run" is literal: a nodejs.org-side change fails closed.
  # timeout 180 bounds the fetch like npm ci's timeout 300 below — a stalled dist
  # server must not eat the step-0 Bash call's cap before the FAILED line lands in
  # cloud-setup.out.
  sha=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
  if [ "$ok" = 1 ]; then
    if ! timeout 180 $dlc "$dlp/$tgz" "https://nodejs.org/dist/$nver/$tgz"; then
      echo "node install FAILED: download of $nver"; ok=
    elif ! printf '%s  %s\n' "$sha" "$tgz" | (cd "$dlp" && sha256sum -c -); then
      echo "node install FAILED: sha256 of $tgz (want $sha)"; ok=
    fi
  fi
  if [ "$ok" = 1 ]; then
    # Replace only a prefix setup itself provisioned (marker file): CLOUD_NODE_PREFIX
    # is a documented knob, and rm -rf on a directory it does not own is not acceptable.
    if [ -d "$nodeprefix" ] && [ ! -f "$nodeprefix/.leket-cloud-node" ]; then
      echo "node install FAILED: $nodeprefix exists and is not a leket-provisioned node (no .leket-cloud-node marker); refusing to replace it"; ok=
    else
      rm -rf "$nodeprefix"
      if ! mkdir -p "$nodeprefix" \
         || ! tar -xzf "$dlp/$tgz" -C "$nodeprefix" --strip-components=1; then
        echo "node install FAILED: unpack into $nodeprefix"; ok=
      elif [ "$("$nodeprefix/bin/node" --version 2>/dev/null)" != "$nver" ]; then
        echo "node install FAILED: $nodeprefix/bin/node does not report $nver (binary or library mismatch)"; ok=
      else
        echo "$nver" > "$nodeprefix/.leket-cloud-node"
      fi
    fi
  fi
  [ -z "$dlp" ] || rm -rf "$dlp"
  if [ "$ok" = 1 ]; then
    export PATH="$nodeprefix/bin:$PATH"
    nodepathline="export PATH=\"$nodeprefix/bin:\$PATH\""
    echo "node: system was ${nv:-absent}; installed $nver at $nodeprefix (node now reports $(node --version))"
  else
    echo "node: VERSION PROBLEM (system ${nv:-absent}; provisioning $nver failed): stop and report"
    rm -f "$envf"   # no env file, no suite run — a stale one from an earlier run must not survive
    exit 1
  fi
fi

echo "== installs (best effort)"
need=()
command -v python3 >/dev/null || need+=(python3)
command -v openssl >/dev/null || need+=(openssl)
command -v pgrep >/dev/null || command -v free >/dev/null || need+=(procps)
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
      if timeout 180 $sudo apt-get install -y -qq "$p" >"$alog" 2>&1; then echo "installed $p"
      else rc=$?; echo "install FAILED: $p (status $rc)"; apt_tail; fi
    done
    [ "$alog" = /dev/null ] || rm -f "$alog"
  else
    echo "no apt-get; still missing: ${need[*]}"
  fi
fi
# The checks above ran before the installs, so a MISSING line can be resolved a few lines
# later; this re-check states the outcome, and step 2 of step0.md treats "STILL MISSING"
# as the line that must not be ignored.
for t in python3 openssl pgrep free; do
  command -v "$t" >/dev/null || echo "$t: STILL MISSING after installs"
done

tmp=$(mktemp "$envf.XXXXXX") || { echo "cloud setup: can't create a temp file beside $envf" >&2; exit 1; }
{ echo "# written by .claude/cloud/setup.sh; source before running repo tools"
  if [ -n "$nodepathline" ]; then
    # Setup provisioned node (the image's node is not the CI major); this line is why
    # every step that sources the file runs the provisioned node, not the system one.
    echo "$nodepathline"
  else
    # Nothing to export: the unit suite reads no toggles (only smoke.mjs reads
    # LEKET_CHROME/CI-style env, and smoke is not in the cloud suite) and the system
    # node is the CI major. The file exists so step 1's `. /tmp/cloud-env.sh &&` is
    # uniform with the fleet's suites and a later extension (smoke needs LEKET_CHROME
    # pointing at a VM chromium) has its place.
    :   # an else branch may not hold only comments; this no-op keeps the branch non-empty
  fi
} > "$tmp" && mv -f "$tmp" "$envf" || { rm -f "$tmp"; echo "cloud setup: can't write $envf" >&2; exit 1; }
echo "user $(id -un) (uid $(id -u))"
echo "== env file $envf"; cat "$envf"

# npm ci in place: the VM checkout is root-owned and the suite runs as root, so no copy
# to a test user is needed (machloket-client copies only for its unprivileged browser
# tier). The repo keeps no runtime deps and no test imports node_modules, so a FAILED
# line still leaves exit 0 — the suite would pass, and the FAILED line in the report is
# what marks the run. timeout 300: a registry hang must not eat the Bash call's cap
# before the FAILED tail lands in cloud-setup.out.
echo "== npm ci"
ciout=$(mktemp) || ciout=/tmp/leket-npm-ci.log
if timeout 300 npm ci --no-audit --no-fund >"$ciout" 2>&1; then
  echo "npm ci ok ($(grep -m1 '^added' "$ciout" 2>/dev/null || echo '?'))"
  rm -f "$ciout"
else
  rc=$?; echo "npm ci FAILED (status $rc); tail:"; tail -n 5 "$ciout" 2>/dev/null | cut -c1-200 | sed 's/^/  npm: /'
fi

# Warm the CommonMark oracle cache once: six test files load it at top level, and on a
# cold cache each would npm-install mid-suite. Best effort — a FAILED line is reported
# and the suite's md-oracle tests carry the real error.
echo "== oracle warmup"
if timeout 300 node -e "import('./test/md-oracle.js').then(m => m.loadCommonmark()).then(() => console.log('oracle ok'))"; then
  echo "oracle warmup ok"
else
  echo "oracle warmup FAILED (status $?); the suite's md-oracle tests carry the real error"
fi
