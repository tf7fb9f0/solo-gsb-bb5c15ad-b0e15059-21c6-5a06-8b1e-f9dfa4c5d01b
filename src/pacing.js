'use strict';

/**
 * 节奏校验（Pacing Check：高强度场景连续段校验）
 *
 * 作者在编辑页勾选一组**高强度场景**，并设置允许的**最长连续场景数**
 * maxConsecutive（1～10），对编辑中的未保存草稿（不落盘）校验：
 * “沿任意一条实际可走的路线，会不会连续经过超过 maxConsecutive 个高强度场景？”
 *
 * 沿现有「场景 + 完整变量状态」具体状态图（与 analyzer / foreshadow 相同的
 * 选项条件、选项赋值、目标场景进入赋值与场景前置条件传播规则），把
 * **当前连续高强度计数 streak** 并入遍历去重键：
 *     状态键 = (场景 ID, 全部布尔变量取值位图, streak)
 *   - 每次**进入高强度场景**：streak += 1（起点即高强度也算进入）；
 *   - 每次**进入非高强度场景**：streak 清零为 0；
 *   - streak 取值范围为 0..maxConsecutive（一旦达到 maxConsecutive+1 即违规并
 *     停止扩展），所以状态总数至多 场景数 × 2^n × (maxConsecutive+1)，含任意
 *     环路都必然终止（约 100 万状态安全上限，超限截断并明确提示）。
 *
 * 把 streak 并入去重键是正确性的关键：
 *   - “在高强度环路里多绕一圈”会让 streak 变大，与绕圈前的状态区分开，
 *     因此**环路中的连续段也会累计**，不会被去重错误抹平；
 *   - 进入非高强度场景后同一 (场景, 变量状态) 的 streak=0 状态与任何绕路
 *     残留计数的状态分开，清零语义精确。
 *
 * 违规判定：某具体状态 streak === maxConsecutive+1（连续第 maxConsecutive+1
 * 个高强度场景）即超限。BFS 按选项步数逐层展开，首个被发现的违规状态即
 * **按选项步数最短的违规路线**，发现即停（违规路线真实可走，结论确凿，无需
 * 完整探索），沿途每个场景节点带到达时的完整变量状态与当时的连续计数。
 *
 * 通过判定（全部满足才判 pass，缺一即单独提示）：
 *   1. 完整探索（未因状态上限截断）；
 *   2. 至少勾选一个高强度场景，且遍历中至少进入过一次（否则节奏限制无的放矢）；
 *   3. 没有任何 streak > maxConsecutive 的状态。
 * 纯循环、死局等结构不影响节奏判定：只要完整遍历且无超限即通过。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');

const MIN_LIMIT = 1;
const MAX_LIMIT = 10;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** 校验查询条件：高强度场景非空、不重复、必须存在；最长连续数为 1～10 的整数 */
function normalizeQuery(queryInput, sceneMap) {
  const q = queryInput || {};

  let limit = q.maxConsecutive;
  if (typeof limit === 'string' && limit.trim() !== '') {
    limit = Number(limit.trim());
  }
  if (!Number.isInteger(limit)) {
    throw badRequest(`请填写允许的最长连续场景数：${MIN_LIMIT}～${MAX_LIMIT} 的整数`);
  }
  if (limit < MIN_LIMIT || limit > MAX_LIMIT) {
    throw badRequest(`允许的最长连续场景数必须在 ${MIN_LIMIT}～${MAX_LIMIT} 之间（当前为 ${limit}）`);
  }

  const raw = q.intenseScenes;
  if (!Array.isArray(raw) || !raw.length) {
    throw badRequest('请至少勾选一个高强度场景');
  }
  const intenseScenes = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item == null ? '' : item).trim();
    if (!id) throw badRequest('高强度场景中存在未选择的空行');
    if (seen.has(id)) throw badRequest(`高强度场景重复："${id}"`);
    seen.add(id);
    if (!sceneMap.has(id)) throw badRequest(`高强度场景 "${id}" 不存在`);
    intenseScenes.push(id);
  }
  return { intenseScenes, maxConsecutive: limit };
}

/**
 * 对剧情（草稿或已保存）运行节奏校验。
 *
 * @param storyInput 剧情对象
 * @param queryInput { intenseScenes: [场景ID...], maxConsecutive: 1..10 }
 * @param opts       { maxStates } 测试可注入更小的状态上限
 */
