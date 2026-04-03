/**
 * test-memory.ts — Integration test for memory tables + scope isolation.
 *
 * Tests:
 * 1. deploy() creates all memory/entity/edge tables in an isolated Postgres schema
 * 2. Store memories with different identities and visibilities
 * 3. Recall respects user isolation, tenant isolation, cross-tenant isolation
 * 4. Group scoping, visibility enforcement
 * 5. forget() excludes from recall
 * 6. addTriple() creates entities + edges with identity
 * 7. searchEntities() respects scope filtering
 * 8. Cleanup: DROP SCHEMA CASCADE
 *
 * Usage:
 *   cd benchmarks
 *   npx tsx --env-file=.env scripts/test-memory.ts
 */

import { neon } from '@neondatabase/serverless'
import { PgMemoryStoreAdapter, createGraphBridge } from '@d8um-ai/graph'
import type { d8umIdentity } from '@d8um-ai/core'

// ── Config ──

const databaseUrl = process.env.NEON_DATABASE_URL
if (!databaseUrl) {
  console.error('Error: NEON_DATABASE_URL required')
  process.exit(1)
}

const sql = neon(databaseUrl)
const testSchema = `test_mem_${Date.now()}`

console.log(`\n🧪 Memory Integration Test`)
console.log(`   Schema: ${testSchema}\n`)

// ── Test Identities ──

const alice: d8umIdentity = { tenantId: 'acme-corp', userId: 'alice' }
const bob: d8umIdentity = { tenantId: 'acme-corp', userId: 'bob' }
const carol: d8umIdentity = { tenantId: 'globex', userId: 'carol' }
const dave: d8umIdentity = { tenantId: 'globex', userId: 'dave', groupId: 'engineering' }

