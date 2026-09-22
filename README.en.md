# mcp-web

**MCP server for web automation on Termux** — open pages, click, fill forms, inspect the DOM, and debug right from your AI. Pure Node.js, built from scratch: no Chromium, no root, no proot, no desktop app.

[![Version](https://img.shields.io/badge/version-1.1.0-blue)](package.json) [![Tests](https://img.shields.io/badge/tests-30%20pass-green)]() [![License](https://img.shields.io/badge/license-MIT-brightgreen)](LICENSE)

---

## What is this?

`mcp-web` is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives your AI (e.g. opencode) **web automation** capabilities. It is built **entirely from scratch**: the JSON-RPC/MCP protocol, both the stdio and HTTP/SSE transports, and the page engine are all hand-written — with a single runtime dependency, `linkedom` (a lightweight, pure-JavaScript DOM parser).

Everything runs in an ordinary Termux terminal. No heavy browser engine, no root access, no proot/container, no X11/desktop.

## Features

- **Two transports**:
  - `stdio` — for local opencode on Termux (default).
  - `serve` — remote HTTP + SSE mode; usable from other devices on your network.
- **14 MCP tools** for web automation & debugging:

| Tool | Purpose |
|---|---|
| `navigate` | Open a web page (fetch + parse DOM) |
| `get_content` | View page content: text, HTML, or summary |
| `query` | Find elements with a CSS selector |
| `click` | Click links (follow navigation) / buttons / checkboxes |
| `fill` | Fill inputs, textareas, selects |
| `submit` | Submit forms (GET is followed, POST is recorded) |
| `wait` | Pause between steps |
| `js_eval` | Evaluate JavaScript expressions in page context (sandboxed `vm`) |
| `console_get` | Console logs captured during the session |
| `network_logs` | Request/response history (URL, status, timing) |
| `cookies` | List / clear session cookies |
| `history` | Navigation history + back/forward |
| `screenshot` | Structural snapshot of the page (text / HTML) |
| `reset` | Reset the entire session |

- **Session state**: cookie store, history, network log, console log — consistent across tool calls.
- **Safe by design**: `navigate` accepts only http/https, `js_eval` runs in an isolated `vm` with a timeout, and page size is capped at 5 MB to avoid memory abuse.
- **Fully testable offline**: the whole test suite runs against a local HTTP server, no external network required.

## Installation

Requirements: **Node.js ≥ 20** on Termux (`pkg install nodejs`) and npm.

```bash
cd ~
git clone https://github.com/nemoobc/mcp-web.git
cd mcp-web
npm install
```

> No root, no proot, no Chromium — plain Node.js is enough.

## Usage

### 1. Local mode (stdio) for opencode

Add the MCP server to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "mcp-web": {
      "type": "stdio",
      "command": "node",
      "args": ["/data/data/com.termux/files/home/mcp-web/bin/mcp-web.js", "stdio"]
    }
  }
}
```

### 2. Remote mode (HTTP + SSE) from another device

On Termux:

```bash
node bin/mcp-web.js serve --port 3827
```

On another device (e.g. your PC/laptop), register the remote URL in opencode:

```json
{
  "mcp": {
    "mcp-web": {
      "type": "remote",
      "url": "http://YOUR_TERMUX_IP:3827/sse"
    }
  }
}
```

Health check: `curl http://localhost:3827/health` → `{"ok":true,...}`.

## Example flow

```
navigate  → https://example.com
query     → a, button, input
click     → a                       (follow the link)
get_content → text                  (read target page content)
history   → back
submit    → #search                 (GET form is followed)
network_logs →                      (debug request/response)
```

## Limitations (stated honestly)

Because it runs **without Chromium**, `mcp-web` does not perform pixel-perfect visual rendering, full page JavaScript execution, or CSS layout. What you get instead is:

- The real DOM parsed from HTML (fast & lightweight parsing).
- Navigation, clicking, form filling, and DOM traversal.
- JavaScript execution through a safe `vm` sandbox (expressions, not a renderer).
- **Structural** snapshots (text / HTML / metadata) — not bitmap images.

For heavily rendered pages (complex SPAs, canvas, WebGL), use a real browser when available. `mcp-web` excels at: web content research, page structure testing, scraping, and HTTP/DOM debugging from the terminal.

## Project structure

```
mcp-web/
├── bin/mcp-web.js        # CLI entry (stdio / serve)
├── src/
│   ├── protocol.js       # JSON-RPC 2.0 + MCP protocol (pure, no deps)
│   ├── stdio.js          # stdio transport
│   ├── http.js           # HTTP + SSE transport (remote)
│   ├── browser.js        # page engine (fetch + DOM model)
│   └── tools.js          # 14 MCP tool registrations
└── tests/                # automated tests (node --test, offline)
```

## Development

```bash
npm test        # run the whole suite (30 tests, offline)
npm start       # run the remote server on port 3827
```

## License

[MIT](LICENSE) © 2026 Nemo.

---

Hand-built, from scratch. Created by **Nemo**.