---
name: wait
description: Wait a user-given duration without blocking the session. Use when the user asks you to wait or pause for a set time.
disable-model-invocation: true
---

Wait the duration the user gives (seconds or minutes).

Never sleep in the foreground: it blocks the session and AGENTS.md rules it out.
Run `sleep <seconds>` as a background command and end your turn; its completion
notice resumes you.

If the wait is really for some work to finish (CI, a build, a Playwright run),
background the one command that exits when that work is done instead of a
fixed sleep.
