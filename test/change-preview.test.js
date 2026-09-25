'use strict';

/* 交接记录变更影响预演引擎单元测试：node test/change-preview.test.js */

const assert = require('assert');
const { previewRecordChange, CHANGE } = require('../src/change-preview');
const { CONFLICT, WAREHOUSE } = require('../src/verify');
const { recordHash, applySignoff } = require('../src/signoff');

let seq = 0;
const t = (n) => 1000 + n;

function mkData(props, records, signoffs = []) {
  return {
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
    signoffs,
    rev: 7,
  };
}
function rec(propId, minute, from, to, id, note = '') {
  return { id: id || `r${seq++}`, propId, minute, from, to, note, createdAt: t(seq) };
}
/** 用引擎给一条记录补全双方有效签收（模拟服务端流程） */
function signBoth(data, recordId) {
  const record = data.records.find((r) => r.id === recordId);
  data.signoffs = applySignoff(data, recordId, 'from', record.from, recordHash(record)).signoffs;
  data.signoffs = applySignoff(data, recordId, 'to', record.to, recordHash(record)).signoffs;
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
function expectThrow(code, fn) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, '应当抛出异常');
  assert.strictEqual(threw.code, code);
}

// 1. 记录不存在 -> NOT_FOUND
test('记录不存在 -> 抛出 NOT_FOUND', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三', 'a')]);
  expectThrow('NOT_FOUND', () => previewRecordChange(data, 'nope', { delete: true }));
});

// 2. 修改参数校验：分钟非法 / 交出者空 / 接收者空 / 交出者 === 接收者
test('修改参数校验：与单条记录规则一致，非法输入 -> BAD_REQUEST', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三', 'a')]);
  expectThrow('BAD_REQUEST', () => previewRecordChange(data, 'a', { minute: -1, from: '仓库', to: '张三' }));
  expectThrow('BAD_REQUEST', () => previewRecordChange(data, 'a', { minute: 1, from: '', to: '张三' }));
  expectThrow('BAD_REQUEST', () => previewRecordChange(data, 'a', { minute: 1, from: '仓库', to: '' }));
  expectThrow('BAD_REQUEST', () => previewRecordChange(data, 'a', { minute: 1, from: '张三', to: '张三' }));
  expectThrow('BAD_REQUEST', () => previewRecordChange(data, 'a', {}));
});

// 3. 拟定内容与当前记录完全一致 -> BAD_REQUEST（无实际改动）
test('内容完全一致（无变化）-> BAD_REQUEST', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三', 'a', '备注')]);
  expectThrow('BAD_REQUEST', () =>
    previewRecordChange(data, 'a', { minute: 0, from: '仓库', to: '张三', note: '备注' }));
  // 首尾空白不视为变化（与录入规则一致：备注去空白）
  expectThrow('BAD_REQUEST', () =>
    previewRecordChange(data, 'a', { minute: 0, from: ' 仓库 ', to: '张三', note: ' 备注 ' }));
});

// 4. 修改分钟：变更前后都按同分钟唯一链重放，最终持有人不变
test('修改分钟（不改变交接关系）：前后均归仓，重放分钟随之变化', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', WAREHOUSE, 'b'),
  ]);
  const r = previewRecordChange(data, 'b', { minute: 5, from: '张三', to: WAREHOUSE, note: '' });
  assert.strictEqual(r.change.type, CHANGE.EDIT);
  assert.strictEqual(r.before.status, 'RETURNED');
  assert.strictEqual(r.before.finalHolder, WAREHOUSE);
  assert.strictEqual(r.after.status, 'RETURNED');
  assert.strictEqual(r.after.finalHolder, WAREHOUSE);
  assert.strictEqual(r.after.totalCount, 2);
  assert.strictEqual(r.after.conflict, null);
  assert.strictEqual(r.impacts.conflictChanged, false);
  assert.strictEqual(r.impacts.finalHolderChanged, false);
});

