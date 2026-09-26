'use strict';

// 节奏校验自检（node test/pacing.js）
// 覆盖：基本超限与最短路线、非高强度清零、含环累计（自环 / 往返环 / 环上逃逸口）、
//       选项条件与场景前置条件阻断、选项 / 场景赋值改变变量状态并入去重键、
//       多路线取最短、起点即高强度、参数校验（400）、条件语法错误容错、
//       起点受阻、勾选场景不可达、纯循环通过、死局、状态上限截断、
//       截断前发现违规、确定性、HTTP API（草稿不落盘 + 已保存剧情）。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacing-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { checkPacing } = require('../src/pacing');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };
const eq = (name, actual, expected) => {
  assert.strictEqual(actual, expected, `${name}（实际 ${JSON.stringify(actual)}）`);
  passed++; console.log(`  ✓ ${name}`);
};
const throws400 = (fn, re) => {
  try { fn(); } catch (e) { return e.status === 400 && re.test(e.message); }
  return false;
};
const sceneSeq = (v) => v.path.filter((n) => n.kind === 'scene').map((n) => n.sceneId);
const edgeUids = (v) => v.path.filter((n) => n.kind === 'option').map((n) => n.optionUid);

// ---------- 基本超限：连续 3 个高强度，上限 2 => 第 3 个处违规 ----------
console.log('基本超限与最短路线');
const st1 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', text: '进入高强度', target: 'i1' }] },
    { id: 'i1', options: [{ uid: 'o2', target: 'i2' }] },
    { id: 'i2', options: [{ uid: 'o3', target: 'i3' }] },
    { id: 'i3', options: [{ uid: 'o4', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r1 = checkPacing(st1, { intenseScenes: ['i1', 'i2', 'i3'], maxConsecutive: 2 });
eq('结论为超限', r1.status, 'violation');
ok('不通过', r1.ok === false);
eq('违规发生在 i3', r1.violation.sceneId, 'i3');
eq('违规时连续计数 = 3', r1.violation.streak, 3);
eq('上限回显 = 2', r1.violation.maxConsecutive, 2);
eq('最短违规路线深度 = 3（选项步数）', r1.violation.depth, 3);
eq('违规路径场景序列 a,i1,i2,i3', sceneSeq(r1.violation).join(','), 'a,i1,i2,i3');
eq('违规路径选项 UID 为 o1,o2,o3', edgeUids(r1.violation).join(','), 'o1,o2,o3');
ok('每个场景节点带到达时完整变量状态',
  r1.violation.path.filter((n) => n.kind === 'scene').every((n) => n.state !== undefined));
ok('每个场景节点带连续计数',
  r1.violation.path.filter((n) => n.kind === 'scene').every((n) => Number.isInteger(n.streak)));
eq('沿途连续计数 0,1,2,3',
  r1.violation.path.filter((n) => n.kind === 'scene').map((n) => n.streak).join(','), '0,1,2,3');
ok('高强度节点带 intense 标记',
  r1.violation.path.filter((n) => n.kind === 'scene').every((n) => n.intense === (n.sceneId !== 'a')));
ok('每条选项边带选择后计数',
  r1.violation.path.filter((n) => n.kind === 'option').every((n) => Number.isInteger(n.streakAfter)));
ok('至少进入过高强度场景', r1.intenseReached === true && r1.intenseStates >= 3);
ok('观察到最长连续段 = 3', r1.maxStreakObserved === 3);

// ---------- 非高强度场景清零 ----------
console.log('非高强度场景即清零');
const st2 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'i1' }] },
    { id: 'i1', options: [{ uid: 'o2', target: 'c' }] },
    { id: 'c', options: [{ uid: 'o3', target: 'i2' }] },
    { id: 'i2', options: [{ uid: 'o4', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r2 = checkPacing(st2, { intenseScenes: ['i1', 'i2'], maxConsecutive: 1 });
eq('中间经过普通场景 => 通过', r2.status, 'pass');
ok('完整探索未截断', r2.truncated === false);
eq('观察到最长连续段 = 1', r2.maxStreakObserved, 1);
eq('探索 5 个具体状态', r2.counts.states, 5);
ok('违规为空', r2.violation === null);
ok('通过文案说明完整探索与最长连续段', /校验通过/.test(r2.message) && /完整探索/.test(r2.message));

// 对照：没有中间普通场景，上限 1 => i2 立即超限
const st2b = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'i1' }] },
    { id: 'i1', options: [{ uid: 'o2', target: 'i2' }] },
    { id: 'i2', options: [{ uid: 'o3', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r2b = checkPacing(st2b, { intenseScenes: ['i1', 'i2'], maxConsecutive: 1 });
eq('两个高强度直连且上限 1 => 超限', r2b.status, 'violation');
eq('违规深度 = 2、计数 = 2', r2b.violation.depth, 2);
eq('违规计数 = 2', r2b.violation.streak, 2);

// ---------- 含环：自环中的连续段必须累计 ----------
console.log('含环：自环累计');
const st3 = {
  startScene: 'i1',
  scenes: [
    { id: 'i1', options: [
      { uid: 'loop', text: '原地再战', target: 'i1' },
      { uid: 'out', text: '撤离', target: 'e' },
    ] },
    { id: 'e', options: [] },
  ],
};
const r3 = checkPacing(st3, { intenseScenes: ['i1'], maxConsecutive: 2 });
eq('自环累计到 3 => 超限', r3.status, 'violation');
eq('违规深度 = 2（起点计数 1，绕两圈后 3）', r3.violation.depth, 2);
eq('违规计数 = 3', r3.violation.streak, 3);
eq('最短路线是连走两次自环', edgeUids(r3.violation).join(','), 'loop,loop');
eq('沿途计数 1,2,3',
  r3.violation.path.filter((n) => n.kind === 'scene').map((n) => n.streak).join(','), '1,2,3');

// 含环仍终止：上限很大时自环不会无限展开（streak 并入键，违规即停）
const r3b = checkPacing(st3, { intenseScenes: ['i1'], maxConsecutive: 10 });
eq('上限 10 时绕 10 圈后超限并终止', r3b.status, 'violation');
eq('深度 = 10', r3b.violation.depth, 10);
ok('状态数有限（streak 1..11 + 结局）', r3b.counts.states <= 13);

// ---------- 往返环：高强度 <-> 普通，每次回普通都清零 => 永不超限 ----------
console.log('含环：往返环被普通场景清零');
const st4 = {
  startScene: 'i1',
  scenes: [
    { id: 'i1', options: [
      { uid: 'rest', target: 'c' },
      { uid: 'finish', target: 'e' },
    ] },
    { id: 'c', options: [{ uid: 'back', target: 'i1' }] },
    { id: 'e', options: [] },
  ],
};
const r4 = checkPacing(st4, { intenseScenes: ['i1'], maxConsecutive: 1 });
eq('往返环每次清零 => 通过', r4.status, 'pass');
eq('最长连续段仍为 1', r4.maxStreakObserved, 1);
ok('有限状态终止', Number.isInteger(r4.counts.states) && r4.counts.states > 0);

// ---------- 环上逃逸口：BFS 取选项步数最短的违规 ----------
console.log('环上逃逸口与最短路线');
const st5 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [
      { uid: 'detour', text: '先绕去普通区域', target: 'c' },
      { uid: 'direct', text: '直冲高强度', target: 'i1' },
    ] },
    { id: 'c', options: [{ uid: 'back', target: 'i1' }] },
    { id: 'i1', options: [
      { uid: 'loop', target: 'i2' },
      { uid: 'out', target: 'e' },
    ] },
    { id: 'i2', options: [{ uid: 'to1', target: 'i1' }] },
    { id: 'e', options: [] },
  ],
};
const r5 = checkPacing(st5, { intenseScenes: ['i1', 'i2'], maxConsecutive: 2 });
eq('存在超限路线', r5.status, 'violation');
eq('最短路线首步为 direct（而非绕路 detour）',
  edgeUids(r5.violation)[0], 'direct');
