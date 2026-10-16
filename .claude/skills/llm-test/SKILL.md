---
name: llm-test
description: Write tests that call real LLMs (pnpm test-ai) without pinning a provider. Use when adding or changing tests for AI features, prompts or tool calls.
---
Read and follow `.claude/skills/testing/llm.md`.

For normal LLM tests, do not pin fixture users to a specific `aiProvider` / `aiModel`; leave them `null` unless the test is explicitly about model-selection behavior.