// 5. 删除记录：变更后记录数减少，链按剩余记录重放
test('删除记录：after 不含该记录，未归仓状态如实给出', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', WAREHOUSE, 'b'),
  ]);
  const r = previewRecordChange(data, 'b', { delete: true });
  assert.strictEqual(r.change.type, CHANGE.DELETE);
  assert.strictEqual(r.change.after, null);
  assert.strictEqual(r.before.status, 'RETURNED');
  assert.strictEqual(r.after.status, 'NOT_RETURNED');
  assert.strictEqual(r.after.totalCount, 1);
  assert.strictEqual(r.after.replayedCount, 1);
  assert.strictEqual(r.after.finalHolder, '张三');
  assert.strictEqual(r.after.returned, false);
  assert.strictEqual(r.impacts.finalHolderChanged, true);
});

// 6. 删除道具唯一一条记录：变更后无记录，最终持有人为仓库
test('删除唯一记录：变更后 NO_RECORDS，持有人回到仓库', () => {
  const data = mkData(['剑'], [rec('p0', 2, WAREHOUSE, '张三', 'a')]);
  const r = previewRecordChange(data, 'a', { delete: true });
  assert.strictEqual(r.after.status, 'NO_RECORDS');
  assert.strictEqual(r.after.totalCount, 0);
  assert.strictEqual(r.after.finalHolder, WAREHOUSE);
  assert.strictEqual(r.after.conflict, null);
});

// 7. 修改后引入断链冲突：before 无冲突，after 首个冲突被定位
test('改交出者使后续无法接续：after 第3分钟断链，最终持有人为冲突时持有人', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', '李四', 'b'),
    rec('p0', 8, '李四', WAREHOUSE, 'c'),
  ]);
  const r = previewRecordChange(data, 'a', { minute: 0, from: WAREHOUSE, to: '王五', note: '' });
  assert.strictEqual(r.before.conflict, null);
  assert.strictEqual(r.after.conflict.type, CONFLICT.BROKEN);
  assert.strictEqual(r.after.conflict.minute, 3);
  assert.strictEqual(r.after.finalHolder, '王五'); // 冲突发生时道具在王五手上
  assert.deepStrictEqual(r.after.conflict.records, ['b']);
  assert.strictEqual(r.impacts.conflictChanged, true);
});

// 8. 修改后化解歧义冲突：before 歧义，after 整链无冲突
test('改交出者化解同分钟歧义：after 整链可重放', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三', 'a'),
    rec('p0', 5, '张三', '王五', 'b'),
    rec('p0', 5, '张三', '赵六', 'c'),
  ]);
  // 把 b 改成 赵六 -> 王五：同分钟链式 张三->赵六->王五，唯一归约
  const r = previewRecordChange(data, 'b', { minute: 5, from: '赵六', to: '王五', note: '' });
  assert.strictEqual(r.before.conflict.type, CONFLICT.AMBIGUOUS);
  assert.strictEqual(r.before.conflict.minute, 5);
  assert.strictEqual(r.after.conflict, null);
  assert.strictEqual(r.after.status, 'NOT_RETURNED');
  assert.strictEqual(r.after.finalHolder, '王五');
  assert.strictEqual(r.after.replayedCount, 3);
  assert.strictEqual(r.impacts.conflictChanged, true);
});

// 9. 已核实前缀：变更前按当前内容指纹核对，缺签阻断记录与最后已核实持有人
test('已核实前缀与缺签阻断：首条缺签记录即阻断，其后记录不计入', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', '李四', 'b'),
    rec('p0', 8, '李四', WAREHOUSE, 'c'),
  ]);
  signBoth(data, 'a');
  signBoth(data, 'b');
  const r = previewRecordChange(data, 'c', { minute: 9, from: '李四', to: WAREHOUSE, note: '' });
  assert.strictEqual(r.before.verifiedCount, 2);
  assert.strictEqual(r.before.lastVerifiedHolder, '李四');
  assert.strictEqual(r.before.blocker.type, 'MISSING_SIGNOFF');
  assert.strictEqual(r.before.blocker.record.id, 'c');
  assert.deepStrictEqual(r.before.blocker.missingSides, ['from', 'to']);
});

