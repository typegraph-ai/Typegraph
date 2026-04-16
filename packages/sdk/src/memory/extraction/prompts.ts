/**
 * Prompt templates for memory extraction.
 * Plain TypeScript string functions - no template engine dependency.
 */

export function factExtractionPrompt(conversation: string, existingFacts?: string): string {
  const existingContext = existingFacts
    ? `\n\nExisting facts about the participants:\n${existingFacts}`
    : ''

  return `Analyze the following conversation and extract discrete factual memories.

For each fact, provide:
- "content": A concise, standalone statement of the fact
- "subject": The entity the fact is about
- "predicate": The relationship or attribute type (e.g., "works_at", "prefers", "lives_in")
- "object": The value or related entity
- "importance": A score from 0.0 to 1.0 indicating how important this fact is to remember
- "confidence": A score from 0.0 to 1.0 indicating how confident you are in this fact

Return a JSON array of facts. If no facts are extractable, return an empty array.
Only extract facts that are clearly stated or strongly implied. Do not speculate.
${existingContext}

Conversation:
${conversation}

Respond with only valid JSON: [{"content": "...", "subject": "...", "predicate": "...", "object": "...", "importance": 0.0, "confidence": 0.0}, ...]`
}

export function entityExtractionPrompt(text: string): string {
  return `Extract all named entities from the following text.

For each entity, provide:
- "name": The canonical name of the entity
- "entityType": The type (one of: "person", "organization", "location", "product", "concept", "tool", "event", "other")
- "aliases": Array of alternative names or spellings mentioned in the text

Return a JSON array of entities. If no entities are found, return an empty array.

Text:
${text}

Respond with only valid JSON: [{"name": "...", "entityType": "...", "aliases": ["..."]}, ...]`
}

export function contradictionCheckPrompt(existingFact: string, newFact: string): string {
  return `Determine if these two facts contradict each other.

Existing fact: ${existingFact}
New fact: ${newFact}

Analyze whether:
1. The new fact directly contradicts the existing fact (e.g., "Alice works at Google" vs "Alice works at Meta")
2. The new fact supersedes the existing fact with updated information
3. The facts are compatible and can coexist

Respond with only valid JSON:
{
  "contradicts": true/false,
  "type": "direct" | "temporal" | "superseded" | "compatible",
  "reasoning": "Brief explanation"
}`
}

export function conflictResolutionPrompt(newFact: string, existingFacts: string): string {
  return `Given a new fact and a list of existing similar facts, decide what operation to perform.

New fact: ${newFact}

Existing similar facts:
${existingFacts}

For each comparison, decide one operation:
- "ADD": The new fact is genuinely new information not covered by any existing fact
- "UPDATE": The new fact augments or refines an existing fact (specify which by index)
- "DELETE": The new fact contradicts an existing fact, making it invalid (specify which by index)
- "NOOP": The new fact is already captured by an existing fact - no action needed

Respond with only valid JSON:
{
  "operation": "ADD" | "UPDATE" | "DELETE" | "NOOP",
  "targetIndex": null | number,
  "reasoning": "Brief explanation"
}`
}

export function proceduralExtractionPrompt(episodes: string): string {
  return `Analyze the following sequence of events/actions and identify any repeating procedural patterns.

For each procedure found, provide:
- "trigger": A description of when/why this procedure is activated
- "steps": An ordered array of steps in the procedure
- "confidence": How confident you are this is a real pattern (0.0 to 1.0)

Return a JSON array of procedures. If no patterns are found, return an empty array.

Events:
${episodes}

Respond with only valid JSON: [{"trigger": "...", "steps": ["..."], "confidence": 0.0}, ...]`
}
