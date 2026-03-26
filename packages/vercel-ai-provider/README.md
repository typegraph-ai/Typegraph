# @d8um/vercel-ai-provider

Vercel AI SDK integration -- memory tools and middleware for auto-context injection.

## Install

```bash
npm install @d8um/vercel-ai-provider
```

## Usage

### Tools

Pass memory tools directly to `generateText()`:

```ts
import { generateText } from 'ai'
import { d8umMemoryTools } from '@d8um/vercel-ai-provider'

const tools = d8umMemoryTools(memory)

const { text } = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'What do you know about Alice?',
})
```

### Middleware

Auto-inject memory context into prompts:

```ts
import { d8umMemoryMiddleware } from '@d8um/vercel-ai-provider'

const middleware = d8umMemoryMiddleware(memory, {
  includeFacts: true,
  includeEpisodes: true,
  maxMemoryTokens: 2000,
})

const enrichedPrompt = await middleware.enrichPrompt('What should Alice have for dinner?')
const enrichedSystem = await middleware.enrichSystem(systemPrompt, userQuery)
```

## API

| Export | Description |
|--------|-------------|
| `d8umMemoryTools()` | Generate Vercel AI SDK-compatible tool definitions |
| `d8umMemoryMiddleware()` | Create middleware for auto-context injection |

Pure structural typing -- no `ai` or `@ai-sdk/*` imports needed.

### Types

`ToolDefinition`, `MemoryMiddlewareOpts`

## Related

- [d8um main repo](../../README.md)
- [@d8um/memory](../memory/README.md)
