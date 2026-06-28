import { StorageProviderNotImplementedError } from '@/lib/storage/errors'
import type { DeleteObjectsResult, StorageProvider, UploadObjectResult } from '@/lib/storage/types'

export class CosStorageProvider implements StorageProvider {
  readonly kind = 'cos' as const

  constructor() {
    throw new StorageProviderNotImplementedError('cos')
  }

  async uploadObject(): Promise<UploadObjectResult> {
    throw new StorageProviderNotImplementedError('cos')
  }

  async deleteObject(): Promise<void> {
    throw new StorageProviderNotImplementedError('cos')
  }

  async deleteObjects(): Promise<DeleteObjectsResult> {
    throw new StorageProviderNotImplementedError('cos')
  }

  async getSignedObjectUrl(): Promise<string> {
    throw new StorageProviderNotImplementedError('cos')
  }

  async getObjectBuffer(): Promise<Buffer> {
    throw new StorageProviderNotImplementedError('cos')
  }

  extractStorageKey(): string | null {
    throw new StorageProviderNotImplementedError('cos')
  }

  toFetchableUrl(): string {
    throw new StorageProviderNotImplementedError('cos')
  }

  generateUniqueKey(): string {
    throw new StorageProviderNotImplementedError('cos')
  }
}