ok('最短路线在环上累计：i1->i2->i1 计数到 3',
  sceneSeq(r5.violation).join(',') === 'a,i1,i2,i1'
  && r5.violation.path.filter((n) => n.kind === 'scene').map((n) => n.streak).join(',') === '0,1,2,3');

// ---------- 条件 / 前置条件 / 赋值：与现有传播规则一致 ----------
console.log('选项条件、场景前置与状态赋值参与遍历');
const st6 = {
  startScene: 'a',
  variables: ['v'],
  scenes: [
    { id: 'a', options: [
      // 恒假选项（v 初始 false）：不可走，不计入路线
      { uid: 'blockedOpt', condition: 'v', target: 'i1' },
      { uid: 'setV', target: 'i1', assigns: [{ variable: 'v', value: true }] },
    ] },
    { id: 'i1', options: [{ uid: 'next', target: 'i2' }] },
    { id: 'i2', options: [{ uid: 'goGate', target: 'i3' }] },
    // i3 前置要求 v：从唯一可达路线（setV）进入时成立
    { id: 'i3', precondition: 'v', options: [{ uid: 'toEnd', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r6 = checkPacing(st6, { intenseScenes: ['i1', 'i2', 'i3'], maxConsecutive: 2 });
eq('前置成立的路线连续 3 个高强度 => 超限', r6.status, 'violation');
eq('违规场景为 i3', r6.violation.sceneId, 'i3');
ok('恒假选项不出现在违规路线中', !edgeUids(r6.violation).includes('blockedOpt'));
ok('违规终点状态 v=true', r6.violation.finalState.v === true);

// 场景前置恒不成立 => 那条边不存在，连续段被打断
const st6b = {
  startScene: 'a',
  variables: ['v'],
  scenes: [
    { id: 'a', options: [{ uid: 'go', target: 'i1' }] },
    { id: 'i1', options: [{ uid: 'next', target: 'i2' }] },
    { id: 'i2', precondition: 'v', options: [{ uid: 'x', target: 'i3' }] }, // i2 入口受阻：边不存在
    { id: 'i3', options: [{ uid: 'y', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r6b = checkPacing(st6b, { intenseScenes: ['i1', 'i2', 'i3'], maxConsecutive: 2 });
eq('i2 入口前置阻断 => i2/i3 均不可进入，最长连续仅 i1 一个 => 通过', r6b.status, 'pass');
eq('最长连续段 = 1（只进入了 i1）', r6b.maxStreakObserved, 1);

// ---------- 变量状态并入去重键：同场景不同状态分别计 streak ----------
console.log('同场景多状态分别计数');
const st7 = {
  startScene: 'a',
  variables: ['v'],
  scenes: [
    { id: 'a', options: [
      { uid: 'setV', target: 'i1', assigns: [{ variable: 'v', value: true }] },
      { uid: 'noV', target: 'i1' },
    ] },
    { id: 'i1', options: [{ uid: 'back', target: 'a' }, { uid: 'end', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r7 = checkPacing(st7, { intenseScenes: ['i1'], maxConsecutive: 5 });
// i1 每次回到 a（a 非高强度，清零），所以 streak 永远为 1；两种变量状态各自展开
eq('经过普通场景清零 => 通过', r7.status, 'pass');
ok('两种变量状态下的 i1 都被枚举（a×2 + i1×2 + e）', r7.counts.states >= 5);

// ---------- 起点即高强度 ----------
console.log('起点即高强度');
const st8 = {
  startScene: 'i1',
  scenes: [
    { id: 'i1', options: [{ uid: 'o1', target: 'i2' }] },
    { id: 'i2', options: [{ uid: 'o2', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r8 = checkPacing(st8, { intenseScenes: ['i1', 'i2'], maxConsecutive: 1 });
eq('起点计为第 1 个，i2 为第 2 个 => 超限', r8.status, 'violation');
eq('起点节点计数 = 1', r8.violation.path[0].streak, 1);
eq('深度 = 1', r8.violation.depth, 1);

// 起点即高强度且本身连续超限（上限只能 ≥1，故起点单独不超限；自环一次后超限）
const st8b = {
  startScene: 'i1',
  scenes: [{ id: 'i1', options: [{ uid: 'self', target: 'i1' }] }],
};
const r8b = checkPacing(st8b, { intenseScenes: ['i1'], maxConsecutive: 1 });
eq('纯高强度自环：第 2 次进入即超限', r8b.status, 'violation');
eq('深度 = 1、计数 = 2', r8b.violation.depth, 1);

// ---------- 勾选的高强度场景不可达 ----------
console.log('勾选场景不可达');
const st9 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'e' }] },
    { id: 'e', options: [] },
    { id: 'x', options: [] }, // 孤岛
  ],
};
const r9 = checkPacing(st9, { intenseScenes: ['x'], maxConsecutive: 2 });
eq('不可达状态', r9.status, 'intense-unreachable');
ok('不通过且无违规', r9.ok === false && r9.violation === null);
ok('提示文案指向未进入', /从未进入任何勾选的高强度场景/.test(r9.message));

// ---------- 纯循环 / 死局：完整遍历即可通过，不要求存在结局 ----------
console.log('纯循环与死局不影响通过判定');
const st10 = {
  startScene: 'i1',
  variables: ['v'],
  scenes: [
    { id: 'i1', options: [
      { uid: 'toC', target: 'c' },
      { uid: 'dead', condition: 'v', target: 'i1' }, // v 恒 false：死局选项
    ] },
    { id: 'c', options: [{ uid: 'back', target: 'i1' }] },
  ],
};
const r10 = checkPacing(st10, { intenseScenes: ['i1'], maxConsecutive: 1 });
eq('纯循环（无设计结局）但无超限 => 通过', r10.status, 'pass');
ok('设计结局数为 0 仍可判通过', r10.endingCount === 0);

// ---------- 状态上限截断 ----------
console.log('状态上限截断');
const st11 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', target: 'b' }] },
    { id: 'b', options: [{ uid: 'o2', target: 'c' }] },
    { id: 'c', options: [{ uid: 'o3', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r11 = checkPacing(st11, { intenseScenes: ['b', 'c'], maxConsecutive: 5 }, { maxStates: 2 });
eq('截断状态', r11.status, 'truncated');
ok('截断标记且不通过', r11.truncated === true && r11.ok === false);
ok('截断文案标明无法判定', /无法判定/.test(r11.message) && /不能判通过/.test(r11.message));

// 截断前已发现违规：违规确凿，仍报违规
const r11b = checkPacing(st1, { intenseScenes: ['i1', 'i2', 'i3'], maxConsecutive: 2 }, { maxStates: 4 });
eq('上限恰好容纳违规状态（第 4 个）=> 违规且未截断', r11b.status, 'violation');
ok('未截断', r11b.truncated === false);
const r11c = checkPacing(st1, { intenseScenes: ['i1', 'i2', 'i3'], maxConsecutive: 2 }, { maxStates: 3 });
eq('超限同帧发现违规 => 仍报违规', r11c.status, 'violation');
ok('超限同帧时截断标记保留', r11c.truncated === true);
const r11d = checkPacing(st1, { intenseScenes: ['i1', 'i2', 'i3'], maxConsecutive: 2 }, { maxStates: 2 });
eq('上限在到达违规状态前耗尽 => 仅判截断', r11d.status, 'truncated');

// ---------- 起点受阻 ----------
console.log('起点受阻');
const st12 = {
  startScene: 'a',
  variables: ['k'],
  scenes: [
    { id: 'a', precondition: 'k', options: [{ uid: 'o1', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r12 = checkPacing(st12, { intenseScenes: ['e'], maxConsecutive: 2 });
eq('起点受阻状态', r12.status, 'start-blocked');
ok('startBlocked 标记且不通过', r12.startBlocked === true && r12.ok === false);

// ---------- 条件语法错误容错（按恒真处理） ----------
console.log('条件语法错误容错');
const st13 = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'o1', condition: 'v &&', target: 'i1' }] },
    { id: 'i1', options: [{ uid: 'o2', target: 'i2' }] },
    { id: 'i2', options: [{ uid: 'o3', target: 'e' }] },
    { id: 'e', options: [] },
  ],
};
const r13 = checkPacing(st13, { intenseScenes: ['i1', 'i2'], maxConsecutive: 1 });
eq('语法错误按恒真：仍可走到 i2 并超限', r13.status, 'violation');
eq('记录 1 处条件语法错误', r13.conditionErrors.length, 1);

// ---------- 参数校验 ----------
console.log('参数校验');
ok('缺 query => 400', throws400(() => checkPacing(st1), /最长连续场景数/));
ok('缺连续数 => 400', throws400(() => checkPacing(st1, { intenseScenes: ['i1'] }), /最长连续场景数/));
ok('连续数为 0 => 400', throws400(() => checkPacing(st1, { intenseScenes: ['i1'], maxConsecutive: 0 }), /1～10/));
ok('连续数为 11 => 400', throws400(() => checkPacing(st1, { intenseScenes: ['i1'], maxConsecutive: 11 }), /1～10/));
ok('连续数为小数 => 400', throws400(() => checkPacing(st1, { intenseScenes: ['i1'], maxConsecutive: 1.5 }), /整数/));
ok('连续数字符串可解析',
  (() => { try { checkPacing(st2, { intenseScenes: ['i1'], maxConsecutive: '2' }); return true; } catch (e) { return false; } })());
ok('未勾选任何场景 => 400', throws400(() => checkPacing(st1, { intenseScenes: [], maxConsecutive: 2 }), /至少勾选/));
ok('勾选场景不存在 => 400', throws400(() => checkPacing(st1, { intenseScenes: ['ghost'], maxConsecutive: 2 }), /不存在/));
ok('勾选重复 => 400', throws400(() => checkPacing(st1, { intenseScenes: ['i1', 'i1'], maxConsecutive: 2 }), /重复/));
ok('勾选空行 => 400', throws400(() => checkPacing(st1, { intenseScenes: ['i1', ''], maxConsecutive: 2 }), /空行/));
ok('缺起点 => 400',
  throws400(() => checkPacing({ scenes: [{ id: 'a' }] }, { intenseScenes: ['a'], maxConsecutive: 2 }), /起点/));
ok('起点不存在 => 400',
  throws400(() => checkPacing({ startScene: 'ghost', scenes: [{ id: 'a' }] }, { intenseScenes: ['a'], maxConsecutive: 2 }), /起点/));

// ---------- 上限边界 1 与 10 ----------
console.log('上限边界');
const chain = (n) => ({
  startScene: 's0',
  scenes: Array.from({ length: n + 1 }, (_, i) => ({
    id: `s${i}`,
    options: i === n ? [] : [{ uid: `e${i}`, target: `s${i + 1}` }],
  })),
});
const all = (n) => Array.from({ length: n + 1 }, (_, i) => `s${i}`);
eq('全高强度 11 连、上限 10 => 第 11 个处超限',
  checkPacing(chain(10), { intenseScenes: all(10), maxConsecutive: 10 }).status, 'violation');
eq('全高强度 10 连、上限 10 => 通过',
  checkPacing(chain(9), { intenseScenes: all(9), maxConsecutive: 10 }).status, 'pass');
eq('全高强度 1 连、上限 1 => 通过',
  checkPacing(chain(0), { intenseScenes: ['s0'], maxConsecutive: 1 }).status, 'pass');

// ---------- 确定性 ----------
console.log('确定性');
eq('同一剧情两次校验结果一致',
  JSON.stringify(checkPacing(st5, { intenseScenes: ['i1', 'i2'], maxConsecutive: 2 })),
  JSON.stringify(checkPacing(st5, { intenseScenes: ['i1', 'i2'], maxConsecutive: 2 })));

// ---------- 示例剧情可正常运行 ----------
console.log('示例剧情');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const rDemo = checkPacing(demo, { intenseScenes: ['forest', 'castle', 'dungeon'], maxConsecutive: 2 });
ok('示例剧情校验正常返回', typeof rDemo.status === 'string' && rDemo.counts.states > 0);

// ---------- HTTP API ----------
(async () => {
  console.log('HTTP API：');
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const req = (method, url, body) => new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: url, method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    }, (res) => {
      let data = '';
      res.on('data', (x) => { data += x; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });

  try {
    // 草稿校验（不落盘）
    const q1 = await req('POST', '/api/pacing', {
      story: st1, query: { intenseScenes: ['i1', 'i2', 'i3'], maxConsecutive: 2 },
    });
    ok('POST /api/pacing 返回 200 且报超限',
      q1.status === 200 && q1.body.status === 'violation' && q1.body.violation.depth === 3);

    const q1b = await req('POST', '/api/pacing', {
      story: st2, query: { intenseScenes: ['i1', 'i2'], maxConsecutive: 1 },
    });
    ok('通过剧情返回 pass', q1b.status === 200 && q1b.body.status === 'pass' && q1b.body.ok === true);

    const q1c = await req('POST', '/api/pacing', { story: st1, query: { intenseScenes: ['i1'], maxConsecutive: 0 } });
    ok('连续数越界返回 400', q1c.status === 400 && /1～10/.test(q1c.body.error || ''));

    const q1d = await req('POST', '/api/pacing', { story: st1, query: { intenseScenes: [], maxConsecutive: 2 } });
    ok('未勾选场景返回 400', q1d.status === 400);

    const q1e = await req('POST', '/api/pacing', { story: st1 });
    ok('缺查询条件返回 400', q1e.status === 400);

    const q1f = await req('POST', '/api/pacing', {
      story: st1, query: { intenseScenes: ['i1', 'i2', 'i3'], maxConsecutive: 2 }, maxStates: 3,
    });
    ok('maxStates 注入生效：截断同帧仍报违规并带截断标记',
      q1f.status === 200 && q1f.body.status === 'violation' && q1f.body.truncated === true);

    // 已保存剧情接口
    const created = await req('POST', '/api/stories', st1);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;
    const q2 = await req('POST', `/api/stories/${sid}/pacing`, { intenseScenes: ['i1', 'i2', 'i3'], maxConsecutive: 2 });
    ok('POST /api/stories/:id/pacing（query 直接作请求体）报超限',
      q2.status === 200 && q2.body.status === 'violation');
    const q2b = await req('POST', `/api/stories/${sid}/pacing`, { query: { intenseScenes: ['i1', 'i2', 'i3'], maxConsecutive: 2 } });
    ok('POST /api/stories/:id/pacing 接受 { query } 包装',
      q2b.status === 200 && q2b.body.status === 'violation');
    const q3 = await req('POST', '/api/stories/no-such-id/pacing', { intenseScenes: ['i1'], maxConsecutive: 2 });
    ok('剧情不存在返回 404', q3.status === 404);

    // 草稿校验不落盘
    const after = await req('GET', `/api/stories/${sid}`);
    ok('校验后剧情内容未被修改',
      JSON.stringify(after.body.scenes) === JSON.stringify(created.body.scenes));
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项节奏校验断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
