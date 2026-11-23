# GET!

A personal English vocabulary learning web app for recording, looking up, and reviewing new words.

## Features

- **Dictionary Lookup** — Built-in offline Oxford Advanced Learner's Dictionary data with fuzzy search and lemmatization
- **Wordbook** — Save new words and browse them by alphabet or date
- **Wrong-Answer Book** — Automatically collects words you got wrong during review
- **Review System** — Multiple review modes (spelling, multiple choice, dictation, etc.)
- **Notebook** — Record collocations, synonym distinctions, and example sentence notes
- **AI Assistance** — Powered by LLM (DeepSeek / Hunyuan or any OpenAI-compatible endpoint):
  - AI-generated example sentences
  - Synonym / derived word expansion
  - Usage correction
  - Collocation suggestions
- **TTS Pronunciation** — Read aloud words and sentences
- **Cloud Sync** — Cross-device data sync via Tencent Cloud COS
- **Hide Chinese** — One-click toggle to hide all Chinese translations across the app for immersive English thinking
- **PWA Support** — Installable on home screen

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14 (App Router) |
| UI | React 18 + Tailwind CSS |
| Database | Supabase (PostgreSQL + Auth) |
| Local Storage | IndexedDB (idb) |
| AI | OpenAI-compatible API (DeepSeek / Hunyuan) |
| Object Storage | Tencent Cloud COS |
| Deployment | Vercel |

## Project Structure

```
vocabulary/
├── scripts/              # Dictionary data processing scripts (Python)
│   ├── parse_mdx.py      # Parse MDX dictionary files
│   ├── extract_mdd.py    # Extract dictionary image resources
│   └── upload_dict_images.py
├── web/                  # Next.js application
│   ├── src/
│   │   ├── app/          # Page routes
│   │   │   ├── wordbook/ # Wordbook
│   │   │   ├── review/   # Review
│   │   │   ├── notebook/ # Notebook
│   │   │   ├── search/   # Search
│   │   │   ├── word/     # Word detail
│   │   │   ├── wrongbook/# Wrong-answer book
│   │   │   ├── settings/ # Settings
│   │   │   └── api/      # API routes (AI / TTS / COS)
│   │   └── components/   # Shared components
│   ├── public/dict/      # Offline dictionary JSON data
│   └── scripts/          # Data build scripts
└── README.md
```

## Getting Started

### Prerequisites

- Node.js ≥ 18
- A [Supabase](https://supabase.com) project
- (Optional) DeepSeek / Hunyuan or other LLM API key
- (Optional) Tencent Cloud COS bucket

### Installation

```bash
cd web
npm install

# Copy the env template and fill in your credentials
cp .env.example .env.local

# Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Environment Variables

See `web/.env.example` for the full template. Key variables:

| Variable | Description | Required |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | ✅ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (server-side only) | ✅ |
| `DEEPSEEK_API_KEY` | LLM API key | Optional |
| `DEEPSEEK_BASE_URL` | LLM API base URL | Optional |
| `DEEPSEEK_MODEL` | LLM model name | Optional |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | Tencent Cloud COS credentials | Optional |
| `COS_BUCKET` / `COS_REGION` | COS bucket configuration | Optional |
| `NEXT_PUBLIC_ALLOWED_EMAIL` | Whitelisted login email | Optional |

### Database Setup

Run the SQL schema located at `web/scripts/supabase-schema.sql` in the Supabase SQL Editor.

## License

Private — for personal use only.
