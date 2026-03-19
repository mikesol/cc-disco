---
name: browser
description: Headless browser automation via agent-browser CLI. Use for any web interaction: filling forms, clicking buttons, scraping, navigating multi-step flows.
---

# Browser Automation (agent-browser)

Persistent daemon-based browser CLI. The browser stays alive between Bash calls within a turn, so you can chain commands without restarting.

## Installation

```bash
npm install -g agent-browser
# or: pnpm add -g agent-browser
```

Also needs a Chromium/Chrome executable. If using Playwright's bundled Chromium:
```bash
npx playwright install chromium
```

## Environment

Set `AGENT_BROWSER_EXECUTABLE_PATH` to your Chromium binary if not using the system default:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH=/path/to/chrome
```

Example with Playwright's headless shell (path varies by platform and version):
```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.cache/ms-playwright/chromium_headless_shell-1208/chrome-linux/headless_shell"
```

## Starting the daemon

On Linux systems without a sandbox, start with `--args "--no-sandbox"`:

```bash
agent-browser --args "--no-sandbox" open https://example.com
```

Subsequent commands in the same turn don't need the flag — daemon is already running.

On macOS or systems with user namespaces, you can omit the flag:
```bash
agent-browser open https://example.com
```

## Core workflow

```bash
agent-browser open https://example.com
agent-browser snapshot          # Get accessibility tree with refs (@e1, @e2, ...)
agent-browser click @e2         # Click by ref
agent-browser fill @e3 "text"   # Fill input by ref
agent-browser find role button click --name "Submit"   # Semantic click
agent-browser find text "Sign in" click
agent-browser wait --text "Welcome"    # Wait for text to appear
agent-browser wait --url "**/dashboard"
agent-browser get url
agent-browser get title
agent-browser screenshot /tmp/shot.png
agent-browser close
```

## Waiting

```bash
agent-browser wait --text "First Name:"        # Wait for text on page
agent-browser wait --load networkidle          # Wait for network idle
agent-browser wait --fn "!location.href.includes('#eSafeID')"  # JS condition
agent-browser wait 2000                        # Wait 2 seconds
```

## Batch (entire flow in one Bash call)

```bash
echo '[
  ["open", "https://example.com"],
  ["snapshot"],
  ["click", "@e1"],
  ["wait", "--text", "Done"]
]' | agent-browser batch --json
```

## Gotchas

- **Always snapshot before clicking by ref** — refs are assigned fresh each time and don't persist across navigations
- **`--args "--no-sandbox"` only works on daemon start** — if daemon is already running with wrong flags, `close` first
- **Forms with `<input type="submit">`** — use `find role button click --name "Continue"` or `find text "Continue" click` rather than `button:has-text()` selectors
- **SPA navigation** — after clicking something that triggers a JS navigation (not a full page load), use `wait --load networkidle` before snapshotting

## Closing

```bash
agent-browser close
```

Always close at end of turn if you don't need state to persist (frees resources). If you DO need state to persist to the next turn (e.g. waiting for user action), leave it open — the daemon survives between turns.
