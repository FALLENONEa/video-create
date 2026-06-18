<p align="center">
  <img src="public/banner.png" alt="waoowaoo" width="600">
</p>

<h1 align="center">waoowaoo AI Film Studio</h1>

<p align="center">
  An AI-powered short-drama / comic video creation tool: feed it a novel or text, and it automatically handles script breakdown, character & scene generation, storyboard drawing, AI voiceover, and final video synthesis.
</p>

<p align="center">
  <a href="README.md">中文</a> · <a href="https://github.com/FALLENONEa/video-create/issues">Report Bug</a>
</p>

---

## ✨ Features

- 📖 **Script Analysis** — Import a novel / text; AI breaks down characters, scenes, plot arcs and episodes
- 🎭 **Character & Scene Consistency** — Generate character reference sheets with consistent appearance, plus scene and prop assets
- 🎬 **Storyboard Generation** — Auto-generate frames per shot, with shot variants and first-last-frame video
- 🎙️ **AI Voiceover** — Multi-character speech synthesis with acting direction
- 🎞️ **Video Synthesis** — Render storyboards and audio into a complete video via Remotion
- 🔌 **Multi-provider** — OpenAI / Google / fal.ai / OpenRouter / Zhipu / sub2api, all configured in the Settings Center
- 🗂️ **Task Queues** — Image / Video / Voice / Text queues with a Watchdog for timeout recovery and Bull Board monitoring
- 🌐 **Bilingual** UI (Chinese / English)

---

## 🏗️ Architecture

The app runs several cooperating processes (`npm run start` / `npm run dev` brings them all up):

| Process | Port | Responsibility |
| --- | --- | --- |
| Next.js server | 3000 | Web UI and API |
| Worker | — | Consumes image / video / voice / text queues |
| Watchdog | — | Task heartbeat and timeout recovery |
| Bull Board | 3010 | Queue dashboard (`/admin/queues`) |

Dependencies: **MySQL** (data), **Redis** (queues), **MinIO / S3** (object storage).

---

## 🚀 Quick Start

**Prerequisite**: install [Docker Desktop](https://docs.docker.com/get-docker/)

### Option 1: Pre-built image (simplest)

No clone needed — download and run:

```bash
curl -O https://raw.githubusercontent.com/FALLENONEa/video-create/main/docker-compose.yml
docker compose up -d
```

> During the testing phase, database schemas may be incompatible between versions. Clear old data before upgrading:
>
> ```bash
> docker compose down -v
> docker rmi ghcr.io/fallenaonea/video-create:latest
> curl -O https://raw.githubusercontent.com/FALLENONEa/video-create/main/docker-compose.yml
> docker compose up -d
> ```
>
> Clear your browser cache and re-login after upgrading.

### Option 2: Clone + Docker build

```bash
git clone https://github.com/FALLENONEa/video-create.git
cd video-create
docker compose up -d
```

Update:

```bash
git pull
docker compose down && docker compose up -d --build
```

Open [http://localhost:13000](http://localhost:13000) once started. The database initializes automatically on first launch — no extra setup needed.

> [!TIP]
> If pages feel sluggish under HTTP, enable HTTPS with [Caddy](https://caddyserver.com/docs/install): `caddy run --config Caddyfile`, then visit https://localhost:1443.

---

## 🔧 API Configuration

After launch, open the **Settings Center** to configure API keys for each AI provider — in-app tutorials are included.

> Official provider APIs are recommended; third-party OpenAI-compatible endpoints are still being refined.

---

## 📦 Tech Stack

- **Framework**: Next.js 15 + React 19 + Tailwind CSS v4
- **Database**: MySQL + Prisma ORM
- **Queue**: Redis + BullMQ
- **Storage**: MinIO / S3-compatible object storage
- **Auth**: NextAuth.js
- **Video rendering**: Remotion
- **i18n**: next-intl

---

## 🛠️ Local Development

```bash
git clone https://github.com/FALLENONEa/video-create.git
cd video-create

cp .env.example .env      # before npm install
# Edit .env and fill in your AI API keys

npm install

# Start only the infra (mysql:13306  redis:16379  minio:19000)
docker compose up mysql redis minio -d

# Initialize the DB schema on first run
npx prisma db push

# Start the dev environment (Next + Worker + Watchdog + Bull Board)
npm run dev
```

> ⚠️ Skipping `npx prisma db push` leaves tables missing — you'll get `The table 'tasks' does not exist` on startup.

Dev server: [http://localhost:3000](http://localhost:3000)

---

## 📂 Common Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start dev env (Next + Worker + Watchdog + Bull Board) |
| `npm run build` | Production build |
| `npm run start` | Production start |
| `npm run typecheck` | TypeScript type check |
| `npm run lint:all` | Full ESLint check |
| `npm run test:all` | Full test suite (contract / behavior / system) |

---

## 🤝 Feedback

Bug reports and feature ideas are welcome via [Issues](https://github.com/FALLENONEa/video-create/issues).

---

## 📄 License

This project is open-sourced under the [LICENSE](LICENSE).

---

> This project is based on the open-source project [waoowaoo](https://github.com/saturndec/waoowaoo).
