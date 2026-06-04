# Running `omakase serve` as a service

`omakase serve --watch` is a long-lived supervisor: it polls
`<cwd>/.omakase/queue` for task files (`*.txt` / `*.md` / `*.prompt`), drives
them through the resumable orchestrator, persists runs under
`<cwd>/.omakase/runs`, and on startup **resumes** anything a previous process
left unfinished (and re-ingests any queue file it claimed but never recorded).
That makes it safe to run unattended under a process manager.

## Drop work in

```bash
echo "summarize the project and list the riskiest files" \
  > my-project/.omakase/queue/task-1.txt
```

The supervisor claims the file (moves it to `queue/processed/`), runs it, and
writes the run record. Queue a new file any time; `--interval <ms>` controls the
poll cadence, `--concurrency <n>` how many runs drive in parallel.

## Linux — systemd (user service)

See [`systemd/omakase-serve.service`](systemd/omakase-serve.service):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/omakase-serve.service ~/.config/systemd/user/
# edit WorkingDirectory + credentials, then:
systemctl --user daemon-reload
systemctl --user enable --now omakase-serve.service
journalctl --user -u omakase-serve -f
```

## macOS — launchd (user agent)

See [`launchd/com.omakase.serve.plist`](launchd/com.omakase.serve.plist):

```bash
cp deploy/launchd/com.omakase.serve.plist ~/Library/LaunchAgents/
# edit WorkingDirectory + PATH/credentials, then:
launchctl load -w ~/Library/LaunchAgents/com.omakase.serve.plist
tail -f /tmp/omakase-serve.log
```

Both units assume `omakase` is on `PATH` (e.g. `npm i -g @omakase/cli`, or point
`ExecStart`/`ProgramArguments` at the repo's `packages/cli/bin/omakase.mjs`).
