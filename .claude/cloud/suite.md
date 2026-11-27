Run this repo's unit test suite once on this VM and return the complete output through git. This is a test run, so change nothing in the repo's code: the only files you add are under `@RESULTS@/`.

The suite is `npm test` — node --test over `test/*.test.js` (963 tests; 32s of test time, ~35s wall on the Deck, 11-27). There is no browser tier: smoke (`node test/smoke/smoke.mjs`) needs Chromium and is deliberately NOT part of the cloud suite — it stays a local gate (see .claude/cloud/setup.sh's header). The suite runs as root; the setup created no test user.

1. After Step 0, run the suite in one Bash call (timeout 600000 ms), its output sent to `/tmp/suite.out 2>&1` and its exit code to `/tmp/suite.rc` (`echo rc=$? > /tmp/suite.rc`):

   `. /tmp/cloud-env.sh && npm test > /tmp/suite.out 2>&1; echo rc=$? > /tmp/suite.rc`

   If the call times out, first run `pgrep -a -f 'node --test|npm test'`: if that run is still alive, do not start another; poll `/tmp/suite.rc` every 2 minutes until it appears. Only if nothing is running and `/tmp/suite.rc` is absent, `rm -f /tmp/suite.out /tmp/suite.rc` and rerun in the background with the rc capture INSIDE the quoted `bash -c` (an `echo rc=$?` outside it would record the rc of `&`, always 0) and `timeout 1500` around the chain, then poll `/tmp/suite.rc` every 2 minutes:

   `nohup bash -c '. /tmp/cloud-env.sh && timeout 1500 npm test; echo rc=$? > /tmp/suite.rc' >/tmp/suite.out 2>&1 &`

2. Full logs of the failing test files: with a non-zero rc, `/tmp/suite.out` ends with an `✖ failing tests:` section, and each failing test there carries a `test at <path>:<line>` line naming its file. For each DISTINCT file named, run that file alone in one Bash call — `mkdir -p /tmp/probes && chmod 777 /tmp/probes` done once, strip the trailing `:<line>:<col>` from the path, and run (one at a time, the same `. /tmp/cloud-env.sh && ` prefix):

   `timeout 600 bash -c '. /tmp/cloud-env.sh && node --test <path>' > /tmp/probes/<basename>.out 2>&1; echo "rc=$?" >> /tmp/probes/<basename>.out`

   With a zero rc, skip this step.

3. `mkdir -p @RESULTS@ && git rev-parse HEAD > @RESULTS@/head.txt && for f in cloud-setup.out suite.out suite.rc; do if [ -f "/tmp/$f" ]; then cp "/tmp/$f" @RESULTS@/; else echo "MISSING: /tmp/$f (that step never ran)"; fi; done`, then `[ -d /tmp/probes ] && cp -r /tmp/probes @RESULTS@/`, then save `nproc; free -g; uname -a` to `@RESULTS@/host.txt`. `head.txt` must be written before any commit: it is the tree the suite ran on; setup's npm ci ran in this same checkout, so there is no separate test tree.

4. `git add @RESULTS@ && git commit -m "cloud-test: suite output"`, then push the branch. The push target is the `cloud-test/*` scratch branch you were started on (never `main`). Commit identity and push authentication are the claude CLI's own on this VM — the dispatcher's prompt carries the Delivery section with the same rules (commit on the started branch, push to origin, open no PR). The pushed files are the deliverable: the driver reads them from git, not from your report.

5. In the report, give rc, node --test's summary lines (`ℹ tests N`, `ℹ pass N`, `ℹ fail N`), every `MISSING` (setup or step 3), `install FAILED`, `VERSION PROBLEM`, or `npm ci FAILED` line verbatim, and the name of each failing test file probed in step 2. Do not analyse the failures.
