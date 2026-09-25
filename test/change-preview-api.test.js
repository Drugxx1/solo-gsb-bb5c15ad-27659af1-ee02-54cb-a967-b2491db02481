'use strict';

/* 交接记录变更影响预演接口集成测试：node test/change-preview-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-change-preview-api-store.json');
process.env.DATA_FILE = DATA_FILE;

for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
  try { fs.unlinkSync(f); } catch { /* 不存在则忽略 */ }
}

const app = require('../server');

let server;
let base;
let passed = 0;

async function api(url, options = {}) {
  const res = await fetch(`${base}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** 取记录当前内容指纹并签收指定一侧 */
async function sign(recordId, side, name) {
  const cur = (await api(`/api/records/${recordId}/signoff`)).body;
  return api(`/api/records/${recordId}/signoff`, {
    method: 'POST',
    body: JSON.stringify({ side, name, recordHash: cur.recordHash }),
  });
}
async function signBoth(recordId, from, to) {
  await sign(recordId, 'from', from);
  await sign(recordId, 'to', to);
}

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // 初始演示数据：青龙剑 p_sword（r_sw1..r_sw4 完整归仓链）、折扇 p_fan（第5分钟歧义冲突）、
  // 宫灯 p_lantern（断链冲突）、御印 p_seal（未归仓）
  const state0 = (await api('/api/state')).body;
  assert.ok(state0.props.some((p) => p.id === 'p_sword'));

  // 1. 修改预演：变更前后并排结果完整返回，携带数据版本 rev，且只读不落盘
  await test('修改预演：before/after 结构与 rev 完整，只读不写数据', async () => {
    const revBefore = (await api('/api/state')).body.rev;
    const res = await api('/api/records/r_sw4/change-preview', {
      method: 'POST',
      body: JSON.stringify({ minute: 12, from: '张三', to: '李四', note: '改接收者' }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.readOnly, true);
    assert.strictEqual(res.body.rev, revBefore);
    assert.strictEqual(res.body.record.id, 'r_sw4');
    assert.strictEqual(res.body.record.propName, '青龙剑');
    assert.strictEqual(res.body.change.type, 'EDIT');
    assert.strictEqual(res.body.change.after.to, '李四');
    // before：完整归仓链；after：第12分钟 张三->李四，道具留在李四手上（未归仓）
    assert.strictEqual(res.body.before.status, 'RETURNED');
    assert.strictEqual(res.body.before.finalHolder, '仓库');
    assert.strictEqual(res.body.after.status, 'NOT_RETURNED');
    assert.strictEqual(res.body.after.finalHolder, '李四');
    assert.strictEqual(res.body.impacts.finalHolderChanged, true);
    // 只读：数据版本与记录数不变
    const state = (await api('/api/state')).body;
    assert.strictEqual(state.rev, revBefore);
    assert.strictEqual(state.records.length, state0.records.length);
  });

  // 2. 删除预演：change.type=DELETE，after 记录数减一
  await test('删除预演：after 不含该记录，未归仓如实给出', async () => {
    const res = await api('/api/records/r_sw4/change-preview', {
      method: 'POST',
      body: JSON.stringify({ delete: true }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.change.type, 'DELETE');
    assert.strictEqual(res.body.change.after, null);
    assert.strictEqual(res.body.before.totalCount, 4);
    assert.strictEqual(res.body.after.totalCount, 3);
    assert.strictEqual(res.body.after.status, 'NOT_RETURNED');
    assert.strictEqual(res.body.after.finalHolder, '张三');
  });

  // 3. 修改后引入冲突：after 首个冲突被定位（分钟 / 类型 / 记录）
  await test('修改预演：改动引入断链冲突，after 定位首个冲突', async () => {
    // 把 r_sw1 的接收者改成王五：第3分钟 张三->李四 无法接续（道具在王五手上）
    const res = await api('/api/records/r_sw1/change-preview', {
      method: 'POST',
      body: JSON.stringify({ minute: 0, from: '仓库', to: '王五', note: '开场领出' }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.before.conflict, null);
    assert.strictEqual(res.body.after.conflict.type, 'BROKEN');
    assert.strictEqual(res.body.after.conflict.minute, 3);
    assert.deepStrictEqual(res.body.after.conflict.records, ['r_sw2']);
    assert.strictEqual(res.body.impacts.conflictChanged, true);
  });

  // 4. 签收影响：被修改记录的旧签收在模拟中失效，失效清单列出
  await test('签收影响：被改记录旧签收失效并列入清单，已核实前缀缩短', async () => {
    await signBoth('r_sw1', '仓库', '张三');
    await signBoth('r_sw2', '张三', '李四');
    const res = await api('/api/records/r_sw2/change-preview', {
      method: 'POST',
      body: JSON.stringify({ minute: 3, from: '张三', to: '李四', note: '改备注' }),
    });
    assert.strictEqual(res.status, 200);
    // before：r_sw1、r_sw2 双方签收齐全 -> 已核实 2 条，阻断在 r_sw3（缺签）
    assert.strictEqual(res.body.before.verifiedCount, 2);
    assert.strictEqual(res.body.before.lastVerifiedHolder, '李四');
    assert.strictEqual(res.body.before.blocker.type, 'MISSING_SIGNOFF');
    assert.strictEqual(res.body.before.blocker.record.id, 'r_sw3');
    // after：r_sw2 旧签收失效 -> 前缀只剩 r_sw1，阻断在 r_sw2
    assert.strictEqual(res.body.after.verifiedCount, 1);
    assert.strictEqual(res.body.after.lastVerifiedHolder, '张三');
    assert.strictEqual(res.body.after.blocker.record.id, 'r_sw2');
    assert.deepStrictEqual(res.body.after.blocker.missingSides, ['from', 'to']);
    // 失效清单：r_sw2 的两侧签收
    assert.strictEqual(res.body.invalidatedSignoffs.length, 2);
    assert.deepStrictEqual(res.body.invalidatedSignoffs.map((s) => s.side), ['from', 'to']);
    assert.strictEqual(res.body.invalidatedSignoffs[0].recordId, 'r_sw2');
    assert.strictEqual(res.body.impacts.invalidatedSignoffCount, 2);
    assert.strictEqual(res.body.impacts.verifiedPrefixChanged, true);
  });

  // 5. 预演只读：真实签收状态不因预演改变
  await test('预演只读：签收与数据版本不因预演改变', async () => {
    const revBefore = (await api('/api/state')).body.rev;
    await api('/api/records/r_sw2/change-preview', {
      method: 'POST',
      body: JSON.stringify({ delete: true }),
    });
    const state = (await api('/api/state')).body;
    assert.strictEqual(state.rev, revBefore);
    assert.ok(state.signoffStatus.r_sw2 && state.signoffStatus.r_sw2.from);
    assert.ok(state.records.some((r) => r.id === 'r_sw2'));
  });

  // 6. 参数校验：非法分钟 / 空姓名 / 交出者=接收者 / 无变化 -> 400
  await test('参数校验：非法改动 -> 400', async () => {
    const bad1 = await api('/api/records/r_sw1/change-preview', {
      method: 'POST',
      body: JSON.stringify({ minute: -1, from: '仓库', to: '张三' }),
    });
    assert.strictEqual(bad1.status, 400);
    const bad2 = await api('/api/records/r_sw1/change-preview', {
      method: 'POST',
      body: JSON.stringify({ minute: 0, from: '', to: '张三' }),
    });
    assert.strictEqual(bad2.status, 400);
    const bad3 = await api('/api/records/r_sw1/change-preview', {
      method: 'POST',
      body: JSON.stringify({ minute: 0, from: '张三', to: '张三' }),
    });
    assert.strictEqual(bad3.status, 400);
    // 与当前内容完全一致（无实际改动）
    const cur = (await api('/api/records/r_sw1/signoff')).body.record;
    const bad4 = await api('/api/records/r_sw1/change-preview', {
      method: 'POST',
      body: JSON.stringify({ minute: cur.minute, from: cur.from, to: cur.to, note: cur.note }),
    });
    assert.strictEqual(bad4.status, 400);
    assert.ok(/完全一致/.test(bad4.body.error));
  });

  // 7. 记录不存在 -> 404
  await test('记录不存在 -> 404', async () => {
    const res = await api('/api/records/r_nope/change-preview', {
      method: 'POST',
      body: JSON.stringify({ delete: true }),
    });
    assert.strictEqual(res.status, 404);
  });

  // 8. 真实修改后重新预演：rev 随落盘变化，页面可据此提示重新预演
  await test('真实修改后 rev 变化，新预演携带新版本', async () => {
    const before = await api('/api/records/r_se2/change-preview', {
      method: 'POST',
      body: JSON.stringify({ minute: 6, from: '周八', to: '孙七', note: 'x' }),
    });
    assert.strictEqual(before.status, 200);
    const put = await api('/api/records/r_se2', {
      method: 'PUT',
      body: JSON.stringify({ propId: 'p_seal', minute: 6, from: '周八', to: '孙七', note: '已改' }),
    });
    assert.strictEqual(put.status, 200);
    const after = await api('/api/records/r_se2/change-preview', {
      method: 'POST',
      body: JSON.stringify({ minute: 6, from: '周八', to: '孙七', note: 'y' }),
    });
    assert.strictEqual(after.status, 200);
    assert.ok(after.body.rev > before.body.rev);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个变更影响预演接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
