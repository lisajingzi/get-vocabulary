/**
 * 单词组（group）管理 —— 轻量方案 A。
 *
 * 背景：wordbook 里每个词条自带一个 `group?: string` 字段，用来把词分到自
 * 定义的组（如 "List 1" / "真经5-Unit3"）。我们没有一张独立的"组表"，组
 * 的真相是"所有词条 group 字段去重"。
 *
 * 但用户在设置页"新建组"时，这个组还是空的（没有词属于它），单靠聚合拿
 * 不到。所以额外把这些空的、预建的组名记在 localStorage 里，叫做
 * `preseededGroups`。
 *
 * 真·可见组列表 = 聚合词条 group 字段 ∪ 预建组名。
 *
 * 删除组 = 把该组下所有词条的 group 清空 + 从预建列表里剔除。词条本身保留，
 * ielts 标记也不动（ielts 与 group 两个字段完全正交）。
 */

import { listEntries, setGroup } from "./local";

const PRESEEDED_KEY = "get:wordbook:groups:preseeded:v1";

function readPreseeded(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PRESEEDED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  } catch {
    return [];
  }
}

function writePreseeded(list: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PRESEEDED_KEY, JSON.stringify(list));
  } catch {
    /* quota / privacy mode — ignore, 组只是个便利分类，丢了不影响单词本 */
  }
}

/**
 * 列出所有可见组名（有词的组 + 预建的空组），按字母顺序排列，带每组
 * 的词数（空预建组 count=0）。
 */
export function listAllGroups(): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();

  // 聚合所有词条的 group 字段（含 archived；archived 不算活跃但仍占组名）。
  for (const entry of listEntries({ includeArchived: true })) {
    const g = entry.group?.trim();
    if (!g) continue;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }

  // 补上还没有任何词的预建组。
  for (const g of readPreseeded()) {
    if (!counts.has(g)) counts.set(g, 0);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/** 返回去重后的组名数组，便于下拉展示（无词数）。 */
export function listGroupNames(): string[] {
  return listAllGroups().map((g) => g.name);
}

/**
 * 新建一个组名。
 *
 * - 名字会 trim；空字符串被拒绝。
 * - 若该组名已经有词在用、或已经在预建列表里，直接返回 false（不算错，只
 *   是没新增）。
 * - 不去主动给任何词打标，只是把"空组"登记进预建列表。
 */
export function createGroup(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  // 已在可见组列表（含词 or 预建）里 → 无需新增。
  if (listGroupNames().includes(trimmed)) return false;
  const next = [...readPreseeded(), trimmed];
  writePreseeded(next);
  return true;
}

/**
 * 删除一个组。
 *
 * 行为：
 *  - 把所有 group===name 的词条清空其 group 字段（词本身保留；ielts 标记
 *    不动）。
 *  - 从预建列表里剔除该组名。
 *
 * 返回被清组的词条数量，便于 UI 反馈。
 */
export function deleteGroup(name: string): number {
  const trimmed = name.trim();
  if (!trimmed) return 0;
  let affected = 0;
  for (const entry of listEntries({ includeArchived: true })) {
    if ((entry.group?.trim() ?? "") === trimmed) {
      setGroup(entry.lemma, ""); // 内部把空串视作清空 → group=undefined
      affected += 1;
    }
  }
  const next = readPreseeded().filter((g) => g !== trimmed);
  writePreseeded(next);
  return affected;
}
