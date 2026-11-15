# GET!

一个面向个人使用的英语生词记录、查询与复习 Web 应用。

## 功能

- **词典查询** — 内置离线牛津高阶词典数据，支持模糊搜索与词形还原（lemmatization）
- **生词本** — 收藏生词，按字母 / 日期分组浏览
- **错题本** — 自动收集复习中答错的单词
- **复习系统** — 多种复习模式（拼写、选择、听写等）
- **笔记本** — 记录短语搭配、近义词辨析、例句笔记
- **AI 辅助** — 接入 LLM（DeepSeek / 混元等 OpenAI 兼容接口），提供：
  - AI 例句生成
  - 近义词 / 派生词扩展
  - 用法纠错
  - 短语搭配建议
- **TTS 发音** — 单词与例句朗读
- **云同步** — 通过腾讯云 COS 实现跨设备数据同步
- **隐藏中文** — 一键隐藏全站中文释义，强化英文思维
- **PWA 支持** — 可添加到主屏幕

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Next.js 14 (App Router) |
| UI | React 18 + Tailwind CSS |
| 数据库 | Supabase (PostgreSQL + Auth) |
| 本地存储 | IndexedDB (idb) |
| AI | OpenAI 兼容 API (DeepSeek / 混元) |
| 对象存储 | 腾讯云 COS |
| 部署 | Vercel |

## 项目结构

```
vocabulary/
├── scripts/              # 词典数据处理脚本 (Python)
│   ├── parse_mdx.py      # 解析 MDX 词典文件
│   ├── extract_mdd.py    # 提取词典图片资源
│   └── upload_dict_images.py
├── web/                  # Next.js 应用
│   ├── src/
│   │   ├── app/          # 页面路由
│   │   │   ├── wordbook/ # 生词本
│   │   │   ├── review/   # 复习
│   │   │   ├── notebook/ # 笔记本
│   │   │   ├── search/   # 搜索
│   │   │   ├── word/     # 单词详情
│   │   │   ├── wrongbook/# 错题本
│   │   │   ├── settings/ # 设置
│   │   │   └── api/      # API 路由 (AI / TTS / COS)
│   │   └── components/   # 共享组件
│   ├── public/dict/      # 离线词典 JSON 数据
│   └── scripts/          # 数据构建脚本
└── README.md
```

## 快速开始

### 前置条件

- Node.js ≥ 18
- 一个 [Supabase](https://supabase.com) 项目
- （可选）DeepSeek / 混元等 LLM API Key
- （可选）腾讯云 COS 存储桶

### 安装与运行

```bash
cd web
npm install

# 复制环境变量模板并填入你的配置
cp .env.example .env.local

# 启动开发服务器
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000) 即可使用。

### 环境变量

参考 `web/.env.example`，主要配置项：

| 变量 | 说明 | 必填 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 URL | ✅ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 匿名 Key | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 服务端 Key | ✅ |
| `DEEPSEEK_API_KEY` | LLM API Key | 可选 |
| `DEEPSEEK_BASE_URL` | LLM API 地址 | 可选 |
| `DEEPSEEK_MODEL` | LLM 模型名 | 可选 |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | 腾讯云 COS 密钥 | 可选 |
| `COS_BUCKET` / `COS_REGION` | COS 存储桶配置 | 可选 |
| `NEXT_PUBLIC_ALLOWED_EMAIL` | 允许登录的邮箱 | 可选 |

### 数据库初始化

SQL schema 位于 `web/scripts/supabase-schema.sql`，在 Supabase SQL Editor 中执行即可。

## License

Private — 仅供个人使用。
