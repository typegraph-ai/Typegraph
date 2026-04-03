# @d8um-ai/integration-google-drive

Google Drive integration for d8um - sync files and folders into your sources.

## Install

```bash
npm install @d8um-ai/integration-google-drive
```

## Register

```ts
import { registerJobType } from '@d8um-ai/core'
import { GoogleDriveIntegration } from '@d8um-ai/integration-google-drive'

for (const job of GoogleDriveIntegration.jobs) {
  registerJobType(job)
}
```

## Entities

- files
- folders

## Jobs

| Job Type | Description | Sync Mode |
| --- | --- | --- |
| `google_drive_files` | Fetches files from Google Drive | full |

## Actions

| Function | Description |
| --- | --- |
| `listFiles(client, input)` | List files in Google Drive |
| `getFile(client, input)` | Get a single file by ID |

## Models

Zod schemas: `GoogleDriveFileSchema`, `GoogleDriveFolderSchema`, `GoogleDriveOwnerSchema`

## Related

- [d8um](../../README.md)
