function mergeGroupsStore(local, remote) {
  const merged = { ...local };
  for (const [name, remoteRec] of Object.entries(remote)) {
    if (!remoteRec || typeof remoteRec !== "object") continue;
    const localRec = merged[name];
    if (!localRec || remoteRec.updatedAt > localRec.updatedAt) {
      merged[name] = remoteRec;
    }
  }
  return merged;
}

const T1 = "2026-11-23T10:00:00.000Z";
const T2 = "2026-11-24T10:00:00.000Z";

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

console.log("1. tombstone overrides stale local entry");
{
  const local = { "g1": { name: "g1", updatedAt: T1 } };
  const remote = { "g1": { name: "g1", updatedAt: T2, deleted: true } };
  const m = mergeGroupsStore(local, remote);
  check("deletion applied", m["g1"].deleted === true);
  check("timestamp updated", m["g1"].updatedAt === T2);
}

console.log("2. local newer than remote tombstone -> survives");
{
  const local = { "List1": { name: "List1", updatedAt: T2 } };
  const remote = { "List1": { name: "List1", updatedAt: T1, deleted: true } };
  const m = mergeGroupsStore(local, remote);
  check("local kept", !m["List1"].deleted && m["List1"].updatedAt === T2);
}

console.log("3. re-create after tombstone");
{
  const local = { "A": { name: "A", updatedAt: T1, deleted: true } };
  const remote = { "A": { name: "A", updatedAt: T2 } };
  const m = mergeGroupsStore(local, remote);
  check("resurrected", !m["A"].deleted && m["A"].updatedAt === T2);
}

console.log("4. union of distinct groups");
{
  const local = { "L": { name: "L", updatedAt: T1 } };
  const remote = { "R": { name: "R", updatedAt: T1 } };
  const m = mergeGroupsStore(local, remote);
  check("L kept", !!m["L"]);
  check("R kept", !!m["R"]);
}

console.log("5. empty / invalid input");
{
  check("empty", Object.keys(mergeGroupsStore({}, {})).length === 0);
  check("null record skipped", Object.keys(mergeGroupsStore({}, { "X": null })).length === 0);
  check("string record skipped", Object.keys(mergeGroupsStore({}, { "Y": "junk" })).length === 0);
}

console.log("6. equal timestamps -> local wins");
{
  const local = { "S": { name: "S", updatedAt: T1 } };
  const remote = { "S": { name: "S", updatedAt: T1, deleted: true } };
  const m = mergeGroupsStore(local, remote);
  check("local wins", !m["S"].deleted);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
