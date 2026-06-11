# 部署 & 配置（Day 7 收尾）

> 本文档面向项目作者本人。MVP 一周打通，自用，免费栈。

---

## 1. 本地跑起来

```bash
cd web
npm install
npm run dev
# 打开 http://localhost:3000
```

> 词典 JSON 已在 `web/public/dict/` 内（前置步骤由 `scripts/parse_mdx.py`
> 离线生成；除非你换词典，否则不用再跑）。

---

## 2. 环境变量

复制 `.env.example` 到 `.env.local`，按需填写：

| 变量 | 用途 | 不填会怎样 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 URL | 单词本/笔记仅本地保存，不跨设备同步 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 匿名 key | 同上 |
| `DEEPSEEK_API_KEY` | DeepSeek `/chat/completions` key | AI 例句 / 造句批改回退到 mock |

`DEEPSEEK_API_KEY` 是**服务端**变量，不带 `NEXT_PUBLIC_` 前缀，浏览器拿不到，
所有 AI 调用都走 `/api/ai/*` 路由代理。

---

## 3. Supabase 启用（可选，多端同步）

按照 `web/scripts/supabase-schema.sql` 在 Supabase SQL Editor 里全量执行一遍：

1. 打开 Supabase 项目 → SQL Editor → New query。
2. 把 `supabase-schema.sql` 整段粘进去 → Run。
3. Authentication → Providers → 开启 **Email** + 在 Email Whitelist 里
   加上你的邮箱（自用白名单）。
4. Storage → 新建 bucket `note-images`（已在 schema 里创建，确认存在即可）。
5. 把 URL / anon key 填进 `.env.local`，重启 dev。

第一次登录后，本地的单词本 / 笔记会通过双写同步到云端（详见
`web/src/lib/supabase/`）。

---

## 4. DeepSeek key 接入

1. https://platform.deepseek.com/ 充值 → 创建 API key。
2. 把 key 写进 `.env.local`：
   ```
   DEEPSEEK_API_KEY=sk-xxxxx
   ```
3. 重启 dev / 重新部署。

无 key 时所有 AI 路由会返回带 `provider: "mock"` 的兜底响应；
路由签名一致，UI 不需要改。

---

## 5. 部署到 Vercel

```bash
# 仓库根目录
git init && git add . && git commit -m "init"
# 在 https://vercel.com/new 选你的 GitHub 仓库
```

部署设置：

- **Root Directory**：`web`
- **Framework Preset**：Next.js（自动识别）
- **Environment Variables**：把 `.env.local` 里的 3 个变量原样粘进去
- 部署！

> Vercel 免费版（Hobby）够自用：
> 100GB 带宽 / 月、无限静态页面、function 调用 100GB-Hours / 月。
> AI 路由是 dynamic function，但调用量很小，不会触顶。

---

## 6. PWA 安装

部署成功后用 Chrome / Edge / Safari 打开线上地址：

- **桌面**：地址栏右侧会出现"安装"图标，点一下 → 出现独立窗口 + Dock 图标。
- **手机**：分享菜单 → "添加到主屏幕"。

第一次访问加载完后就支持离线查词（词典 shards 进
service worker 缓存）。AI 接口仍需联网。

---

## 7. 数据备份

所有本地数据都在浏览器 localStorage 里，键名前缀都是 `get:`：

- `get:wordbook:v1` — 单词本
- `get:notes:v1` — 笔记
- `get:punches:v1` — 打卡记录
- `get:ai-examples:*`（IndexedDB）— AI 例句缓存

DevTools → Application → Local Storage / IndexedDB 里都能直接 export。
开 Supabase 后云端会有一份镜像，更安全。

---

## 8. 后续可加（不在 MVP 范围内）

- 图例：词义相关 AI 配图（产品方案里的「模块3」，按你说的暂时跳过）
- 悬浮球 GET 一下：DeepSeek 对话浮窗
- 复习考核题型扩展：完形填空 / 拼写
- Anki 导出
