# Token/Cost tracking

This OpenClaw deployment writes per-message usage into session JSONL logs:

- `/data/.clawdbot/agents/<agentId>/sessions/<sessionId>.jsonl`

We can aggregate these logs and estimate USD spend.

## Script

`scripts/costs.mjs`

Examples:

```bash
# Today (Berlin time window) with cached/fetched OpenRouter pricing
node scripts/costs.mjs today --tz Europe/Berlin --fetch-prices

# Last 7 days
node scripts/costs.mjs week --tz Europe/Berlin --fetch-prices

# Ever
node scripts/costs.mjs ever --tz Europe/Berlin --fetch-prices

# Custom range (inclusive local dates)
node scripts/costs.mjs range 2026-02-01 2026-02-06 --tz Europe/Berlin --fetch-prices

# JSON output
node scripts/costs.mjs today --tz Europe/Berlin --fetch-prices --json
```

## Notes / limitations

- OpenClaw’s stored `usage.cost.total` is currently **0** in our logs, so we compute **estimated** cost from OpenRouter model pricing.
- We fetch prices from `https://openrouter.ai/api/v1/models` using `OPENROUTER_API_KEY`.
- Price cache is stored at `scripts/openrouter-prices.json`.
- Cache read/write tokens are reported, but pricing is estimated only for **prompt (input)** and **completion (output)** tokens (OpenRouter typically prices those).
