import { list } from '@vercel/blob'

export interface BeirCorpusRow {
  _id: string
  title: string
  text: string
}

async function fetchBlobJson<T>(blobPath: string): Promise<T> {
  const { blobs } = await list({ prefix: blobPath, limit: 1 })
  const blob = blobs.find(b => b.pathname === blobPath)
  if (!blob) {
    throw new Error(`Dataset not found in blob storage: ${blobPath}`)
  }
  const res = await fetch(blob.downloadUrl, {
    headers: process.env.BLOB_READ_WRITE_TOKEN
      ? { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }
      : {},
  })
  if (!res.ok) {
    throw new Error(`Failed to download ${blobPath}: ${res.status}`)
  }
  return res.json() as Promise<T>
}

export async function loadCorpus(dataset: string, blobPrefix: string): Promise<BeirCorpusRow[]> {
  console.log(`  Loading ${dataset}/corpus from blob storage...`)
  const rows = await fetchBlobJson<BeirCorpusRow[]>(`${blobPrefix}/${dataset}/corpus.json`)
  console.log(`  ${rows.length.toLocaleString()} corpus documents`)
  return rows
}

export async function loadBlobDirect<T>(blobPath: string, label: string): Promise<T> {
  console.log(`  Loading ${label} from ${blobPath}...`)
  const data = await fetchBlobJson<T>(blobPath)
  const count = Array.isArray(data) ? data.length : 0
  console.log(`  ${count.toLocaleString()} ${label}`)
  return data
}