// ── Helpers ──

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`)
    passed++
  } else {
    console.log(`  ❌ ${msg}`)
    failed++
  }
}

// Minimal mock embedding provider (no real LLM needed for CRUD tests)
function mockEmbedding() {
  let callCount = 0
  return {
    embed: async (_text: string) => {
      callCount++
      // Return a deterministic 4-dim embedding based on call count
      const base = callCount * 0.1
      return [base, base + 0.1, base + 0.2, base + 0.3]
    },
    embedBatch: async (texts: string[]) => {
      return texts.map(() => {
        callCount++
        const base = callCount * 0.1
        return [base, base + 0.1, base + 0.2, base + 0.3]
      })
    },
    dimensions: 4,
    model: 'test-mock-4d',
  }
}

// Minimal mock LLM (only needed for remember/recall which do extraction)
function mockLlm() {
  return {
    generateText: async () => ({ text: 'test response' }),
    generateJSON: async <T>() => ({ object: {} as T }),
  }
}

// ── Main ──

async function main() {
  const sqlExec = (q: string, p?: unknown[]) => sql(q, p as any) as any

  // 1. Create memory store with test schema
  console.log('1. Deploy memory tables')

  // Wrap SQL executor with error tracing for debugging
  const tracedSql = async (q: string, p?: unknown[]) => {
    try {
      return await sqlExec(q, p)
    } catch (e: any) {
      console.error(`  SQL error at position ${e.position}:`, q.substring(0, 120))
      throw e
    }
  }

  const memoryStore = new PgMemoryStoreAdapter({
    sql: tracedSql,
    schema: testSchema,
    embeddingDimensions: 4,
  })

  await memoryStore.initialize()

  // Verify tables exist
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${testSchema}
    ORDER BY table_name
  `
  const tableNames = tables.map((r: any) => r.table_name)
  assert(tableNames.includes('d8um_memories'), 'memories table created')
  assert(tableNames.includes('d8um_semantic_entities'), 'entities table created')
  assert(tableNames.includes('d8um_semantic_edges'), 'edges table created')

  // Verify indexes exist
  const indexes = await sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = ${testSchema}
    ORDER BY indexname
  `
  const indexNames = indexes.map((r: any) => r.indexname)
  assert(indexNames.some((n: string) => n.includes('tenant_user')), 'composite tenant+user index exists')
  assert(indexNames.some((n: string) => n.includes('visibility')), 'visibility index exists')

  // 2. Store memories with different identities
  console.log('\n2. Store memories with different identities')

  // Alice stores a user-private memory
  const alicePrivate = await memoryStore.upsert({
    id: 'alice-private-1',
    category: 'semantic',
    status: 'active',
    content: 'Alice prefers dark mode in all applications.',
    importance: 0.8,
    accessCount: 0,
    lastAccessedAt: new Date(),
    metadata: {},
    scope: alice,
    visibility: 'user',
    validAt: new Date(),
    createdAt: new Date(),
  })
  assert(alicePrivate.id === 'alice-private-1', 'Alice private memory stored')

  // Alice stores a tenant-shared memory
  const aliceTenant = await memoryStore.upsert({
    id: 'alice-tenant-1',
    category: 'semantic',
    status: 'active',
    content: 'Acme Corp uses TypeScript for all projects.',
    importance: 0.9,
    accessCount: 0,
    lastAccessedAt: new Date(),
    metadata: {},
    scope: alice,
    visibility: 'tenant',
    validAt: new Date(),
    createdAt: new Date(),
  })
  assert(aliceTenant.id === 'alice-tenant-1', 'Alice tenant memory stored')

  // Bob stores a user-private memory
  const bobPrivate = await memoryStore.upsert({
    id: 'bob-private-1',
    category: 'semantic',
    status: 'active',
    content: 'Bob is working on the billing module.',
    importance: 0.7,
    accessCount: 0,
    lastAccessedAt: new Date(),
    metadata: {},
    scope: bob,
    visibility: 'user',
    validAt: new Date(),
    createdAt: new Date(),
  })
  assert(bobPrivate.id === 'bob-private-1', 'Bob private memory stored')

  // Carol stores a user-private memory (different tenant)
  const carolPrivate = await memoryStore.upsert({
    id: 'carol-private-1',
    category: 'semantic',
    status: 'active',
    content: 'Carol manages the Globex supply chain.',
    importance: 0.8,
    accessCount: 0,
    lastAccessedAt: new Date(),
    metadata: {},
    scope: carol,
    visibility: 'user',
    validAt: new Date(),
    createdAt: new Date(),
  })
  assert(carolPrivate.id === 'carol-private-1', 'Carol private memory stored')

  // Dave stores a group-scoped memory
  const daveGroup = await memoryStore.upsert({
    id: 'dave-group-1',
    category: 'semantic',
    status: 'active',
    content: 'Engineering team standup is at 9am daily.',
    importance: 0.9,
    accessCount: 0,
    lastAccessedAt: new Date(),
    metadata: {},
    scope: dave,
    visibility: 'group',
    validAt: new Date(),
    createdAt: new Date(),
  })
  assert(daveGroup.id === 'dave-group-1', 'Dave group memory stored')

  // 3. Test user isolation
  console.log('\n3. User isolation')
  const aliceMemories = await memoryStore.list({ userId: 'alice' })
  assert(aliceMemories.length === 2, `Alice sees 2 memories (got ${aliceMemories.length})`)
  assert(aliceMemories.every(m => m.scope.userId === 'alice'), 'All Alice memories belong to her')

  // 4. Test tenant isolation
  console.log('\n4. Tenant isolation')
  const acmeMemories = await memoryStore.list({ tenantId: 'acme-corp' })
  assert(acmeMemories.length === 3, `Acme has 3 memories (got ${acmeMemories.length})`)

  const globexMemories = await memoryStore.list({ tenantId: 'globex' })
  assert(globexMemories.length === 2, `Globex has 2 memories (got ${globexMemories.length})`)

  // 5. Cross-tenant isolation
  console.log('\n5. Cross-tenant isolation')
  const carolView = await memoryStore.list({ tenantId: 'globex', userId: 'carol' })
  const hasAcmeContent = carolView.some(m => m.content.includes('Acme') || m.scope.tenantId === 'acme-corp')
  assert(!hasAcmeContent, 'Carol cannot see Acme memories')

  // 6. Group scoping
  console.log('\n6. Group scoping')
  const engMemories = await memoryStore.list({ groupId: 'engineering' })
  assert(engMemories.length === 1, `Engineering group has 1 memory (got ${engMemories.length})`)
  assert(engMemories[0]!.content.includes('standup'), 'Engineering memory is the standup reminder')

  // 7. Visibility filtering
  console.log('\n7. Visibility filtering')
  const tenantVisible = await memoryStore.list({ tenantId: 'acme-corp', visibility: 'tenant' })
  assert(tenantVisible.length === 1, `1 tenant-visible Acme memory (got ${tenantVisible.length})`)
  assert(tenantVisible[0]!.content.includes('TypeScript'), 'Tenant-visible memory is about TypeScript')

  const userVisible = await memoryStore.list({ tenantId: 'acme-corp', visibility: 'user' })
  assert(userVisible.length === 2, `2 user-visible Acme memories (got ${userVisible.length})`)

  // 8. forget() — invalidate and verify excluded
  console.log('\n8. forget() / invalidate')
  await memoryStore.invalidate('alice-private-1')
  const afterForget = await memoryStore.list({ userId: 'alice', status: 'active' })
  assert(afterForget.length === 1, `Alice has 1 active memory after forget (got ${afterForget.length})`)
  assert(afterForget[0]!.id === 'alice-tenant-1', 'Remaining active memory is the tenant one')

  // Verify invalidated record still exists
  const invalidated = await memoryStore.get('alice-private-1')
  assert(invalidated?.status === 'invalidated', 'Invalidated memory preserved with status')

  // 9. Entity + Edge creation with identity
  console.log('\n9. Entity + edge creation')
  const entity1 = await memoryStore.upsertEntity({
    id: 'entity-alice-1',
    name: 'Alice Johnson',
    entityType: 'person',
    aliases: ['AJ'],
    properties: {},
    scope: alice,
    visibility: 'tenant',
    temporal: { validAt: new Date(), createdAt: new Date() },
  })
  assert(entity1.id === 'entity-alice-1', 'Entity created with identity')
  assert(entity1.visibility === 'tenant', 'Entity visibility is tenant')

  const entity2 = await memoryStore.upsertEntity({
    id: 'entity-acme-1',
    name: 'Acme Corp',
    entityType: 'organization',
    aliases: ['Acme'],
    properties: {},
    scope: alice,
    visibility: 'tenant',
    temporal: { validAt: new Date(), createdAt: new Date() },
  })

  const edge1 = await memoryStore.upsertEdge({
    id: 'edge-1',
    sourceEntityId: 'entity-alice-1',
    targetEntityId: 'entity-acme-1',
    relation: 'WORKS_AT',
    weight: 1.0,
    properties: {},
    scope: alice,
    visibility: 'tenant',
    evidence: [],
    temporal: { validAt: new Date(), createdAt: new Date() },
  })
  assert(edge1.id === 'edge-1', 'Edge created with identity')
  assert(edge1.visibility === 'tenant', 'Edge visibility is tenant')

  // Verify entity read-back has correct identity
  const readEntity = await memoryStore.getEntity('entity-alice-1')
  assert(readEntity?.scope.tenantId === 'acme-corp', 'Entity scope.tenantId persisted')
  assert(readEntity?.scope.userId === 'alice', 'Entity scope.userId persisted')

  // 10. Entity scope filtering via findEntities
  console.log('\n10. Entity scope filtering')
  const acmeEntities = await memoryStore.findEntities('Alice', { tenantId: 'acme-corp' })
  assert(acmeEntities.length >= 1, `Found Alice entity in Acme scope (got ${acmeEntities.length})`)

  const globexEntities = await memoryStore.findEntities('Alice', { tenantId: 'globex' })
  assert(globexEntities.length === 0, `Alice entity not visible in Globex scope (got ${globexEntities.length})`)

  // Edge retrieval
  const edges = await memoryStore.getEdges('entity-alice-1', 'out')
  assert(edges.length === 1, `Alice has 1 outgoing edge (got ${edges.length})`)
  assert(edges[0]!.relation === 'WORKS_AT', 'Edge relation is WORKS_AT')

  // 11. Cleanup
  console.log('\n11. Cleanup')
  await sql(`DROP SCHEMA ${testSchema} CASCADE`)
  const afterCleanup = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${testSchema}
  `
  assert(afterCleanup.length === 0, 'Schema dropped cleanly')

  // Summary
  console.log(`\n${'═'.repeat(50)}`)
  console.log(`  Results: ${passed} passed, ${failed} failed`)
  console.log(`${'═'.repeat(50)}\n`)

  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('Fatal error:', err)
  // Try to clean up schema on error
  sql(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`).catch(() => {})
  process.exit(1)
})
