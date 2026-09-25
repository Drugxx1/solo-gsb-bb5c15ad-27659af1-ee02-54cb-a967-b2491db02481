'use strict';

/**
 * 交接记录变更影响预演引擎（只读，生成即时模拟结果，不写入任何记录 / 签收）。
 *
 * 从记录表选定一条记录，拟定一次改动（修改分钟 / 交出者 / 接收者 / 备注，
 * 或删除该记录），引擎按现有规则校验后做**只读模拟**：
 *
 * - 针对该道具分别按**同分钟唯一链**规则重放「变更前」与「变更后」的全部记录，
 *   给出两侧的首个冲突（类型 / 分钟 / 定位记录）与最终持有人；
 * - 同时按**当前内容指纹**核对双方签收，给出两侧的已核实前缀
 *   （开头连续、双方均有效签收的记录）及其阻断记录（首条缺签或原链冲突）；
 * - 模拟「变更后」时，被修改 / 被删除记录的旧签收一律视为失效
 *   （与真实编辑 / 删除时服务端清除签收的行为一致），
 *   并单列「因此失效的签收」清单，供工作人员判断一次改动会影响哪些后续核实结果。
 *
 * 结果携带数据版本号 `rev`：预演后数据被修改时，页面据此提示重新预演。
 * 引擎只读取数据并即时计算，不写入任何交接记录或签收。
 */

const { WAREHOUSE, sortRecords, replayPropRecords } = require('./verify');
const { signoffView } = require('./signoff');

/** 变更类型 */
const CHANGE = {
  EDIT: 'EDIT',     // 修改记录的分钟 / 交出者 / 接收者 / 备注
  DELETE: 'DELETE', // 删除该记录
};

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function recordRef(r) {
  return {
    id: r.id,
    minute: r.minute,
    from: r.from,
    to: r.to,
    note: r.note || '',
  };
}

/**
 * 校验拟定的修改内容（与单条记录录入规则完全一致：
 * 分钟为不小于 0 的整数，交出者 / 接收者非空且不得相同，备注去首尾空白）。
 * 道具不可变更（恒为原记录所属道具）。
 */
function validateChange(body) {
  if (body && body.delete === true) return { type: CHANGE.DELETE };

  const raw = body || {};
  if (raw.minute === undefined || raw.minute === null || raw.minute === '') {
    throw fail('BAD_REQUEST', '分钟不能为空');
  }
  const minute = Number(raw.minute);
  if (!Number.isInteger(minute) || minute < 0) {
    throw fail('BAD_REQUEST', '分钟必须是不小于 0 的整数（分钟）');
  }
  const from = typeof raw.from === 'string' ? raw.from.trim() : '';
  if (!from) throw fail('BAD_REQUEST', '交出者不能为空');
  const to = typeof raw.to === 'string' ? raw.to.trim() : '';
  if (!to) throw fail('BAD_REQUEST', '接收者不能为空');
  if (from === to) throw fail('BAD_REQUEST', '交出者与接收者不能相同');

  return {
    type: CHANGE.EDIT,
    after: {
      minute,
      from,
      to,
      note: typeof raw.note === 'string' ? raw.note.trim() : '',
    },
  };
}

/**
 * 沿重放链计算已核实前缀：只有交出者与接收者均有效签收
 * （签收指纹与记录当前内容一致，由 signoffView 校验）的记录才延伸前缀；
 * 遇首条缺签记录即停止，该记录即阻断记录。
 */
function verifiedPrefixOf(chain, signoffs) {
  const verified = [];
  let lastVerifiedHolder = WAREHOUSE;
  let blocker = null;

  for (const rec of chain) {
    const view = signoffView(rec, signoffs);
    if (view.from && view.to) {
      verified.push(recordRef(rec));
      lastVerifiedHolder = rec.to;
    } else {
      const missingSides = [];
      if (!view.from) missingSides.push('from');
      if (!view.to) missingSides.push('to');
      blocker = { type: 'MISSING_SIGNOFF', minute: rec.minute, record: recordRef(rec), missingSides };
      break;
    }
  }
  return { verified, lastVerifiedHolder, blocker };
}

/**
 * 对一组记录（某道具变更前 / 后的全部记录）做一次完整模拟：
 * 同分钟唯一链重放 + 已核实前缀核对。
 */
