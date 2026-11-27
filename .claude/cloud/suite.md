Run this repo's unit test suite once on this VM and return the complete output through git. This is a test run, so change nothing in the repo's code: the only files you add are under `@RESULTS@/` (that placeholder is replaced with the run's results directory when this spec is dispatched — if you are reading this file from inside the repo rather than a dispatched prompt, stop and ask the dispatcher for the interpolated copy).

All paths are relative to the checkout root, and every step runs from there (the base check in the placement section leaves you there).

The suite is `npm test` — node --test over `test/*.test.js` (963 tests; 32s of test time, ~35s wall on the authoring Deck, 11-27). There is no browser tier: smoke (`node test/smoke/smoke.mjs`) needs Chromium and is deliberately NOT part of the cloud suite — it stays a local gate (see .claude/cloud/setup.sh's header). The suite runs as root; the setup created no test user.

1. After Step 0, run the suite in one Bash call (timeout 600000 ms):

   `. /tmp/cloud-env.sh && timeout 540 npm test > /tmp/suite.out 2>&1; echo rc=$? > /tmp/suite.rc`

   The inner `timeout 540` bounds a hung suite under the Bash call's own cap, so `/tmp/suite.rc` always appears (rc 124 = the inner timeout fired). If the Bash call itself times out before that, run `pgrep -a -f '[n]ode --test|[n]pm test'` — the bracket form is required: a plain pattern would match your own wrapper shell's command line (it carries the pattern text; pgrep -f matches it and pgrep does not exclude its parent, so an unfiltered pgrep always reports "alive"). If a real suite process is alive (a `node --test` or `npm test` line), do not start another; poll `/tmp/suite.rc` at most 5 times, 2 minutes apart, then treat it as the nothing-running case. Only if nothing matched, `rm -f /tmp/suite.out /tmp/suite.rc` and rerun in the background with the rc capture INSIDE the quoted `bash -c` (an `echo rc=$?` outside it would record the rc of `&`, always 0), then poll `/tmp/suite.rc` every 2 minutes:

   `nohup bash -c '. /tmp/cloud-env.sh && timeout 540 npm test; echo rc=$? > /tmp/suite.rc' >/tmp/suite.out 2>&1 &`

2. Full logs of the failing test files: with a non-zero rc, `/tmp/suite.out` ends with an `✖ failing tests:` section. Each failing test names its file either in a `test at <path>:<line>:<col>` line, or — when a file failed before any test registered (a top-level import throw) — as a line beginning `✖ <path>` directly. Collect the DISTINCT `<path>` values from BOTH forms (strip a trailing `:<line>:<col>`; paths are relative to the checkout root, e.g. `test/zip.test.js`). For each, run that file alone in one Bash call — `mkdir -p /tmp/probes` done once, `<basename>` means the file name with directories stripped (`zip.test.js`, not `test/zip.test.js`), one at a time:

   `timeout 600 bash -c '. /tmp/cloud-env.sh && node --test <path>' > /tmp/probes/<basename>.out 2>&1; echo "rc=$?" >> /tmp/probes/<basename>.out`

   With a zero rc, skip this step (and then `/tmp/probes` does not exist — step 3 handles that).

3. In ONE Bash call, copy the results (the probes branch is an `if`, so a green run with no probes directory still reaches host.txt):

   `mkdir -p @RESULTS@; git rev-parse HEAD > @RESULTS@/head.txt; for f in cloud-setup.out suite.out suite.rc; do if [ -f "/tmp/$f" ]; then cp "/tmp/$f" @RESULTS@/; else echo "MISSING: /tmp/$f (that step never ran)" | tee -a @RESULTS@/missing.txt; fi; done; if [ -d /tmp/probes ]; then cp -r /tmp/probes @RESULTS@/; fi; { nproc; free -g; uname -a; } > @RESULTS@/host.txt`

   `head.txt` is written in this step, before any commit: it is the tree the suite ran on; setup ran entirely in this same checkout, so there is no separate test tree. A MISSING line lands both in `@RESULTS@/missing.txt` and in your report (step 5).

4. `git add @RESULTS@ && git commit -m "cloud-test: suite output"`, then push the branch. The push target is the `cloud-test/*` scratch branch you were started on (never `main`). Commit identity and push authentication are the claude CLI's own on this VM — the dispatcher's prompt carries the Delivery section with the same rules (commit on the started branch, push to origin, open no PR). The pushed files are the deliverable: the driver reads them from git, not from your report.

5. In the report, give rc, node --test's summary lines (`ℹ tests N`, `ℹ pass N`, `ℹ fail N`), every `MISSING` (setup or step 3), `install FAILED`, `VERSION PROBLEM`, `npm ci FAILED`, or `oracle warmup FAILED` line verbatim, and the name of each failing test file probed in step 2. Do not analyse the failures.
