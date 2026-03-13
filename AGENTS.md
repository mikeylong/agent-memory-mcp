# Agent Guidance

Use `memory_get_context` as the default retrieval tool for normal turn preparation in this repository.

Use `memory_search` for explicit lookup, especially when you need targeted retrieval or when you want to opt into broader search with `scope_mode="all"`.
Generic retrieval de-prioritizes noisy global captured/import transcript memories and only backfills them when cleaner matches are insufficient.

Use `memory_search_compact` only when:
- the user explicitly asks for compact search
- a payload-size or tool-output constraint makes a compact fallback necessary

Do not treat `memory_search_compact` as the normal safe default in rich-client chats.
