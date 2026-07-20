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
  async" requires both). If a query returns nothing, drop to fewer/more
  distinctive terms rather than rephrasing into a sentence.
- **`recent_history`** — time-based recall with no good keyword ("what was I
  reading this morning?"). `days` accepts fractions (0.5 = last 12 h).
- **`get_page_text`** — full readable text by page id. Reach for it only when
  the title/summary/snippet isn't enough (quoting, summarizing a specific
  article); it can return tens of KB.

## Answering recall questions

1. Search with 2–3 distinctive content words; add `from`/`to` (ISO dates) when
   the user names a time frame.
2. Present matches as title + URL + visit date so the user can confirm which
   one they meant. Include the URL — re-finding the page is usually the goal.
3. Ambiguous match → show the top few candidates and ask, don't guess.
4. No matches → say so plainly. Only pages visited while a WTM extension was
   installed and syncing exist; there is no history before that.

## Server not connected?

If no `wtm` MCP tools are available, the user needs to add the server
(one-time, using their Web Time Machine login token):

    claude mcp add --transport http wtm https://api.webtm.io/mcp \
      --header "Authorization: Bearer <WTM_JWT>"

A token comes from `POST https://api.webtm.io/auth/login` with their email +
password (the response's `token` field). Never handle the password yourself —
have the user obtain the token.
