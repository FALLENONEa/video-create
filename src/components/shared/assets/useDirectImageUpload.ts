'use client'

import { useCallback, useRef, useState } from 'react'
import type { DragEvent, RefObject } from 'react'

const MAX_IMAGES = 5

export interface DirectImageUpload {
  uploadFiles: File[]
  uploadPreviewUrls: string[]
  fileInputRef: RefObject<HTMLInputElement | null>
  handleSelect: (files: FileList | File[]) => void
  handleDrop: (event: DragEvent<HTMLDivElement>) => void
  handleClear: (index?: number) => void
  reset: () => void
}

/**
 * 直接上传图片作为资产形象的本地状态管理（不走 AI 生成）。
 * 角色形象 / 场景 / 道具三类资产的"上传图片"模式共用此 hook。
 */
export function useDirectImageUpload(): DirectImageUpload {
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploadPreviewUrls, setUploadPreviewUrls] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleSelect = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (fileArray.length === 0) return
    const remaining = MAX_IMAGES - uploadFiles.length
    const toAdd = fileArray.slice(0, remaining)
    const newUrls = toAdd.map((f) => URL.createObjectURL(f))
    setUploadFiles((prev) => [...prev, ...toAdd])
    setUploadPreviewUrls((prev) => [...prev, ...newUrls])
  }, [uploadFiles.length])

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer.files.length > 0) {
      handleSelect(event.dataTransfer.files)
    }
  }, [handleSelect])

  const handleClear = useCallback((index?: number) => {
    if (typeof index === 'number') {
      setUploadFiles((prev) => prev.filter((_, i) => i !== index))
      setUploadPreviewUrls((prev) => {
        const removed = prev[index]
        if (removed) URL.revokeObjectURL(removed)
        return prev.filter((_, i) => i !== index)
      })
      return
    }
    setUploadPreviewUrls((prev) => {
      prev.forEach((url) => URL.revokeObjectURL(url))
      return []
    })
    setUploadFiles([])
  }, [])

  const reset = useCallback(() => {
    setUploadPreviewUrls((prev) => {
      prev.forEach((url) => URL.revokeObjectURL(url))
      return []
    })
    setUploadFiles([])
  }, [])

  return {
    uploadFiles,
    uploadPreviewUrls,
    fileInputRef,
    handleSelect,
    handleDrop,
    handleClear,
    reset,
  }
}
