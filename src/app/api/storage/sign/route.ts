import { NextRequest, NextResponse } from 'next/server'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { getSignedObjectUrl } from '@/lib/storage'

const DEFAULT_EXPIRES_SECONDS = 3600

export const GET = apiHandler(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url)
  const key = searchParams.get('key')
  const expiresRaw = searchParams.get('expires')

  if (!key) {
    throw new ApiError('INVALID_PARAMS')
  }

  const expires = expiresRaw ? Number.parseInt(expiresRaw, 10) : DEFAULT_EXPIRES_SECONDS
  const ttl = Number.isFinite(expires) && expires > 0 ? expires : DEFAULT_EXPIRES_SECONDS

  const signedUrl = await getSignedObjectUrl(key, ttl)

  // ⚠️ 不能用 redirect：signedUrl 的 host 是容器内网地址（如 http://minio:9000），
  // 浏览器在外网无法解析。改为服务端流式代理：fetch 内网 presigned URL，把文件流
  // 原样回传给浏览器。这样浏览器只与 app 通信，不依赖 minio 外部可达性，也不暴露 minio。
  const upstream = await fetch(signedUrl)
  if (!upstream.ok || !upstream.body) {
    throw new ApiError('INVALID_PARAMS')
  }

  const headers = new Headers()
  const contentType = upstream.headers.get('content-type')
  if (contentType) headers.set('Content-Type', contentType)
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) headers.set('Content-Length', contentLength)
  // 允许浏览器直接下载或内嵌（video/img 标签都能用）
  headers.set('Cache-Control', 'private, max-age=300')

  return new NextResponse(upstream.body, { status: upstream.status, headers })
})