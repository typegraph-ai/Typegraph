# @d8um/embedding-local

Local embedding provider for d8um. Wraps [fastembed](https://github.com/Anush008/fastembed-js) + ONNX Runtime to run embeddings entirely on-device -- no API keys, no network calls.

Default model: **BAAI/bge-small-en-v1.5** (MIT license, 33M params, 384 dimensions, ~32MB download on first use).

## Install

```bash
npm install @d8um/embedding-local @d8um/core
```

## Usage

```ts
import { LocalEmbeddingProvider } from '@d8um/embedding-local'
import { d8um } from '@d8um/core'

const embeddings = new LocalEmbeddingProvider()

const agent = await d8um.initialize({
  embeddings,
  // ... adapter, etc.
})
```

To use a different model:

```ts
import { LocalEmbeddingProvider, EmbeddingModel } from '@d8um/embedding-local'

const embeddings = new LocalEmbeddingProvider({
  model: EmbeddingModel.BGEBaseENV15, // 768 dimensions
})
```

## Exports

| Export | Description |
|--------|-------------|
| `LocalEmbeddingProvider` | Main provider class, implements `EmbeddingProvider` |
| `EmbeddingModel` | Enum of supported models (re-exported from fastembed) |

## Types

| Type | Description |
|------|-------------|
| `LocalEmbeddingConfig` | Constructor options (`model`, `dimensions`) |

## Related

- [d8um main repo](../..)
- [Local Dev Guide](../../guides/Local%20Dev/getting-started.md)
