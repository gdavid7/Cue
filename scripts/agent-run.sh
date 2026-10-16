#!/usr/bin/env bash
# Run a command without the keys that would ship logs or spend money from a local run:
# Axiom (logs), Exa (search) and paid LLM providers. Session environments can hold
# production values for these; tests and local servers must never use them.
# Usage: scripts/agent-run.sh [--keep-ai] <command> [args...]
#   --keep-ai keeps the LLM provider keys, for AI tests and evals you mean to pay for.
set -euo pipefail

keep_ai=0
if [[ "${1:-}" == "--keep-ai" ]]; then keep_ai=1; shift; fi
(($#)) || { sed -n '5,6p' "$0" >&2; exit 2; }

pattern='^(NEXT_PUBLIC_)?AXIOM_|^EXA_'
if ((!keep_ai)); then
  pattern+='|^ANTHROPIC_|^OPENAI_API_KEY$|^OPENROUTER_API_KEY$|^AI_GATEWAY_API_KEY$|^GOOGLE_API_KEY$|^GOOGLE_VERTEX_|^GROQ_API_KEY$|^PERPLEXITY_API_KEY$|^AZURE_.*API_KEY$|^BEDROCK_'
fi
while read -r name; do unset "$name"; done < <(compgen -e | grep -E "$pattern" || true)
# Not a key, but pointing it elsewhere would route LLM calls through another host.
unset ANTHROPIC_BASE_URL

exec "$@"
