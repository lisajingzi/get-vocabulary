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
 *
 * 云同步
 * ------
 * 预建组名（含“曾经存在、后来被删掉”的 tombstone）会作为 `groups` 分片同步到
 * 云端。每个组名带一个 `updatedAt`，merge 时按时间戳 last-write-wins，这样
 * 另一台设备上的删除（tombstone 时间戳更新）能正确传播，而不会被本地的旧
 * 字符串数组“复活”。
 *
 * 兼容旧格式：localStorage 里可能还是 `string[]`（旧版本写入），读取时自动
 * 迁移为带时间戳的结构。
 */

import { listEntries, setGroup } from "./local";

const PRESEEDED_KEY = "get:wordbook:groups:preseeded:v2";
const LEGACY_PRESEEDED_KEY = "get:wordbook:groups:preseeded:v1";

export interface GroupRecord {
  /** 组名（已 trim）。 */
  name: string;
  /** 最近一次创建/删除的时间戳。deleted=true 时表示 tombstone。 */
  updatedAt: string;
  /** true = 该组已被删除（tombstone，用于同步传播删除操作）。 */
  deleted?: boolean;
}

/** 组名 → 记录。 */
export type GroupsStore = Record<string, GroupRecord>;

/**
 * Read the groups store, auto-migrating the legacy `string[]` layout.
 * Exported so the cloud sync layer can read/merge it. Returns a plain
 * object (SSR-safe: empty when window is unavailable).
 */
export function readGroupsStore(): GroupsStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PRESEEDED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: GroupsStore = {};
        for (const [name, rec] of Object.entries(parsed as GroupsStore)) {
          if (!rec || typeof rec !== "object") continue;
          const n = (rec.name ?? name).trim();
          if (!n) continue;
          out[n] = {
            name: n,
            updatedAt:
              typeof rec.updatedAt === "string"
                ? rec.updatedAt
                : new Date(0).toISOString(),
            deleted: rec.deleted === true,
          };
        }
        return out;
      }
      // Unexpected shape — fall through to legacy migration.
    }

    // Legacy migration: v1 stored a bare string[]. Stamp every entry with
    // the epoch so that any real cloud tombstone (with a sane timestamp)
    // wins the merge and can delete these entries.
    const legacyRaw = window.localStorage.getItem(LEGACY_PRESEEDED_KEY);
    if (!legacyRaw) return {};
    const legacyParsed = JSON.parse(legacyRaw);
    if (!Array.isArray(legacyParsed)) return {};
    const migrated: GroupsStore = {};
    const epoch = new Date(0).toISOString();
    for (const v of legacyParsed) {
      if (typeof v !== "string") continue;
      const n = v.trim();
      if (!n) continue;
      migrated[n] = { name: n, updatedAt: epoch };
    }
    // Persist the migrated shape so we don't redo this every read.
    try {
      window.localStorage.setItem(PRESEEDED_KEY, JSON.stringify(migrated));
      window.localStorage.removeItem(LEGACY_PRESEEDED_KEY);
    } catch {
      /* quota — keep the in-memory migration result anyway */
    }
    return migrated;
  } catch {
    return {};
  }
}

/**
 * Write the groups store. Dispatches a change event so the settings page
 * re-renders and the sync layer flags the shard dirty.
 */
export function writeGroupsStore(store: GroupsStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PRESEEDED_KEY, JSON.stringify(store));
  } catch (e) {
    // Groups are a convenience index; never let a quota error break the
    // wordbook itself.
    console.warn("[groups] writeGroupsStore failed", e);
  }
  window.dispatchEvent(new CustomEvent("get:groups-change"));
}

/**
 * Merge two groups stores, last-write-wins per group name by `updatedAt`.
 * Tombstones (deleted=true) participate like any other record, so a newer
 * deletion overwrites an older live entry and vice-versa.
 */
export function mergeGroupsStore(
  local: GroupsStore,
  remote: GroupsStore,
): GroupsStore {
  const merged: GroupsStore = { ...local };
  for (const [name, remoteRec] of Object.entries(remote)) {
    if (!remoteRec || typeof remoteRec !== "object") continue;
    const localRec = merged[name];
    if (!localRec || remoteRec.updatedAt > localRec.updatedAt) {
      merged[name] = remoteRec;
    }
  }
  return merged;
}

/** Live (non-deleted) preselected group names, in insertion order. */
function readPreseeded(): string[] {
  const store = readGroupsStore();
  return Object.values(store)
    .filter((r) => !r.deleted)
    .map((r) => r.name)
    .filter((n) => n.length > 0);
}

/** Create or delete a single group entry in the store. */
function setPreseeded(name: string, deleted: boolean): void {
  const store = readGroupsStore();
  const trimmed = name.trim();
  if (!trimmed) return;
  store[trimmed] = {
    name: trimmed,
    updatedAt: new Date().toISOString(),
    ...(deleted ? { deleted: true } : {}),
  };
  writeGroupsStore(store);
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
  setPreseeded(trimmed, false);
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
  // 写入 tombstone（带当前时间戳），让删除操作能同步到其它设备。
  setPreseeded(trimmed, true);
  return affected;
}
