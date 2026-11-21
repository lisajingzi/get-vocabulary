"use client";

/**
 * /settings — cloud sync settings page.
 *
 * Shows the current Sync Code (UUID) and lets the user:
 *   1. Copy it to share with another device.
 *   2. Enter a code from another device to start syncing to the same account.
 *   3. Manually trigger push / pull.
 */

import { useState, useEffect } from "react";
import { getSyncId, setSyncId, pushManual, pull, isSyncIdLocked } from "@/lib/sync/cloud";
import {
  getDailyCapActive,
  getDailyCapPassive,
  setDailyCapActive,
  setDailyCapPassive,
  DAILY_CAP_CHOICES,
} from "@/lib/wordbook/preferences";
import {
  ensureEntry,
  getEntry,
  setGroup,
  setIelts,
  setPurpose,
  readNotes as readWordNotes,
  hydrateNotesFromIdb,
} from "@/lib/wordbook/local";
import {
  listAllGroups,
  createGroup,
  deleteGroup,
} from "@/lib/wordbook/groups";
import {
  readNotesStore as readNotebookNotes,
  hydrateNotebookNotesFromIdb,
} from "@/lib/notebook/local";

type Status = "idle" | "loading" | "ok" | "error";

function StatusBadge({ status, msg }: { status: Status; msg?: string }) {
  if (status === "idle") return null;
  const base = "mt-2 rounded-md px-3 py-1.5 text-sm font-medium";
  if (status === "loading")
    return <p className={`${base} bg-blue-50 text-blue-600`}>同步中…</p>;
  if (status === "ok")
    return <p className={`${base} bg-green-50 text-green-700`}>✓ {msg ?? "成功"}</p>;
  return <p className={`${base} bg-red-50 text-red-700`}>✗ {msg ?? "失败"}</p>;
}

