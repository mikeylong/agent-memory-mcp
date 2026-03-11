# Agent Guidance

Use `memory_search` as the default retrieval tool in this repository.

Use `memory_search_compact` only when:
- the user explicitly asks for compact search
- a payload-size or tool-output constraint makes a compact fallback necessary

Do not treat `memory_search_compact` as the normal safe default in rich-client chats.