// 10. 修改后被改记录旧签收失效：已核实前缀缩短，并列入失效签收清单
test('修改记录：旧签收在模拟中失效，前缀缩短，失效清单列出两侧签收', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', WAREHOUSE, 'b'),
  ]);
  signBoth(data, 'a');
  signBoth(data, 'b');
  const r = previewRecordChange(data, 'b', { minute: 4, from: '张三', to: WAREHOUSE, note: '' });
  // before：双方均签收 -> 已核实 2 条，无阻断
  assert.strictEqual(r.before.verifiedCount, 2);
  assert.strictEqual(r.before.blocker, null);
  // after：b 的旧签收失效 -> 前缀只剩 a，阻断在 b
  assert.strictEqual(r.after.verifiedCount, 1);
  assert.strictEqual(r.after.lastVerifiedHolder, '张三');
  assert.strictEqual(r.after.blocker.type, 'MISSING_SIGNOFF');
  assert.strictEqual(r.after.blocker.record.id, 'b');
  assert.deepStrictEqual(r.after.blocker.missingSides, ['from', 'to']);
  assert.strictEqual(r.invalidatedSignoffs.length, 2);
  assert.deepStrictEqual(r.invalidatedSignoffs.map((s) => s.side), ['from', 'to']);
  assert.strictEqual(r.invalidatedSignoffs[0].name, '张三');
  assert.strictEqual(r.invalidatedSignoffs[1].name, WAREHOUSE);
  assert.strictEqual(r.impacts.invalidatedSignoffCount, 2);
  assert.strictEqual(r.impacts.verifiedPrefixChanged, true);
});

// 11. 删除记录：其旧签收同样失效，剩余已核实前缀保留
test('删除记录：旧签收失效，剩余记录的已核实前缀保留', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', WAREHOUSE, 'b'),
  ]);
  signBoth(data, 'a');
  signBoth(data, 'b');
  const r = previewRecordChange(data, 'b', { delete: true });
  assert.strictEqual(r.after.verifiedCount, 1);
  assert.strictEqual(r.after.lastVerifiedHolder, '张三');
  assert.strictEqual(r.after.blocker, null); // 链走完无缺签
  assert.strictEqual(r.invalidatedSignoffs.length, 2);
});

// 12. 仅修改备注也使旧签收失效（内容指纹覆盖备注）
test('仅改备注：链结论不变，但旧签收失效、前缀缩短', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', WAREHOUSE, 'b'),
  ]);
  signBoth(data, 'a');
  signBoth(data, 'b');
  const r = previewRecordChange(data, 'b', { minute: 3, from: '张三', to: WAREHOUSE, note: '新备注' });
  assert.strictEqual(r.after.status, 'RETURNED');
  assert.strictEqual(r.after.verifiedCount, 1);
  assert.strictEqual(r.invalidatedSignoffs.length, 2);
  assert.strictEqual(r.impacts.finalHolderChanged, false);
  assert.strictEqual(r.impacts.conflictChanged, false);
});

// 13. 未被修改记录的签收仍按当前内容指纹核对：指纹不符的旧签收视为缺签
test('其他记录的指纹失效签收仍视为缺签（不因其旁的改动而恢复）', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', WAREHOUSE, 'b'),
  ]);
  signBoth(data, 'a');
  // b 上挂一条与当前内容不符的旧签收（指纹不一致）
  data.signoffs.push({
    recordId: 'b', side: 'from', name: '张三',
    recordHash: recordHash({ ...data.records[1], note: '旧内容' }), signedAt: 123,
  });
  data.signoffs.push({
    recordId: 'b', side: 'to', name: WAREHOUSE,
    recordHash: recordHash({ ...data.records[1], note: '旧内容' }), signedAt: 124,
  });
  const r = previewRecordChange(data, 'a', { minute: 1, from: WAREHOUSE, to: '张三', note: '' });
  // a 被修改 -> a 的旧签收失效；b 的签收本就指纹不符 -> 前缀为 0，阻断在 a
  assert.strictEqual(r.after.verifiedCount, 0);
  assert.strictEqual(r.after.lastVerifiedHolder, WAREHOUSE);
  assert.strictEqual(r.after.blocker.record.id, 'a');
  // 失效清单只列「当前仍有效」的签收：b 的指纹失效签收不在清单中
  assert.strictEqual(r.invalidatedSignoffs.length, 2);
  assert.ok(r.invalidatedSignoffs.every((s) => s.recordId === 'a'));
});

