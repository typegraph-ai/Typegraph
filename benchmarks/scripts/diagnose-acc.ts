#!/usr/bin/env npx tsx
/**
 * Diagnostic: investigate why ACC is 0.05-0.08 vs published 0.40-0.65
 * Shows retrieval → answer gen → scoring for 10 sample queries.
 */

import { gateway } from '@ai-sdk/gateway'
import { generateText } from 'ai'
import { getConfig } from '../lib/config.js'
import { initCore, resolveBucket, loadDataset } from '../lib/runner.js'
import { substringAccuracy, exactMatch, tokenF1 } from '../lib/metrics.js'

const config = getConfig('graphrag-bench-novel/core')

async function main() {
  const { d } = await initCore(config)
  const { bucket } = await resolveBucket(d, config.bucketName, false)
  const { testQueries, goldAnswers } = await loadDataset(config, true)
  const answers = goldAnswers!

  const sample = testQueries.filter(q => answers.has(String(q['_id']))).slice(0, 10)

  let totalACC = 0, totalEM = 0, totalF1 = 0

  for (const query of sample) {
    const queryId = String(query['_id'])
    const queryText = String(query['text'])
    const gold = answers.get(queryId)!

    console.log('\n' + '='.repeat(80))
    console.log('QUERY [' + queryId + ']: ' + queryText.slice(0, 150))
    console.log('GOLD: ' + gold)

    const response = await d.query(queryText, { signals: { vector: true, keyword: true }, count: 50, buckets: [bucket.id] })

    console.log('\nTOP 3 CHUNKS:')
    for (let i = 0; i < Math.min(3, response.results.length); i++) {
      const r = response.results[i]!
      const preview = r.content.replace(/\n/g, ' ').slice(0, 200)
      console.log(`  [${i}] score=${Number(r.score ?? 0).toFixed(4)} | ${preview}...`)
    }

    // Does the gold answer appear in ANY of the top 6 chunks?
    const top6 = response.results.slice(0, 6)
    const goldNorm = gold.toLowerCase()
    const chunkContainsGold = top6.some(r => r.content.toLowerCase().includes(goldNorm))
    console.log('\nGold answer in top-6 chunks? ' + (chunkContainsGold ? 'YES' : 'NO'))

    const chunks = top6.map(r => r.content)
    const context = chunks.join('\n\n---\n\n')
    const { text: predicted } = await generateText({
      model: gateway('openai/gpt-5.4-mini'),
      prompt: `Answer the question based only on the provided context. Be concise.\n\nContext:\n${context}\n\nQuestion: ${queryText}\n\nAnswer:`,
    })

    const normPred = predicted.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
    const normGold = gold.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()

    const acc = substringAccuracy(predicted, gold)
    const em = exactMatch(predicted, gold)
    const f1 = tokenF1(predicted, gold)

    totalACC += acc
    totalEM += em
    totalF1 += f1

    console.log('\nPREDICTED: ' + predicted)
    console.log('\nnorm_pred: "' + normPred.slice(0, 200) + '"')
    console.log('norm_gold: "' + normGold + '"')
    console.log('ACC=' + acc + ' (pred includes gold? ' + normPred.includes(normGold) + ')')
    console.log('EM=' + em + ' F1=' + f1.toFixed(3))
  }

  console.log('\n' + '='.repeat(80))
  console.log('SUMMARY (10 queries):')
  console.log('  ACC=' + (totalACC / 10).toFixed(3))
  console.log('  EM=' + (totalEM / 10).toFixed(3))
  console.log('  F1=' + (totalF1 / 10).toFixed(3))
}

main().catch(e => { console.error(e); process.exit(1) })
