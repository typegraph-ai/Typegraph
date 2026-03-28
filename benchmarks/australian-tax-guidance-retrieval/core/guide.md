# Australian Tax Guidance Retrieval — Core (Hybrid Search)

## Dataset

**Source:** [isaacus/australian-tax-guidance-retrieval](https://huggingface.co/datasets/isaacus/australian-tax-guidance-retrieval)

Australian tax guidance documentation covering tax rates, international agreements, GST, capital gains, and superannuation.

| Split | Rows | Description |
|-------|------|-------------|
| corpus | 105 | Tax guidance documents |
| queries | 112 | Tax-related questions |
| qrels | 112 | Relevance judgments |

## Running

```bash
# From benchmarks/ directory
npx tsx --env-file=.env australian-tax-guidance-retrieval/core/run.ts --seed    # first run
npx tsx --env-file=.env australian-tax-guidance-retrieval/core/run.ts           # subsequent
```

## What it measures

- Hybrid search (vector + BM25, RRF fusion) on domain-specific legal/tax content
- Small corpus — tests precision on focused documents rather than scale
- Baseline for comparing neural variant (graph-augmented) performance
