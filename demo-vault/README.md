# Demo vault

Self-contained sample data so you can see Lifelog working **without an API key
and without any private data**.

```
demo-vault/.lifelog/
├─ categories.json        # example taxonomy (time + expense categories)
├─ projects.json          # example project registry
└─ daily/YYYY/YYYY-MM/    # generated structured days (same shape the parser emits)
```

The `daily/*.json` files are produced by `scripts/seed.ts` — a **deterministic**
generator (fixed seed) that fabricates a few months of plausible days while
bypassing the LLM entirely. Regenerate at any time:

```bash
npm run seed            # 75 days ending 2026-06-15 (default)
npm run seed 120        # 120 days
npm run seed 60 2026-12-31
```

Output is byte-identical across runs, so screenshots and CI stay stable.

> This folder is committed on purpose. The plugin author's **real** vault data is
> never in the repo — see `.gitignore`.
