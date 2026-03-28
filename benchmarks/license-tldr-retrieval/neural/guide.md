# License TLDR Retrieval — Neural (Graph Search)

## Dataset

Same as core — see [core/guide.md](../core/guide.md) for dataset details.

## Running

```bash
npx tsx --env-file=.env license-tldr-retrieval/neural/run.ts --seed
npx tsx --env-file=.env license-tldr-retrieval/neural/run.ts
```

## What it measures

- Whether knowledge graph helps bridge the gap between TLDR descriptions and full license texts
- Entity extraction on license-specific terminology
- PPR graph traversal effectiveness on small, specialized corpora
- Impact of knowledge graph on retrieval quality vs pure hybrid search