function simulateChain(records, signoffs) {
  const sorted = sortRecords(records);
  const replay = replayPropRecords(sorted);

  const { verified, lastVerifiedHolder, blocker: signoffBlocker } =
    verifiedPrefixOf(replay.chain, signoffs);

  // 已核实前缀走完重放链后，原链本身的冲突即为阻断点
  let blocker = signoffBlocker;
  if (!blocker && !replay.ok) {
    blocker = {
      type: 'CONFLICT',
      minute: replay.conflict.minute,
      conflict: {
        type: replay.conflict.type,
        minute: replay.conflict.minute,
        reason: replay.conflict.reason,
        records: replay.conflict.records,
      },
    };
  }

  let status;
  if (!replay.ok) status = 'CONFLICT';
  else if (sorted.length === 0) status = 'NO_RECORDS';
  else if (replay.holder === WAREHOUSE) status = 'RETURNED';
  else status = 'NOT_RETURNED';

  return {
    status,
    totalCount: sorted.length,
    replayedCount: replay.chain.length,
    // 最终持有人：链完整重放时为演出结束持有人；链冲突时为冲突发生时的当前持有人
    finalHolder: replay.holder,
    returned: replay.ok && replay.holder === WAREHOUSE,
    conflict: replay.ok
      ? null
      : {
          type: replay.conflict.type,
          minute: replay.conflict.minute,
          holder: replay.conflict.holder,
          reason: replay.conflict.reason,
          records: replay.conflict.records,
        },
    verifiedCount: verified.length,
    verifiedPrefix: verified,
    lastVerifiedHolder,
    blocker,
  };
}

function sameConflict(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.minute === b.minute;
}

function sameBlocker(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'CONFLICT') return sameConflict(a.conflict, b.conflict);
  return a.record.id === b.record.id && a.missingSides.join(',') === b.missingSides.join(',');
}

/**
 * 对一条记录拟定的改动做影响预演（只读）。
 *
 * @param {{props: Array, records: Array, signoffs: Array, rev: number}} data 当前数据（只读）
 * @param {string} recordId 目标记录 id
 * @param {object} body 拟定改动：`{ delete: true }` 或 `{ minute, from, to, note? }`
 * @returns {object} 变更前 / 后模拟结果与失效签收清单（含数据版本 rev）
 * @throws {{code: 'NOT_FOUND'|'BAD_REQUEST'}}
 */
function previewRecordChange(data, recordId, body) {
  const records = data.records || [];
  const signoffs = data.signoffs || [];

  const record = records.find((r) => r.id === recordId);
  if (!record) {
    throw fail('NOT_FOUND', '记录不存在或已被删除，请刷新页面后重新选择');
  }
  const prop = (data.props || []).find((p) => p.id === record.propId);

  const change = validateChange(body);

  if (change.type === CHANGE.EDIT) {
    const a = change.after;
    if (
      a.minute === Number(record.minute) &&
      a.from === record.from &&
      a.to === record.to &&
      a.note === (record.note || '')
    ) {
      throw fail('BAD_REQUEST', '拟定内容与当前记录完全一致，请修改至少一项（分钟 / 交出者 / 接收者 / 备注）或选择删除');
    }
  }

  // 该道具变更前的全部记录
  const propRecords = records.filter((r) => r.propId === record.propId);

  // 变更后的记录集合：删除 -> 移除该记录；修改 -> 以新内容替换（保留 id 与录入时间，
  // 与真实修改行为一致：同一分钟仍按最初录入先后重放）
  let afterRecords;
  if (change.type === CHANGE.DELETE) {
    afterRecords = propRecords.filter((r) => r.id !== record.id);
  } else {
    const updated = { ...record, ...change.after };
    afterRecords = propRecords.map((r) => (r.id === record.id ? updated : r));
  }

  // 变更后模拟：被修改 / 被删除记录的旧签收立即失效（与真实编辑 / 删除行为一致），
  // 其余记录的签收仍按当前内容指纹核对
  const afterSignoffs = signoffs.filter((s) => s.recordId !== record.id);

  const before = simulateChain(propRecords, signoffs);
  const after = simulateChain(afterRecords, afterSignoffs);

  // 因此失效的签收：该记录当前仍有效的两侧签收（变更后一律失效）
  const currentView = signoffView(record, signoffs);
  const invalidatedSignoffs = [];
  for (const side of ['from', 'to']) {
    const v = currentView[side];
    if (v) {
      invalidatedSignoffs.push({
        recordId: record.id,
        side,
        sideText: side === 'from' ? '交出者' : '接收者',
        name: v.name,
        signedAt: v.signedAt,
      });
    }
  }

  const impacts = {
    conflictChanged: !sameConflict(before.conflict, after.conflict),
    finalHolderChanged: before.finalHolder !== after.finalHolder,
    verifiedPrefixChanged:
      before.verifiedCount !== after.verifiedCount ||
      before.lastVerifiedHolder !== after.lastVerifiedHolder,
    blockerChanged: !sameBlocker(before.blocker, after.blocker),
    invalidatedSignoffCount: invalidatedSignoffs.length,
  };

  return {
    warehouse: WAREHOUSE,
    rev: data.rev,
    readOnly: true,
    record: {
      ...recordRef(record),
      propId: record.propId,
      propName: prop ? prop.name : null,
    },
    change: {
      type: change.type,
      after: change.type === CHANGE.EDIT ? { ...change.after } : null,
    },
    before,
    after,
    invalidatedSignoffs,
    impacts,
  };
}

module.exports = { CHANGE, previewRecordChange };
