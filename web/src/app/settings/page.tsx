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
import { getSyncId, setSyncId, push, pull } from "@/lib/sync/cloud";
import {
  getDailyCapActive,
  getDailyCapPassive,
  setDailyCapActive,
  setDailyCapPassive,
  DAILY_CAP_CHOICES,
} from "@/lib/wordbook/preferences";

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
  const [pullStatus, setPullStatus] = useState<Status>("idle");
  const [importStatus, setImportStatus] = useState<Status>("idle");
  const [importMsg, setImportMsg] = useState("");
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
    try {
      await push();
      setPushStatus("ok");
    } catch {
      setPushStatus("error");
    }
    setTimeout(() => setPushStatus("idle"), 3000);
  }

  async function handlePull() {
    setPullStatus("loading");
    try {
      const result = await pull();
      setPullStatus(result.error ? "error" : "ok");
    } catch {
      setPullStatus("error");
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

      {/* ── My Sync Code ─────────────────────────────────────── */}
      <section className="rounded-xl border border-[var(--border)] p-5 space-y-3">
        <h2 className="font-medium text-base">我的 Sync Code</h2>
        <p className="text-sm text-[var(--fg-soft)]">
          这是本设备的唯一同步标识。把它分享给你的另一台设备，就能让两台设备共用同一份数据。
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-lg bg-[var(--surface)] border border-[var(--border)] px-3 py-2 text-xs font-mono tracking-wide break-all select-all">
            {syncId || "生成中…"}
          </code>
          <button
            onClick={handleCopy}
            className="shrink-0 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 active:scale-95"
          >
            {copied ? "已复制 ✓" : "复制"}
          </button>
        </div>
      </section>

      {/* ── Import Code from another device ──────────────────── */}
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
        <StatusBadge status={pushStatus} msg="上传成功" />
        <StatusBadge status={pullStatus} msg="拉取并合并成功" />
      </section>

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
