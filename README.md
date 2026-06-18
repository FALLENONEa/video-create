<p align="center">
  <img src="public/banner.png" alt="waoowaoo" width="600">
</p>

<h1 align="center">waoowaoo AI 影视 Studio</h1>

<p align="center">
  基于 AI 的短剧 / 漫画视频创作工具：输入小说文本，自动完成剧本拆解、角色与场景生成、分镜绘制、AI 配音，最终合成为完整视频。
</p>

<p align="center">
  <a href="README_en.md">English</a> · <a href="https://github.com/FALLENONEa/video-create/issues">反馈问题</a>
</p>

---

## ✨ 核心能力

- 📖 **剧本解析** — 导入小说 / 文本，AI 自动拆解角色、场景、剧情脉络与分集
- 🎭 **角色 & 场景一致性** — 生成形象一致的角色参考图，以及场景与道具素材
- 🎬 **分镜生成** — 按分镜自动出图，支持镜头变体与首尾帧视频生成
- 🎙️ **AI 配音** — 多角色语音合成与表演指导
- 🎞️ **视频合成** — 基于 Remotion 将分镜画面与音频渲染为完整视频
- 🔌 **多模型接入** — OpenAI / Google / fal.ai / OpenRouter / 智谱 / sub2api 等，统一在设置中心配置
- 🗂️ **任务队列** — 图片 / 视频 / 语音 / 文本四类队列，Watchdog 超时回收，Bull Board 可视化监控
- 🌐 **中英双语** 界面

---

## 🏗️ 架构概览

应用由若干协同进程组成（`npm run start` / `npm run dev` 会一并拉起）：

| 进程 | 端口 | 职责 |
| --- | --- | --- |
| Next.js 服务 | 3000 | Web 界面与 API |
| Worker 工作进程 | — | 消费图片 / 视频 / 语音 / 文本队列 |
| Watchdog 看门狗 | — | 任务心跳与超时回收 |
| Bull Board | 3010 | 队列监控面板（`/admin/queues`） |

依赖服务：**MySQL**（业务数据）、**Redis**（任务队列）、**MinIO / S3**（对象存储）。

---

## 🚀 快速开始

**前提条件**：安装 [Docker Desktop](https://docs.docker.com/get-docker/)

### 方式一：拉取预构建镜像（最简单）

无需克隆仓库，下载即用：

```bash
# 下载 docker-compose.yml
curl -O https://raw.githubusercontent.com/FALLENONEa/video-create/main/docker-compose.yml

# 启动所有服务
docker compose up -d
```

> 测试阶段版本间数据库可能不兼容，升级前请清除旧数据：
>
> ```bash
> docker compose down -v
> docker rmi ghcr.io/fallenaonea/video-create:latest
> curl -O https://raw.githubusercontent.com/FALLENONEa/video-create/main/docker-compose.yml
> docker compose up -d
> ```
>
> 升级后建议清空浏览器缓存再重新登录。

### 方式二：克隆仓库 + Docker 构建

```bash
git clone https://github.com/FALLENONEa/video-create.git
cd video-create
docker compose up -d
```

更新版本：

```bash
git pull
docker compose down && docker compose up -d --build
```

启动后访问 [http://localhost:13000](http://localhost:13000) 即可使用。首次启动会自动完成数据库初始化，无需额外配置。

> [!TIP]
> 若页面在 HTTP 下偶发卡顿，可安装 [Caddy](https://caddyserver.com/docs/install) 启用 HTTPS：`caddy run --config Caddyfile`，然后访问 https://localhost:1443。

---

## 🔧 API 配置

启动后进入 **设置中心** 配置各 AI 服务的 API Key，界面内置配置教程。

> 当前推荐使用各服务商官方 API；第三方 OpenAI 兼容格式仍在完善中。

---

## 📦 技术栈

- **框架**：Next.js 15 + React 19 + Tailwind CSS v4
- **数据库**：MySQL + Prisma ORM
- **队列**：Redis + BullMQ
- **存储**：MinIO / S3 兼容对象存储
- **认证**：NextAuth.js
- **视频渲染**：Remotion
- **国际化**：next-intl

---

## 🛠️ 本地开发

```bash
git clone https://github.com/FALLENONEa/video-create.git
cd video-create

cp .env.example .env      # 复制环境变量（须在 npm install 之前完成）
# 编辑 .env，填入你的 AI API Key

npm install

# 只启动基础设施（mysql:13306  redis:16379  minio:19000）
docker compose up mysql redis minio -d

# 首次必须初始化数据库表结构
npx prisma db push

# 启动开发环境（同时拉起 Next / Worker / Watchdog / Bull Board）
npm run dev
```

> ⚠️ 跳过 `npx prisma db push` 会导致表缺失，启动后报错 `The table 'tasks' does not exist`。

开发服务器地址：[http://localhost:3000](http://localhost:3000)

---

## 📂 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发环境（Next + Worker + Watchdog + Bull Board） |
| `npm run build` | 生产构建 |
| `npm run start` | 生产启动 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint:all` | ESLint 全量检查 |
| `npm run test:all` | 全量测试（含契约 / 行为 / 系统测试） |

---

## 🤝 反馈

欢迎通过 [Issue](https://github.com/FALLENONEa/video-create/issues) 反馈 Bug 或提出功能建议。

---

## 📄 License

本项目基于 [LICENSE](LICENSE) 开源协议。

---

> 本项目基于开源项目 [waoowaoo](https://github.com/saturndec/waoowaoo)。
