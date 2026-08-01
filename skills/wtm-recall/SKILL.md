---
name: wtm-recall
description: >-
  Recall pages from the user's browsing history via the Web Time Machine MCP
  server (tools: search_history, recent_history, get_page_text). Use whenever
  the user asks "what was that article/page/site I read about X", "where did I
  see X", "what was I reading yesterday/last week", or wants to quote, cite, or
  re-find something they browsed on any of their devices.
---

# Web Time Machine recall

Web Time Machine passively captures every page the user visits (URL, title,
timestamp, readable text) across all their devices. The `wtm` MCP server
exposes their history for recall. All results are scoped to the authenticated
user; pages flagged sensitive are excluded unless explicitly requested.

## Choosing a tool

- **`search_history`** — default entry point. Content words work best; search
  terms are prefix-matched and AND-ed ("compost" matches "composting"; "rust
  async" requires both). Narrow with `from` / `to` whenever the user knows the
  approximate time, and with `site` when they remember where they read it.
  Use `sort: "newest"` for recent or broad searches and `sort: "oldest"` when
  they are looking for the first occurrence. If a query returns nothing, drop
  to fewer or more distinctive terms instead of rephrasing it as a sentence.
- **`recent_history`** — time-based recall with no good keyword ("what was I
  reading this morning?"). `days` accepts fractions (0.5 = last 12 hours).
- **`get_page_text`** — full readable text by page id. Use it only when the
  title, summary, and snippet are insufficient, such as quoting or summarizing
  a specific article.

## Answering recall questions

1. Search with two or three distinctive content words. Add `from` or `to` ISO
   dates when the user names a time frame, even approximately. Add `site` for
   a remembered publisher or domain; a hostname or pasted URL both work.
2. Present matches as title, URL, and visit date so the user can confirm the
   page. Include the URL because re-finding the page is usually the goal.
3. If results are ambiguous, show the top candidates and ask instead of
   guessing.
4. If nothing matches, say so plainly. Only pages visited while a Web Time
   Machine extension was installed, signed in, and syncing can be recalled.

## Connect the server

The MCP URL is `https://api.webtm.io/mcp`.

- **Codex CLI, IDE, or desktop:** add the Streamable HTTP server, then complete
  its OAuth login:

      codex mcp add wtm --url https://api.webtm.io/mcp
      codex mcp login wtm

- **Claude.ai or Claude Desktop:** add a custom connector using the MCP URL,
  then sign in with the user's Web Time Machine account in the OAuth window.
- **Claude Code with a direct session token:**

      claude mcp add --transport http wtm https://api.webtm.io/mcp \
        --header "Authorization: Bearer <WTM_SESSION_TOKEN>"

  A session token comes from `POST https://api.webtm.io/auth/login`. Treat it
  like a password. Never ask the user to paste their account password into a
  chat or tool call; have them obtain and configure the token themselves.