export default function SettingsPage() {
  const [syncId, setSyncIdState] = useState("");
  const [copied, setCopied] = useState(false);
  const [inputCode, setInputCode] = useState("");
  const [pushStatus, setPushStatus] = useState<Status>("idle");
  const [pushMsg, setPushMsg] = useState("");
  const [pullStatus, setPullStatus] = useState<Status>("idle");
  const [pullMsg, setPullMsg] = useState("");
  const [importStatus, setImportStatus] = useState<Status>("idle");
  const [importMsg, setImportMsg] = useState("");
  // 雅思批量导入 — 与上方的 sync-code import 完全无关，只是因为拼写接近，
  // 变量名带上 ielts 前缀以防止回头看代码时搞混。
  const [ieltsInput, setIeltsInput] = useState("");
  const [ieltsGroup, setIeltsGroup] = useState("");
  const [ieltsStatus, setIeltsStatus] = useState<Status>("idle");
  const [ieltsMsg, setIeltsMsg] = useState("");
  const [ieltsImporting, setIeltsImporting] = useState(false);
  const locked = isSyncIdLocked();
  // 单词组管理 —— 列出所有组（有词的 + 预建的空组），支持新增 / 删除。
  // 这里只记当前页面的本地 state，真实存储在 groups.ts（localStorage）+
  // 各词条的 group 字段里。页面挂载时读一遍，增删后再 refresh 一遍。
  const [groups, setGroups] = useState<Array<{ name: string; count: number }>>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [groupMsg, setGroupMsg] = useState("");

  function refreshGroups() {
    setGroups(listAllGroups());
  }

  function handleCreateGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    const ok = createGroup(name);
    if (ok) {
      setNewGroupName("");
      setGroupMsg(`已新建组：${name}`);
      refreshGroups();
    } else {
      setGroupMsg(`组「${name}」已存在`);
    }
    window.setTimeout(() => setGroupMsg(""), 2500);
  }

  function handleDeleteGroup(name: string, count: number) {
    const ok = window.confirm(
      count > 0
        ? `确定要删除组「${name}」吗？\n\n该组下的 ${count} 个单词会脱离本组（词本身和雅思标记都会保留），不可撤销。`
        : `确定要删除空组「${name}」吗？`,
    );
    if (!ok) return;
    const affected = deleteGroup(name);
    setGroupMsg(
      affected > 0
        ? `已删除组「${name}」，${affected} 个单词已脱组`
        : `已删除空组「${name}」`,
    );
    refreshGroups();
    window.setTimeout(() => setGroupMsg(""), 2500);
  }
  // `null` in state means "无上限"; we store it verbatim in preferences.
  // 两组 cap 分别控制 说写 / 阅读 的每日上限；两者互不影响。
  const [capActive, setCapActiveState] = useState<number | null>(null);
  const [capPassive, setCapPassiveState] = useState<number | null>(null);
  // Brief "已保存 ✓" flash after the user picks a new cap. 两侧共用同一个
  // 提示，因为一次只会改一侧。
  const [capSavedFlash, setCapSavedFlash] = useState(false);

  useEffect(() => {
    setSyncIdState(getSyncId());
    setCapActiveState(getDailyCapActive());
    setCapPassiveState(getDailyCapPassive());
    refreshGroups();
    // If cloud sync pulls in a new preference blob after mount, mirror it.
    const onPrefsChange = () => {
      setCapActiveState(getDailyCapActive());
      setCapPassiveState(getDailyCapPassive());
    };
    window.addEventListener("get:preferences-change", onPrefsChange);
    return () => {
      window.removeEventListener("get:preferences-change", onPrefsChange);
    };
  }, []);

  function handleCapActiveChange(next: number | null) {
    setDailyCapActive(next);
    setCapActiveState(next);
    setCapSavedFlash(true);
    window.setTimeout(() => setCapSavedFlash(false), 2000);
  }

  function handleCapPassiveChange(next: number | null) {
    setDailyCapPassive(next);
    setCapPassiveState(next);
    setCapSavedFlash(true);
    window.setTimeout(() => setCapSavedFlash(false), 2000);
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(syncId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handlePush() {
    setPushStatus("loading");
    setPushMsg("");
    try {
      await pushManual();
      setPushStatus("ok");
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "SUSPICIOUS_EMPTY_PUSH") {
        // Safety-net: local looks catastrophically emptier than cloud.
        // Ask the user to confirm before overwriting.
        const ok = window.confirm(
          `⚠️ 本地数据比云端少很多，很可能是同步还没完成。\n\n確定要用本地数据覆盖云端吗？覆盖后云端原有的竈记本、打卡等数据将丢失！\n\n（建议先点取消，进 → 开发者工具 Network 面板确认云端实际数据后再决定）`,
        );
        if (ok) {
          try {
            await pushManual(true);
            setPushStatus("ok");
          } catch (e2) {
            setPushStatus("error");
            setPushMsg(
              e2 instanceof Error ? e2.message : String(e2) || "上传失败",
            );
          }
        } else {
          setPushStatus("idle");
          setTimeout(() => setPushStatus("idle"), 0);
          return;
        }
      } else {
        setPushStatus("error");
        setPushMsg(err.message || String(err) || "上传失败");
      }
    }
    setTimeout(() => setPushStatus("idle"), 3000);
  }

  async function handlePull() {
    setPullStatus("loading");
    setPullMsg("");
    try {
      const result = await pull();
      if (result.error) {
        setPullStatus("error");
        setPullMsg(result.error);
      } else {
        setPullStatus("ok");
      }
    } catch (e) {
      setPullStatus("error");
      setPullMsg(e instanceof Error ? e.message : String(e) || "拉取失败");
    }
    setTimeout(() => setPullStatus("idle"), 3000);
  }

  async function handleImportCode() {
    const code = inputCode.trim();
    if (!/^[0-9a-f-]{36}$/.test(code)) {
      setImportStatus("error");
      setImportMsg("格式不对，请粘贴完整的 Sync Code");
      setTimeout(() => setImportStatus("idle"), 3000);
      return;
    }
    setImportStatus("loading");
    try {
      const result = await pull(code);
      if (result.error) throw new Error(result.error);
      // Only persist the new id after a successful pull
      setSyncId(code);
      setSyncIdState(code);
      setInputCode("");
      setImportStatus("ok");
      setImportMsg("已切换到新 Sync Code，数据已合并");
    } catch (e: unknown) {
      setImportStatus("error");
      setImportMsg(e instanceof Error ? e.message : "拉取失败，请检查 Code 是否正确");
    }
    setTimeout(() => setImportStatus("idle"), 4000);
  }

  /**
   * 雅思词汇批量导入。
   *
   * 行为：
   *  - 按行 split → trim → lowercase → 去重去空。
   *  - 已存在的条目：不动查询次数（skipCount 无法在尾部追加 setIelts），
   *    直接补上 ielts=true。
   *  - 不存在的条目：新建（同一次查询的默认 purpose=undefined → 其他代码
   *    一律当 active 处理，与手工搜索创建的行为一致），并标记 ielts=true。
   *  - 不弹 <PurposePromptModal>，因为批量场景下弹窗会阻断后续导入；
   *    用户可以后续在单词详情页自行切换听说写 / 阅读。
   */
  function handleImportIelts() {
    const raw = ieltsInput;
    const seen = new Set<string>();
    const words: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const lemma = line.trim().toLowerCase();
      if (!lemma) continue;
      // 只允许英文字母 / 空格 / 连字符 / 擇号，避免把中文注释、
      // 序号、标点一并当作“单词”录入。
      if (!/^[a-z][a-z\-' ]*$/.test(lemma)) continue;
      if (seen.has(lemma)) continue;
      seen.add(lemma);
      words.push(lemma);
    }

    if (words.length === 0) {
      setIeltsStatus("error");
      setIeltsMsg("没有识别到可导入的单词，请确认每行一个单词");
      window.setTimeout(() => setIeltsStatus("idle"), 3000);
      return;
    }

    const groupName = ieltsGroup.trim();

    setIeltsImporting(true);
    let created = 0;
    let existed = 0;
    for (const lemma of words) {
      const before = getEntry(lemma);
      if (before) {
        // 已存在 → 不刷新 queryCount / lastQueriedAt，只补雅思标记。
        setIelts(lemma, true);
        // 强制切回 active（按需求 1.2：导入时默认听说写），保留后续用户切换能力。
        setPurpose(lemma, "active");
        if (groupName) setGroup(lemma, groupName);
        existed += 1;
      } else {
        // 不存在 → 建一条“未查询”的空条目（queryCount=0、lastQueriedAt 未设），
        // 导入本身不算用户查询；后续用户在搜索栏手动查时 recordLookup 才会把
        // queryCount 拉到 1。
        ensureEntry(lemma);
        setIelts(lemma, true);
        setPurpose(lemma, "active");
        if (groupName) setGroup(lemma, groupName);
        created += 1;
      }
    }
    setIeltsImporting(false);
    setIeltsInput("");
    setIeltsStatus("ok");
    setIeltsMsg(
      `已导入 ${words.length} 个：新增 ${created} 个，已存在 ${existed} 个${groupName ? `（分组：${groupName}）` : ""}`,
    );
    // 组名可能是新出现的 → 刷新一下组管理列表。
    refreshGroups();
    window.setTimeout(() => setIeltsStatus("idle"), 5000);
  }

  return (
    <div className="mx-auto max-w-xl space-y-8 py-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
        <p className="mt-1 text-[var(--fg-soft)] text-sm">
          云同步让你在多台设备之间保持单词本、笔记本、复习进度同步，无需登录。
        </p>
      </div>

      {/* ── Daily review pace ──────────────────────────── */}
      <section className="rounded-xl border border-[var(--border)] p-5 space-y-4">
        <div className="space-y-1.5">
          <h2 className="font-medium text-base">每日复习节奏</h2>
          <p className="text-sm text-[var(--fg-soft)]">
            单词分为两类发送到今日复习队列：说写单词需要听写、拼写、造句（完整流程），阅读单词只需要自评“认识 / 忘了”。两类可以分别设每日上限，互不影响。超过上限的单词会自动顺延到未来几天。
          </p>
          <p className="text-xs text-[var(--fg-soft)]">
            ℹ️ 修改不会影响今天已经冻结的队列，从明天开始生效。
          </p>
        </div>

        {/* 说写 */}
        <div className="space-y-2 border-t border-[var(--border)]/60 pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <div>
              <p className="text-sm font-medium">说写单词</p>
              <p className="text-[11px] text-[var(--fg-soft)]">
                听写 · 拼写 · 造句 + AI 批改
              </p>
            </div>
            <p className="text-xs text-[var(--fg-soft)]">
              当前：
              <span className="font-medium text-[var(--fg)]">
                {capActive === null ? "无上限" : `${capActive} 个 / 天`}
              </span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {DAILY_CAP_CHOICES.map((choice) => {
              const active = choice === capActive;
              const label = choice === null ? "无上限" : `${choice} 个`;
              const key = choice === null ? "unlimited" : String(choice);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleCapActiveChange(choice)}
                  className={[
                    "rounded-lg border px-3.5 py-1.5 text-sm font-medium transition",
                    active
                      ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                      : "border-[var(--border)] hover:bg-[var(--surface-hover)]",
                  ].join(" ")}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 阅读 */}
        <div className="space-y-2 border-t border-[var(--border)]/60 pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <div>
              <p className="text-sm font-medium">阅读单词</p>
              <p className="text-[11px] text-[var(--fg-soft)]">
                看词自评 “认识 / 忘了”，不需要写
              </p>
            </div>
            <p className="text-xs text-[var(--fg-soft)]">
              当前：
              <span className="font-medium text-[var(--fg)]">
                {capPassive === null ? "无上限" : `${capPassive} 个 / 天`}
              </span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {DAILY_CAP_CHOICES.map((choice) => {
              const active = choice === capPassive;
              const label = choice === null ? "无上限" : `${choice} 个`;
              const key = choice === null ? "unlimited" : String(choice);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleCapPassiveChange(choice)}
                  className={[
                    "rounded-lg border px-3.5 py-1.5 text-sm font-medium transition",
                    active
                      ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                      : "border-[var(--border)] hover:bg-[var(--surface-hover)]",
                  ].join(" ")}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {capSavedFlash && (
          <p className="text-xs text-green-600 pt-1">
            已保存 ✓ 明天生效
          </p>
        )}
      </section>

      {/* ── Word group management ─────────────────────────
          组名的真相是「所有词条 group 字段去重 + 预建空组」，由
          @/lib/wordbook/groups 负责维护。组和雅思标记完全正交：删除组
          只清词条的 group 字段，不会动 ielts 标记。 */}
      <section className="rounded-xl border border-[var(--border)] p-5 space-y-3">
        <div className="space-y-1.5">
          <h2 className="font-medium text-base">单词组管理</h2>
          <p className="text-sm text-[var(--fg-soft)]">
            组用于把单词归类（如 List 1、教材 Unit3……）。可以新建空组名备用，也可以删除已有组。
          </p>
          <p className="text-xs text-[var(--fg-soft)]">
            ℹ️ 删除组不会删单词，只会把该组下的词脱离组；雅思标记保留。组名在单词详情页的「分组」下拉里可选。
          </p>
        </div>

        {/* 新建组 */}
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCreateGroup();
              }
            }}
            placeholder="新建组名，例：List 1"
            className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          <button
            type="button"
            onClick={handleCreateGroup}
            disabled={!newGroupName.trim()}
            className="shrink-0 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 active:scale-95 disabled:opacity-50"
          >
            新建
          </button>
        </div>

        {/* 已有组列表 */}
        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          {groups.length === 0 ? (
            <p className="px-3 py-4 text-sm text-[var(--fg-soft)] text-center">
              暂无分组。在上面输入名字来新建第一个组吧。
            </p>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {groups.map((g) => (
                <li
                  key={g.name}
                  className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-[var(--fg)] truncate block">
                      {g.name}
                    </span>
                    <span className="text-[11px] text-[var(--fg-soft)]">
                      {g.count === 0 ? "空组（无词）" : `${g.count} 个单词`}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteGroup(g.name, g.count)}
                    className="shrink-0 rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--fg-soft)] transition hover:border-red-400 hover:text-red-600"
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {groupMsg && (
          <p className="text-xs text-green-600">{groupMsg}</p>
        )}
      </section>

      {/* ── Bulk import IELTS vocabulary ──────────────────── */}
      <section className="rounded-xl border border-[var(--border)] p-5 space-y-3">
        <div className="space-y-1.5">
          <h2 className="font-medium text-base">批量导入雅思词汇</h2>
          <p className="text-sm text-[var(--fg-soft)]">
            把雅思词表直接粘到下方，每行一个单词。导入后自动打上“雅思”标记，已存在的词不会刷新查询次数，仅补上雅思标记。
          </p>
          <p className="text-xs text-[var(--fg-soft)]">
            ℹ️ 仅识别英文字母 / 连字符开头的行；序号、中文注释、空行会自动过滤。导入后可在单词详情页手动指定听说写 / 阅读模式。
          </p>
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-[var(--fg-soft)]">分组名（可选）</span>
          <input
            type="text"
            value={ieltsGroup}
            onChange={(e) => setIeltsGroup(e.target.value)}
            placeholder="例：List 1、教材第一章、真经5-Unit3……"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          <span className="block text-[11px] text-[var(--fg-soft)]">
            同一分组名可重复使用（同一个单词若再次导入到别的组名，会更新为新组）；留空则不分组。
          </span>
        </label>
        <textarea
          value={ieltsInput}
          onChange={(e) => setIeltsInput(e.target.value)}
          rows={8}
          placeholder={"abandon\nambiguous\nbenign\n……"}
          className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={handleImportIelts}
            disabled={ieltsImporting || !ieltsInput.trim()}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 active:scale-95 disabled:opacity-50"
          >
            {ieltsImporting ? "导入中…" : "导入雅思词汇"}
          </button>
          <button
            onClick={() => setIeltsInput("")}
            disabled={ieltsImporting || !ieltsInput}
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--fg-soft)] transition hover:text-[var(--fg)] disabled:opacity-40"
          >
            清空
          </button>
          <span className="text-xs text-[var(--fg-soft)]">
            {countLines(ieltsInput)} 行待导入
          </span>
        </div>
        <StatusBadge status={ieltsStatus} msg={ieltsMsg} />
      </section>

      {/* ── My Sync Code ─────────────────────────────────────── */}
      <section className="rounded-xl border border-[var(--border)] p-5 space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="font-medium text-base">我的 Sync Code</h2>
          {locked && (
            <span className="rounded-md bg-[var(--surface)] px-2 py-0.5 text-[11px] text-[var(--fg-soft)] border border-[var(--border)]">
              已锁定
            </span>
          )}
        </div>
        <p className="text-sm text-[var(--fg-soft)]">
          {locked
            ? "当前为单用户模式，Sync Code 已在部署时固定，三端始终指向同一份数据，无需手动绑定。"
            : "这是本设备的唯一同步标识。把它分享给你的另一台设备，就能让两台设备共用同一份数据。"}
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-lg bg-[var(--surface)] border border-[var(--border)] px-3 py-2 text-xs font-mono tracking-wide break-all select-all">
            {syncId || "生成中…"}
          </code>
          {!locked && (
            <button
              onClick={handleCopy}
              className="shrink-0 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 active:scale-95"
            >
              {copied ? "已复制 ✓" : "复制"}
            </button>
          )}
        </div>
      </section>

      {/* ── Import Code from another device ──────────────────── */}
      {!locked && (
      <section className="rounded-xl border border-[var(--border)] p-5 space-y-3">
        <h2 className="font-medium text-base">在新设备上绑定</h2>
        <p className="text-sm text-[var(--fg-soft)]">
          在另一台设备上复制 Sync Code，粘贴到这里，数据会自动合并。
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={inputCode}
            onChange={(e) => setInputCode(e.target.value)}
            placeholder="粘贴另一台设备的 Sync Code…"
            className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          <button
            onClick={handleImportCode}
            disabled={importStatus === "loading" || !inputCode.trim()}
            className="shrink-0 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium transition hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            绑定
          </button>
        </div>
        <StatusBadge status={importStatus} msg={importMsg} />
      </section>
      )}

      {/* ── Manual sync ──────────────────────────────────────── */}
      <section className="rounded-xl border border-[var(--border)] p-5 space-y-3">
        <h2 className="font-medium text-base">手动同步</h2>
        <p className="text-sm text-[var(--fg-soft)]">
          通常数据会在你操作后 3 秒内自动上传。如需立即同步，可手动触发。
        </p>
        <div className="flex gap-3">
          <button
            onClick={handlePush}
            disabled={pushStatus === "loading"}
            className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium transition hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            {pushStatus === "loading" ? "上传中…" : "↑ 上传到云端"}
          </button>
          <button
            onClick={handlePull}
            disabled={pullStatus === "loading"}
            className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium transition hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            {pullStatus === "loading" ? "下载中…" : "↓ 从云端拉取"}
          </button>
        </div>
                <StatusBadge
                  status={pushStatus}
                  msg={
                    pushStatus === "error"
                      ? pushMsg || "上传失败"
                      : "上传成功"
                  }
                />
                <StatusBadge
                  status={pullStatus}
                  msg={
                    pullStatus === "error"
                      ? pullMsg || "拉取失败"
                      : "拉取并合并成功"
                  }
                />
      </section>

      {/* ── Sync diagnostics ─────────────────────────────────
          Shows this device's localStorage counts side-by-side with the
          cloud shard counts. Handy on WeChat WebView / mobile Safari
          where DevTools isn't available and you need to tell
          "pull didn't write" apart from "UI didn't render". */}
      <DiagnosticsCard />

      {/* ── How it works ─────────────────────────────────────── */}
      <section className="rounded-xl bg-[var(--surface)] p-5 space-y-2 text-sm text-[var(--fg-soft)]">
        <h2 className="font-medium text-[var(--fg)]">工作原理</h2>
        <ul className="space-y-1 list-disc list-inside">
          <li>数据存储在腾讯云 COS，以你的 Sync Code 为索引</li>
          <li>每次你查词、复习、记笔记，数据会自动上传</li>
          <li>打开 App 时自动拉取最新数据并合并</li>
          <li>合并策略：以最近修改时间为准，不会丢失数据</li>
          <li>Sync Code 是唯一凭证，请勿分享给他人</li>
        </ul>
      </section>
    </div>
  );
}

/** 非空行计数 — 导入按钮旁给个直观提示（实际导入时还会去重/过滤非英文）。 */
function countLines(raw: string): number {
  if (!raw) return 0;
  return raw.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
}

// ---------------------------------------------------------------------------
// DiagnosticsCard — WeChat-friendly localStorage inspector.
//
// Purpose: in WeChat WebView we have no DevTools, so when data appears to
// be "missing" on that surface we can't tell whether:
//   (a) pull() failed silently and localStorage really is empty here, or
//   (b) localStorage is fine and it's a rendering / event-wiring bug.
//
// This card reads every sync-relevant key directly out of localStorage and
// prints the counts on-screen, plus a button that fetches the cloud
// snapshot for the current syncId and prints those counts side-by-side.
// The two columns together pin down exactly where the data got lost.
//
// Intentionally minimal deps: no imports from wordbook/notebook helpers so
// nothing can accidentally trigger a write / dispatch / push while we're
// diagnosing an already-fragile sync state.
// ---------------------------------------------------------------------------

type LocalCounts = {
  wordbook: number;
  wordNotes: number;
  notebook: number;
  notebookNotes: number;
  punches: number;
  reviewLog: number;
  dailySnapshot: string;
  syncIdShort: string;
};

type CloudCounts = {
  wordbook: number;
  wordNotes: number;
  notebook: number;
  notebookNotes: number;
  punches: number;
  savedAt: string;
} | null;

function readLocalCounts(): LocalCounts {
  const safeParse = <T,>(key: string, fallback: T): T => {
    try {
      const raw =
        typeof window === "undefined"
          ? null
          : window.localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  const wordbook = safeParse<Record<string, unknown>>("get:wordbook:v1", {});
  // wordNotes / notebookNotes moved to IndexedDB. Read them from the
  // in-memory cache maintained by the store modules — the caller is
  // responsible for having awaited the hydrate promise first.
  const wordNotes = readWordNotes();
  const notebook = safeParse<Record<string, unknown>>("get:notebook:v1", {});
  const notebookNotes = readNotebookNotes();
  const punches = safeParse<string[]>("get:punches:v1", []);
  const reviewLog = safeParse<Record<string, unknown>>(
    "get:review-log:v1",
    {},
  );
  const dailySnapshot = safeParse<{ date?: string; lemmas?: unknown[] } | null>(
    "get:daily-snapshot:v1",
    null,
  );
  const syncIdRaw =
    (typeof window !== "undefined"
      ? window.localStorage.getItem("get:syncId:v1")
      : "") || "";
  const fixed = process.env.NEXT_PUBLIC_SYNC_ID ?? "";
  const activeSyncId = fixed || syncIdRaw || "(none)";
  return {
    wordbook: Object.keys(wordbook).length,
    wordNotes: Object.keys(wordNotes).length,
    notebook: Object.keys(notebook).length,
    notebookNotes: Object.keys(notebookNotes).length,
    punches: Array.isArray(punches) ? punches.length : 0,
    reviewLog: Object.keys(reviewLog).length,
    dailySnapshot:
      dailySnapshot && dailySnapshot.date
        ? `${dailySnapshot.date} · ${
            Array.isArray(dailySnapshot.lemmas) ? dailySnapshot.lemmas.length : 0
          } 词`
        : "(空)",
    syncIdShort:
      activeSyncId.length > 12
        ? `${activeSyncId.slice(0, 6)}…${activeSyncId.slice(-4)}`
        : activeSyncId,
  };
}

function DiagnosticsCard() {
  const [local, setLocal] = useState<LocalCounts | null>(null);
  const [cloud, setCloud] = useState<CloudCounts>(null);
  const [cloudStatus, setCloudStatus] = useState<
    "idle" | "loading" | "ok" | "error"
  >("idle");
  const [cloudErr, setCloudErr] = useState("");

  useEffect(() => {
    // Ensure the IndexedDB-backed note caches are hydrated before we
    // read local counts, so wordNotes / notebookNotes reflect the true
    // on-device state instead of an empty pre-hydration cache.
    void (async () => {
      try {
        await Promise.all([
          hydrateNotesFromIdb(),
          hydrateNotebookNotesFromIdb(),
        ]);
      } catch {
        /* hydrators log their own errors */
      }
      setLocal(readLocalCounts());
    })();
  }, []);

  function refresh() {
    setLocal(readLocalCounts());
  }

  async function fetchCloud() {
    // The cloud snapshot is now split into per-store shards
    // (see /api/cos/sync route). Ask for each shard in parallel; a 404
    // means "nothing on cloud for this store yet" and is shown as 0, not
    // as an error. Any real error (network / 5xx / bad JSON) is surfaced.
    setCloudStatus("loading");
    setCloudErr("");
    const id = getSyncId();
    if (!id) {
      setCloudStatus("error");
      setCloudErr("未配置 syncId");
      return;
    }

    async function fetchShard(shard: string): Promise<unknown> {
      const res = await fetch(
        `/api/cos/sync?syncId=${encodeURIComponent(id)}&shard=${shard}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        throw new Error(`${shard}: HTTP ${res.status}`);
      }
      // Server returns `null` (200) when the shard object doesn't exist.
      return await res.json();
    }

    try {
      const [
        wordbookRaw,
        wordNotesRaw,
        notebookRaw,
        notebookNotesRaw,
        punchesRaw,
      ] = await Promise.all([
        fetchShard("wordbook"),
        fetchShard("wordNotes"),
        fetchShard("notebook"),
        fetchShard("notebookNotes"),
        fetchShard("punches"),
      ]);

      const asObj = (v: unknown): Record<string, unknown> =>
        v && typeof v === "object" && !Array.isArray(v)
          ? (v as Record<string, unknown>)
          : {};
      const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

      // Each shard is stored as { version, savedAt, data }. Older / bare
      // shards without an envelope are tolerated by falling back to the
      // raw value.
      const unwrap = (raw: unknown): unknown => {
        if (raw == null) return null;
        if (
          typeof raw === "object" &&
          raw !== null &&
          "data" in (raw as Record<string, unknown>)
        ) {
          return (raw as { data: unknown }).data;
        }
        return raw;
      };
      const savedAtOf = (raw: unknown): string => {
        const v = asObj(raw).savedAt;
        return typeof v === "string" ? v : "";
      };

      // Report the freshest savedAt across the five fetched shards.
      const savedAtCandidates = [
        wordbookRaw,
        wordNotesRaw,
        notebookRaw,
        notebookNotesRaw,
        punchesRaw,
      ]
        .map(savedAtOf)
        .filter(Boolean)
        .sort();
      const savedAt =
        savedAtCandidates.length > 0
          ? savedAtCandidates[savedAtCandidates.length - 1]
          : "(未知)";

      setCloud({
        wordbook: Object.keys(asObj(unwrap(wordbookRaw))).length,
        wordNotes: Object.keys(asObj(unwrap(wordNotesRaw))).length,
        notebook: Object.keys(asObj(unwrap(notebookRaw))).length,
        notebookNotes: Object.keys(asObj(unwrap(notebookNotesRaw))).length,
        punches: asArr(unwrap(punchesRaw)).length,
        savedAt,
      });
      setCloudStatus("ok");
    } catch (e) {
      setCloudStatus("error");
      setCloudErr(e instanceof Error ? e.message : String(e));
    }
  }

  if (!local) return null;

  const rows: Array<{ label: string; local: number | string; cloud?: number | string }> = [
    { label: "单词本 wordbook", local: local.wordbook, cloud: cloud?.wordbook },
    { label: "词笔记 wordNotes", local: local.wordNotes, cloud: cloud?.wordNotes },
    { label: "笔记本 notebook", local: local.notebook, cloud: cloud?.notebook },
    {
      label: "笔记本笔记 notebookNotes",
      local: local.notebookNotes,
      cloud: cloud?.notebookNotes,
    },
    { label: "打卡 punches", local: local.punches, cloud: cloud?.punches },
    { label: "复习日志 reviewLog", local: local.reviewLog },
    { label: "今日快照 dailySnapshot", local: local.dailySnapshot },
  ];

  return (
    <section className="rounded-xl border-2 border-dashed border-amber-400 bg-amber-50/40 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-amber-900">
          🔧 同步诊断
        </h2>
        <span className="text-[11px] text-amber-800/70">
          syncId: {local.syncIdShort}
        </span>
      </div>
      <p className="text-[11px] text-amber-800/80 leading-relaxed">
        显示本设备 localStorage 与云端快照的条数对比。若「本地 = 0 云端 &gt; 0」
        说明拉取没写入本机；若两侧都有但页面显示空，则是渲染 bug。
      </p>

      <div className="rounded-md bg-white/70 border border-amber-200 overflow-hidden">
        <div className="grid grid-cols-3 gap-2 border-b border-amber-200 bg-amber-100/50 px-3 py-1.5 text-[11px] font-medium text-amber-900">
          <span>数据</span>
          <span className="text-right">本地</span>
          <span className="text-right">云端</span>
        </div>
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-3 gap-2 border-b border-amber-100 px-3 py-1.5 text-xs last:border-b-0"
          >
            <span className="text-[var(--fg)] truncate">{r.label}</span>
            <span
              className={`text-right font-mono ${
                typeof r.local === "number" && r.local === 0
                  ? "text-red-600 font-bold"
                  : "text-[var(--fg)]"
              }`}
            >
              {r.local}
            </span>
            <span
              className={`text-right font-mono ${
                r.cloud === undefined
                  ? "text-[var(--fg-soft)]"
                  : typeof r.cloud === "number" &&
                    typeof r.local === "number" &&
                    r.cloud !== r.local
                  ? "text-orange-600 font-bold"
                  : "text-[var(--fg)]"
              }`}
            >
              {r.cloud ?? "—"}
            </span>
          </div>
        ))}
        {cloud && (
          <div className="border-t border-amber-200 bg-amber-100/30 px-3 py-1.5 text-[11px] text-amber-800">
            云端 savedAt: {cloud.savedAt}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={refresh}
          className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-50"
        >
          ↻ 重新读本地
        </button>
        <button
          type="button"
          onClick={fetchCloud}
          disabled={cloudStatus === "loading"}
          className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-50 disabled:opacity-50"
        >
          {cloudStatus === "loading" ? "查询中…" : "☁ 查询云端"}
        </button>
        {cloudStatus === "error" && (
          <span className="self-center text-[11px] text-red-600">
            云端查询失败：{cloudErr}
          </span>
        )}
      </div>
    </section>
  );
}
