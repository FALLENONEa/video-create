# AI 剪辑（视频合成导出）实现记录

> v3 · Node + ffmpeg 路线（2026-06 实现，替代 v2 Remotion 方案）

## 路线决策

**采用 Node `child_process.spawn` 调系统 ffmpeg，放弃 Remotion 服务端渲染。**

针对 GitHub Actions → Docker（alpine）→ Linux 部署链路的理由：
- 镜像增量 ~200MB（ffmpeg + 中文字体）vs Remotion ~500MB（额外 Chromium）
- 运行内存：ffmpeg 流处理（百 MB 级）vs Chromium 逐帧（GB 级）
- 跨平台一致：开发机 Windows 与 Linux Docker 行为一致，无 Chrome 路径硬编码问题
- alpine `apk add ffmpeg` 是完整版（含 subtitles / xfade / libass），非 Remotion 自带的裁剪版
- 客户端实时预览仍用 `@remotion/player`（纯浏览器包，不碰 Chrome/ffmpeg，部署无碍）

## 渲染管线（4 阶段，全 ffmpeg）

`src/lib/video-editor/compose.ts` 的 `renderEditorProject`：
1. **下载 + probe**（0-10%）：并发下载 clip/配音/BGM 到 workDir，ffprobe 摸底时长与帧率
2. **逐段标准化**（10-55%）：scale+pad 画幅适配、trim 裁剪、统一帧率、烧字幕（libass）、叠配音、保底音频轨
3. **xfade/acrossfade 串联**（55-90%）：按 transition 拼接（dissolve→fade / fade→fadeblack / slide→slideleft，none 退化为 1 帧 fade）
4. **BGM 混音**（90-100%）：adelay 定位 + volume + afade，视频流 copy 不重编码

辅助：`src/lib/video-editor/ffmpeg-runner.ts`（spawn 封装 + 进度解析 + 取消 + 下载 + probe）

## 任务系统

- `TASK_TYPE.VIDEO_RENDER` → VIDEO 队列（`src/lib/task/queues.ts` VIDEO_TYPES）
- intent：`VIDEO_RENDER → process`（`src/lib/task/intent.ts`）
- handler：`src/lib/workers/handlers/video-render.ts`
  读 VideoEditorProject → src 转 presigned → 渲染 → 读产物为 Buffer 上传 COS → 写回 `outputUrl` / `renderStatus`
  失败置 `renderStatus='failed'`，避免前端长停 rendering
- `video.worker.ts` 加 `case VIDEO_RENDER` 路由到 handler

## API

- `POST /api/novel-promotion/[projectId]/editor/render` — 提交渲染任务（body: `{ episodeId }`），返回 taskId
- `GET  /api/novel-promotion/[projectId]/editor/render?episodeId=` — 查状态，outputUrl 转 presigned 返回

## 前端

- `useEditorActions`：`startRender()` / `getRenderStatus()`（按 episodeId）；顺带修复 `saveProject` 缺 episodeId 的旧 bug
- `VideoEditorStage`：导出按钮状态化（导出 / 渲染中… / 下载成片）+ 3s 轮询；导出前自动保存工程

## 文件清单

新增：
- `src/lib/video-editor/ffmpeg-runner.ts`
- `src/lib/video-editor/compose.ts`（重写，原 Remotion 版废弃）
- `src/lib/workers/handlers/video-render.ts`
- `src/app/api/novel-promotion/[projectId]/editor/render/route.ts`
- `tests/unit/worker/video-render.test.ts`

修改：
- `src/lib/workers/video.worker.ts`（+ VIDEO_RENDER case）
- `src/lib/task/intent.ts`（+ VIDEO_RENDER → process）
- `tests/contracts/task-type-catalog.ts`（+ owner）
- `src/features/video-editor/hooks/useEditorActions.ts`
- `src/features/video-editor/components/VideoEditorStage.tsx`
- `Dockerfile`（runner: `apk add ffmpeg font-noto-cjk fontconfig && fc-cache -f`）
- `messages/{zh,en}/video.json`（+ rendering / download / renderCompleted / renderFailed）

删除：
- `src/remotion/Root.tsx`、`src/remotion/index.ts`（服务端 SSR 入口，不再需要）

## 验证状态

- ✅ `tsc --noEmit` 通过
- ✅ `video-render.test.ts` 4/4（成功 / 失败 / 缺参 / 项目未找到）
- ✅ eslint 改动文件无告警
- ✅ check:test-tasktype-coverage（41 类型全覆盖）
- ✅ check:api-handler（143 routes 含新增）/ check:no-duplicate-endpoint-entry

## 部署

Dockerfile runner stage 已加 `ffmpeg font-noto-cjk fontconfig`，CI 构建 alpine amd64+arm64 原生支持。
无需 Chrome、无需 Python、无需 Remotion 服务端 bundle。

## 本地测试（开发机）

开发机需装 ffmpeg 才能本地跑渲染（否则 handler 报 `VIDEO_RENDER_FFMPEG_SPAWN_FAILED`）：
- Windows：`winget install Gyan.FFmpeg`，或下载解压加 PATH，或设 `FFMPEG_PATH` / `FFPROBE_PATH` 环境变量
- 中文字体：Windows 自带微软雅黑，libass 经 fontconfig 可用；Linux/Docker 由 font-noto-cjk 提供

## 用户实测清单

1. 进入某 episode 的视频编辑器，确认时间轴有片段（含配音/字幕更佳）
2. 点「导出视频」→ 按钮变「渲染中…」，前端 3s 轮询
3. 等待完成（worker 日志可见 ffmpeg 各阶段）→ 按钮变「下载成片」
4. 点下载 → 浏览器打开 presigned URL，检查：画面拼接、转场、字幕、配音对位、BGM 混音
5. 失败时按钮回「导出视频」允许重试，DB `renderStatus='failed'`

## 已知边界

- 转场为 none 时统一走 1 帧 fade（视觉硬切），不额外走 concat 分支，保证 xfade 链不断
- BGM 时长 > 主视频时由 `amix duration=first` 截断
- 字幕整段 clip 持续显示（单条 srt），不做逐句时间轴
