# HMA UID Fake

KernelSU module that makes the uid of an app hidden by HMA (or HMA-OSS) answer as if it did
not exist:

```
getpriority(PRIO_USER, uid)       -> -ESRCH
ioprio_get(IOPRIO_WHO_USER, uid)  -> -EINVAL
setpriority / ioprio_set          -> same
```

Which rules apply follows the app a process was born from, not the uid it holds when it calls, so an
isolated child or anything that called `setuid()` answers the same way.

Install the release zip with KernelSU. Design and build: [docs](docs/).

The module can follow HMA or HMA-OSS, or run on rules of its own: a config it keeps at
`/data/adb/hma-uidfake/config.json`, edited from a WebUI the KernelSU manager serves out of the
module. There is no Zygisk. The user-space `sync-tool` reads the rules -- whatever format they are in
-- and pushes the resulting pairs to the kernel over the same netlink channel the module already
exposes, so the two layers are the config reader and the syscall hooks, and nothing in between.

GPL-2.0, see [LICENSE](LICENSE).
