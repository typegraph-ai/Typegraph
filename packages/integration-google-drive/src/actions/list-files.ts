import { z } from 'zod'
import type { ApiClient } from '@d8um-ai/core'
import { GoogleDriveFileSchema } from '../models.js'

export const ListFilesInput = z.object({
  query: z.string().optional().describe('Search query (Drive API q parameter)'),
  folderId: z.string().optional().describe('Folder ID to list files from'),
  mimeType: z.string().optional().describe('Filter by MIME type'),
  maxResults: z.number().optional().describe('Max files to return'),
  orderBy: z.string().optional().describe('Sort order (e.g. modifiedTime desc)'),
})

export const ListFilesOutput = z.object({
  files: z.array(GoogleDriveFileSchema),
  total: z.number(),
})

export async function listFiles(
  client: ApiClient,
  input: z.infer<typeof ListFilesInput>,
): Promise<z.infer<typeof ListFilesOutput>> {
  // const files: GoogleDriveFile[] = []
  // let pageToken: string | undefined
  //
  // const queryParts: string[] = ['trashed = false']
  // if (input.folderId) queryParts.push(`'${input.folderId}' in parents`)
  // if (input.mimeType) queryParts.push(`mimeType = '${input.mimeType}'`)
  // if (input.query) queryParts.push(`fullText contains '${input.query}'`)
  //
  // do {
  //   const response = await client.get<GoogleDriveFilesListResponse>(
  //     '/drive/v3/files',
  //     {
  //       q: queryParts.join(' and '),
  //       fields: 'nextPageToken,files(id,name,mimeType,size,webViewLink,webContentLink,createdTime,modifiedTime,owners,parents,trashed,shared)',
  //       pageSize: '100',
  //       ...(input.orderBy ? { orderBy: input.orderBy } : {}),
  //       ...(pageToken ? { pageToken } : {}),
  //     }
  //   )
  //
  //   for (const file of response.data.files) {
  //     files.push(toGoogleDriveFile(file))
  //     if (input.maxResults && files.length >= input.maxResults) break
  //   }
  //
  //   pageToken = response.data.nextPageToken
  // } while (pageToken && (!input.maxResults || files.length < input.maxResults))
  //
  // return { files, total: files.length }

  throw new Error('GoogleDriveIntegration listFiles is not yet implemented')
}
