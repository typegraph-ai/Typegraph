import type { RawDocument } from '@d8um-ai/core'
import type { GoogleRawDriveFile } from '../types.js'
import type { GoogleDriveFile } from '../models.js'

/**
 * Transform a raw Google Drive API file into a normalized GoogleDriveFile.
 */
export function toGoogleDriveFile(raw: GoogleRawDriveFile): GoogleDriveFile {
  return {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    size: raw.size,
    webViewLink: raw.webViewLink,
    webContentLink: raw.webContentLink,
    createdTime: raw.createdTime,
    modifiedTime: raw.modifiedTime,
    owners: raw.owners?.map(o => ({
      displayName: o.displayName,
      emailAddress: o.emailAddress,
      photoLink: o.photoLink,
    })),
    parents: raw.parents,
    trashed: raw.trashed,
    shared: raw.shared,
  }
}

/**
 * Transform a raw Google Drive API file into a RawDocument for indexing.
 */
export function toFileDocument(raw: GoogleRawDriveFile): RawDocument {
  const ownerNames = raw.owners?.map(o => o.displayName ?? o.emailAddress).filter(Boolean).join(', ') ?? ''

  const contentParts = [
    raw.name,
    raw.description,
    ownerNames ? `Owner: ${ownerNames}` : undefined,
    raw.mimeType ? `Type: ${raw.mimeType}` : undefined,
  ].filter(Boolean)

  return {
    id: `gdrive-file-${raw.id}`,
    content: contentParts.join('\n'),
    title: raw.name,
    updatedAt: raw.modifiedTime ? new Date(raw.modifiedTime) : new Date(),
    metadata: {
      fileId: raw.id,
      mimeType: raw.mimeType,
      size: raw.size,
      webViewLink: raw.webViewLink,
      createdTime: raw.createdTime,
      modifiedTime: raw.modifiedTime,
      ownerEmail: raw.owners?.[0]?.emailAddress,
      trashed: raw.trashed ?? false,
      shared: raw.shared ?? false,
      parentId: raw.parents?.[0],
      isGoogleDoc: raw.mimeType.startsWith('application/vnd.google-apps.'),
    },
  }
}
