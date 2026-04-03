import type { JobTypeDefinition, JobRunContext, RawDocument, JobRunResult } from '@d8um-ai/core'

/**
 * Fetches files from Google Drive.
 *
 * High-level flow:
 * 1. Build a query (q parameter) to filter files
 * 2. Paginate through files.list using pageToken
 * 3. Filter out trashed files unless configured otherwise
 * 4. Transform each file into a RawDocument via toFileDocument mapper
 * 5. For Google Docs/Sheets/Slides, could export content via files.export
 * 6. Yield each document
 */
export const filesJob: JobTypeDefinition = {
  type: 'google_drive_files',
  label: 'Google Drive: Files',
  description: 'Fetches files from Google Drive',
  category: 'ingestion',
  requiresBucket: true,
  available: true,
  entity: 'GoogleDriveFile',
  schedule: 'daily',
  syncMode: 'full',
  scopes: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file',
  ],
  configSchema: [
    {
      key: 'folder_id',
      label: 'Root Folder ID',
      type: 'text',
      required: false,
      placeholder: 'Folder ID to sync (empty = entire drive)',
    },
    {
      key: 'include_trashed',
      label: 'Include Trashed Files',
      type: 'boolean',
      required: false,
    },
    {
      key: 'mime_types',
      label: 'MIME Type Filter',
      type: 'text',
      required: false,
      placeholder: 'application/pdf,application/vnd.google-apps.document',
    },
    {
      key: 'max_files',
      label: 'Max Files to Fetch',
      type: 'number',
      required: false,
      placeholder: '10000',
    },
  ],

  async run(ctx: JobRunContext): Promise<JobRunResult> {
    // 1. Build the query string for files.list
    //    const queryParts: string[] = []
    //
    //    if (!ctx.job.config.include_trashed) {
    //      queryParts.push('trashed = false')
    //    }
    //
    //    if (ctx.job.config.folder_id) {
    //      queryParts.push(`'${ctx.job.config.folder_id}' in parents`)
    //    }
    //
    //    if (ctx.job.config.mime_types) {
    //      const types = (ctx.job.config.mime_types as string).split(',').map(s => s.trim())
    //      const mimeQuery = types.map(t => `mimeType = '${t}'`).join(' or ')
    //      queryParts.push(`(${mimeQuery})`)
    //    }
    //
    //    const q = queryParts.join(' and ')
    //
    // 2. Paginate through files.list
    //    let pageToken: string | undefined
    //    let fileCount = 0
    //    const maxFiles = ctx.job.config.max_files as number | undefined
    //
    //    do {
    //      const response = await ctx.client!.get<GoogleDriveFilesListResponse>(
    //        '/drive/v3/files',
    //        {
    //          q,
    //          fields: 'nextPageToken,files(id,name,mimeType,size,webViewLink,webContentLink,createdTime,modifiedTime,owners,parents,trashed,shared,description)',
    //          pageSize: '100',
    //          ...(pageToken ? { pageToken } : {}),
    //        }
    //      )
    //
    //      for (const file of response.data.files) {
    //        yield toFileDocument(file)
    //        fileCount++
    //
    //        if (maxFiles && fileCount >= maxFiles) break
    //      }
    //
    //      pageToken = response.data.nextPageToken
    //    } while (pageToken && (!maxFiles || fileCount < maxFiles))

    throw new Error('GoogleDriveIntegration files job is not yet implemented')

    return {
      jobId: ctx.job.id,
      bucketId: ctx.job.bucketId,
      status: 'completed',
      documentsCreated: 0,
      documentsUpdated: 0,
      documentsDeleted: 0,
      durationMs: 0,
    }
  },
}
