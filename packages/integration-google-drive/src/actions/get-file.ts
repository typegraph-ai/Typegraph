import { z } from 'zod'
import type { ApiClient } from '@d8um-ai/core'
import { GoogleDriveFileSchema } from '../models.js'

export const GetFileInput = z.object({
  fileId: z.string().describe('The ID of the file to retrieve'),
  fields: z.string().optional().describe('Comma-separated list of fields to include'),
})

export const GetFileOutput = GoogleDriveFileSchema

export async function getFile(
  client: ApiClient,
  input: z.infer<typeof GetFileInput>,
): Promise<z.infer<typeof GetFileOutput>> {
  // const fields = input.fields ?? 'id,name,mimeType,size,webViewLink,webContentLink,createdTime,modifiedTime,owners,parents,trashed,shared'
  //
  // const response = await client.get<GoogleDriveFileGetResponse>(
  //   `/drive/v3/files/${input.fileId}`,
  //   { fields }
  // )
  //
  // return toGoogleDriveFile(response.data)

  throw new Error('GoogleDriveIntegration getFile is not yet implemented')
}