function checkPacing(storyInput, queryInput, opts = {}) {
  const story = storyInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }
  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法校验节奏');
  }
  const { intenseScenes, maxConsecutive } = normalizeQuery(queryInput, sceneMap);
  const intenseSet = new Set(intenseScenes);

  // 编译条件；语法错误按恒真处理（与其余模块一致），记录到 conditionErrors
  const conditionErrors = [];
  const safeCompile = (raw, where) => {
    try {
      return compile(raw);
    } catch (e) {
      conditionErrors.push({ where, message: e.message });
      return null;
    }
  };
  const sceneCond = new Map();
  const sceneAssigns = new Map();
  const optionCompiled = new Map(); // `${sceneId}#${idx}` -> { cond, assigns }
  for (const scene of sceneMap.values()) {
    sceneCond.set(scene.id, safeCompile(scene.precondition, `场景 "${scene.id}" 的前置条件`));
    sceneAssigns.set(scene.id, (scene.assigns || []).filter((a) => a && a.variable));
    (scene.options || []).forEach((opt, idx) => {
      optionCompiled.set(`${scene.id}#${idx}`, {
        cond: safeCompile(opt && opt.condition, `场景 "${scene.id}" 选项 ${idx + 1} 的条件`),
        assigns: ((opt && opt.assigns) || []).filter((a) => a && a.variable),
      });
    });
  }

  const knownVars = collectStateVars({ ...story, scenes });

  // ---- BFS：状态键 = 场景 ID \x00 变量位图 \x00 streak ----
  const visited = new Set();
  const parent = new Map(); // key -> { parentKey, depth, edge, sceneId, code, streak }
  const queue = [];
  let truncated = false;
  let statesExplored = 0;
  let transitionCount = 0;
  let intenseReached = false;   // 是否进入过任一高强度场景
  let intenseStates = 0;        // 高强度具体状态数（含违规状态）
  let maxStreakObserved = 0;    // 已探索范围内观察到的最大连续计数
  const endingStatesByScene = new Map(); // 设计结局 sceneId -> 终止具体状态数
  let violationKey = null;

  const SEP = '\x01'; // 不会出现在场景 ID（字母数字_-）或变量位图中
  const keyOf = (sceneId, code, streak) => `${sceneId}${SEP}${code}${SEP}${streak}`;

  // 返回 true 表示新状态入队；'violation' 表示发现最短违规（不再入队，探索停止）
  const offer = (sceneId, code, streak, depth, predKey, edge) => {
    const key = keyOf(sceneId, code, streak);
    if (visited.has(key)) return false;
    visited.add(key);
    parent.set(key, { parentKey: predKey, depth, edge, sceneId, code, streak });
    statesExplored++;
    const isIntense = intenseSet.has(sceneId);
    if (isIntense) {
      intenseReached = true;
      intenseStates++;
      if (streak > maxStreakObserved) maxStreakObserved = streak;
    }
    const scene = sceneMap.get(sceneId);
    if ((scene.options || []).length === 0) {
      // 设计结局终止状态（场景无选项 => 必然没有任何出边）
      endingStatesByScene.set(sceneId, (endingStatesByScene.get(sceneId) || 0) + 1);
    }
    if (streak > maxConsecutive) {
      // 连续第 maxConsecutive+1 个高强度场景：超限违规（违规状态仍计入统计）
      if (!violationKey) violationKey = key;
      if (statesExplored > maxStates) truncated = true; // 超限与截断同帧：两者都如实标记
      return 'violation';
    }
    if (statesExplored > maxStates) { truncated = true; return false; }
    queue.push(key);
    return true;
  };

  // 起点：初始状态 = 起点场景的进入赋值；起点即高强度 => 初始连续计数为 1
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));
  const base = {
    query: {
      maxConsecutive,
      intenseScenes: intenseScenes.map((id) => ({ sceneId: id, title: (sceneMap.get(id) || {}).title || '' })),
    },
    startScene: story.startScene,
    knownVars,
    conditionErrors,
    maxStates,
  };
  if (startBlocked) {
    return {
      ...base,
      ok: false,
      status: 'start-blocked',
      startBlocked: true,
      truncated: false,
      intenseReached: false,
      intenseStates: 0,
      maxStreakObserved: 0,
      endingCount: 0,
      endingStates: 0,
      endings: [],
      violation: null,
      counts: { states: 0, transitions: 0, variables: knownVars.length },
      statesExplored: 0,
      message: '起点场景的前置条件在初始状态下不成立，剧情无法开始，无法校验节奏。',
    };
  }
  offer(story.startScene, encodeState(startState, knownVars),
    intenseSet.has(story.startScene) ? 1 : 0, 0, null, null);

  let head = 0;
  while (head < queue.length && !truncated && !violationKey) {
    const curKey = queue[head++];
    const cur = parent.get(curKey);
    const { sceneId, code, streak } = cur;
    const scene = sceneMap.get(sceneId);
    const state = decodeState(code, knownVars);

    (scene.options || []).forEach((option, idx) => {
      if (truncated || violationKey) return;
      const oc = optionCompiled.get(`${sceneId}#${idx}`);
      if (oc && oc.cond && !oc.cond.evaluate(state)) return; // 条件不成立：此状态下不可走
      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return;      // 悬空跳转：不构成边
      let nextState = state;
      if (oc && oc.assigns.length) nextState = applyAssigns(nextState, oc.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const tc = sceneCond.get(targetId);
      if (tc && !tc.evaluate(nextState)) return;            // 入口前置不成立：不构成边

      // 连续计数传递：进入高强度场景累加（环路中的连续段也照常累计），
      // 进入非高强度场景即清零
      const nextStreak = intenseSet.has(targetId) ? streak + 1 : 0;

      const offered = offer(targetId, encodeState(nextState, knownVars), nextStreak,
        cur.depth + 1, curKey, {
          optionIndex: idx,
          optionUid: (option && option.uid) || null,
          optionText: (option && option.text) || '',
          fromSceneId: sceneId,
          target: targetId,
          targetTitle: (sceneMap.get(targetId) || {}).title || '',
        });
      if (offered === true) transitionCount++;
    });
  }

  const endingCount = endingStatesByScene.size;
  const endingStates = [...endingStatesByScene.values()].reduce((a, b) => a + b, 0);
  const endings = [...endingStatesByScene.keys()].sort().map((id) => ({
    sceneId: id,
    title: (sceneMap.get(id) || {}).title || '',
    states: endingStatesByScene.get(id),
  }));

  // ---- 违规路径重建（BFS 父指针；首个违规即选项步数最短） ----
  let violation = null;
  if (violationKey) {
    const trail = [];
    let k = violationKey;
    while (k) {
      const p = parent.get(k);
      const sc = sceneMap.get(p.sceneId);
      trail.push({
        kind: 'scene',
        sceneId: p.sceneId,
        title: sc ? (sc.title || '') : '',
        state: decodeState(p.code, knownVars),
        streak: p.streak,
        intense: intenseSet.has(p.sceneId),
      });
      if (p.edge) {
        trail.push({
          kind: 'option',
          ...p.edge,
          stateAfter: decodeState(p.code, knownVars),
          streakAfter: p.streak,
          intenseAfter: intenseSet.has(p.sceneId),
        });
      }
      k = p.parentKey;
    }
    trail.reverse();
    const end = parent.get(violationKey);
    violation = {
      sceneId: end.sceneId,
      title: (sceneMap.get(end.sceneId) || {}).title || '',
      streak: end.streak,
      maxConsecutive,
      depth: end.depth,
      path: trail,
      finalState: decodeState(end.code, knownVars),
    };
  }

  // ---- 结论：违规 > 截断 > 高强度场景不可达 > 通过 ----
  let status;
  if (violation) status = 'violation';
  else if (truncated) status = 'truncated';
  else if (!intenseReached) status = 'intense-unreachable';
  else status = 'pass';

  const counts = { states: statesExplored, transitions: transitionCount, variables: knownVars.length };
  let message;
  if (status === 'pass') {
    message = `校验通过：已完整探索 ${statesExplored} 个具体状态，全部可走路线上高强度场景`
      + `连续段均不超过 ${maxConsecutive} 个（观察到的最长连续段为 ${maxStreakObserved} 个）。`;
  } else if (status === 'violation') {
    message = `节奏超限：存在路线连续经过 ${violation.streak} 个高强度场景，超过允许的最长连续数 `
      + `${maxConsecutive}。以下按选项步数展示最短违规路线（${violation.depth} 步）与沿途变量状态、`
      + '连续计数（探索在发现违规后停止）。';
  } else if (status === 'truncated') {
    message = `无法判定：具体状态数量超过安全上限（${maxStates}），探索被截断。`
      + `已探索范围内未发现连续超过 ${maxConsecutive} 个高强度场景的路线，但未探索区域可能存在，`
      + '不能判通过；请减少变量数量后重试。';
  } else {
    message = `无法判定：已完整探索 ${statesExplored} 个具体状态，但从未进入任何勾选的高强度场景`
      + '——节奏限制无的放矢。请检查勾选是否正确，或通往这些场景的选项链。';
  }

  return {
    ...base,
    ok: status === 'pass',
    status,
    startBlocked: false,
    truncated,
    intenseReached,
    intenseStates,
    maxStreakObserved,
    endingCount,
    endingStates,
    endings,
    violation,
    counts,
    statesExplored,
    message,
  };
}

module.exports = { checkPacing };