// 14. 目标记录当前无有效签收：失效清单为空
test('目标记录无有效签收：失效清单为空', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', WAREHOUSE, 'b'),
  ]);
  const r = previewRecordChange(data, 'b', { minute: 4, from: '张三', to: WAREHOUSE, note: '' });
  assert.strictEqual(r.invalidatedSignoffs.length, 0);
  assert.strictEqual(r.impacts.invalidatedSignoffCount, 0);
});

// 15. 原链冲突作为已核实前缀的阻断点（链上记录均已签收时）
test('原链冲突：链上记录双方签收齐全时，阻断原因为 CONFLICT', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三', 'a'),
    rec('p0', 5, '张三', '王五', 'b'),
    rec('p0', 5, '张三', '赵六', 'c'),
  ]);
  signBoth(data, 'a');
  const r = previewRecordChange(data, 'a', { minute: 2, from: WAREHOUSE, to: '张三', note: '' });
  assert.strictEqual(r.before.verifiedCount, 1);
  assert.strictEqual(r.before.lastVerifiedHolder, '张三');
  assert.strictEqual(r.before.blocker.type, 'CONFLICT');
  assert.strictEqual(r.before.blocker.conflict.minute, 5);
});

// 16. 只重放该道具的记录；结果携带数据版本 rev 与只读标记
test('只涉及目标道具的链；结果带 rev 与 readOnly', () => {
  const data = mkData(['剑', '印'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', WAREHOUSE, 'b'),
    rec('p1', 0, WAREHOUSE, '周八', 'x'),
  ]);
  const r = previewRecordChange(data, 'b', { minute: 4, from: '张三', to: WAREHOUSE, note: '' });
  assert.strictEqual(r.before.totalCount, 2);
  assert.strictEqual(r.after.totalCount, 2);
  assert.strictEqual(r.record.propId, 'p0');
  assert.strictEqual(r.record.propName, '剑');
  assert.strictEqual(r.rev, 7);
  assert.strictEqual(r.readOnly, true);
});

// 17. 数据本身不被修改：预演前后 records / signoffs 原样不动
test('只读：预演不改动传入的 records 与 signoffs', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 'a'),
    rec('p0', 3, '张三', WAREHOUSE, 'b'),
  ]);
  signBoth(data, 'a');
  signBoth(data, 'b');
  const recordsSnapshot = JSON.stringify(data.records);
  const signoffsSnapshot = JSON.stringify(data.signoffs);
  previewRecordChange(data, 'b', { minute: 4, from: '张三', to: '李四', note: 'x' });
  previewRecordChange(data, 'a', { delete: true });
  assert.strictEqual(JSON.stringify(data.records), recordsSnapshot);
  assert.strictEqual(JSON.stringify(data.signoffs), signoffsSnapshot);
});

// 18. 删除模式忽略其他字段：delete=true 即按删除模拟
test('delete=true：忽略分钟等字段，按删除模拟', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三', 'a')]);
  const r = previewRecordChange(data, 'a', { delete: true, minute: 'bad', from: '', to: '' });
  assert.strictEqual(r.change.type, CHANGE.DELETE);
  assert.strictEqual(r.after.status, 'NO_RECORDS');
});

console.log(`\n全部 ${passed} 个变更影响预演引擎测试通过 ✔`);
