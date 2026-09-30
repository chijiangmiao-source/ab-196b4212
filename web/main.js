// 审计页面前端逻辑（原生 ESM，无框架依赖）。

const MAX_COMPONENTS = 16;
const MAX_VERSIONS = 6;

const $ = (id) => document.getElementById(id);

const state = {
  components: [], // {id, versionsText, deps:[{target, range}]}
};

// ---------- 工具 ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildModelFromForm() {
  const roots = $('rootsInput').value.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    roots,
    components: state.components.map((c) => ({
      id: c.id.trim(),
      versions: c.versionsText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
      dependencies: Object.fromEntries(
        c.deps
          .map((d) => [d.target.trim(), d.range.trim()])
          .filter(([t, r]) => t !== '' && r !== ''),
      ),
    })),
  };
}

function loadModelIntoForm(model) {
  $('rootsInput').value = (model.roots || []).join(', ');
  state.components = (model.components || []).map((c) => ({
    id: c.id || '',
    versionsText: (c.versions || []).join(', '),
    deps: Object.entries(c.dependencies || {}).map(([target, range]) => ({ target, range })),
  }));
  renderComponents();
}

// ---------- 表单渲染 ----------
function renderComponents() {
  const list = $('componentList');
  $('compCount').textContent = String(state.components.length);
  list.innerHTML = '';

  state.components.forEach((comp, ci) => {
    const card = document.createElement('div');
    card.className = 'comp-card';

    const head = document.createElement('div');
    head.className = 'comp-row';
    head.innerHTML = `
      <input class="grow comp-title" placeholder="组件标识，如 CAM" value="${esc(comp.id)}" data-k="id" />
      <button class="btn small danger" type="button" data-act="del">删除</button>`;
    head.querySelector('input').addEventListener('input', (e) => { comp.id = e.target.value; });
    head.querySelector('[data-act=del]').addEventListener('click', () => {
      state.components.splice(ci, 1);
      renderComponents();
    });
    card.append(head);

    const versions = document.createElement('label');
    versions.className = 'comp-meta';
    versions.textContent = `候选版本（逗号或空格分隔，至多 ${MAX_VERSIONS} 个）`;
    card.append(versions);

    const vInput = document.createElement('input');
    vInput.type = 'text';
    vInput.value = comp.versionsText;
    vInput.placeholder = '1.0.0, 2.0.0';
    vInput.addEventListener('input', (e) => { comp.versionsText = e.target.value; });
    card.append(vInput);

    const depHead = document.createElement('div');
    depHead.className = 'comp-meta';
    depHead.textContent = '依赖范围（仅 = 、>= 、< 的合取）';
    card.append(depHead);

    comp.deps.forEach((dep, di) => {
      const row = document.createElement('div');
      row.className = 'dep-row';
      row.innerHTML = `
        <input class="t" placeholder="目标组件" value="${esc(dep.target)}" />
        <input class="grow" placeholder=">=2.0.0 <3.0.0" value="${esc(dep.range)}" />
        <button class="btn small danger" type="button">×</button>`;
      const [tIn, rIn] = row.querySelectorAll('input');
      tIn.addEventListener('input', (e) => { dep.target = e.target.value; });
      rIn.addEventListener('input', (e) => { dep.range = e.target.value; });
      row.querySelector('button').addEventListener('click', () => {
        comp.deps.splice(di, 1);
        renderComponents();
      });
      card.append(row);
    });

    const addDep = document.createElement('button');
    addDep.className = 'btn small secondary';
    addDep.type = 'button';
    addDep.textContent = '＋ 添加依赖';
    addDep.style.marginTop = '6px';
    addDep.addEventListener('click', () => {
      comp.deps.push({ target: '', range: '' });
      renderComponents();
    });
    card.append(addDep);

    list.append(card);
  });

  $('addComponent').disabled = state.components.length >= MAX_COMPONENTS;
}

// ---------- 结论渲染 ----------
function setBadge(kind, text) {
  const b = $('statusBadge');
  b.className = `badge ${kind}`;
  b.textContent = text;
}

/** 任何新提交/错误都必须先立即清除旧结论。 */
function clearResult(badgeKind = 'idle', badgeText = '尚未审计') {
  setBadge(badgeKind, badgeText);
  $('result').innerHTML = '<p class="placeholder">录入后点击“运行审计”，此处展示选定版本与满足依据，或稳定的冲突树。</p>';
}

function renderErrors(errors) {
  setBadge('invalid', `输入无效（${errors.length} 处）`);
  const ul = document.createElement('ul');
  ul.className = 'error-list';
  for (const e of errors) {
    const li = document.createElement('li');
    li.innerHTML = `${esc(e.message)}<span class="error-code">${esc(e.code)}</span>` +
      (e.path ? `<span class="path">定位：${esc(e.path)}</span>` : '');
    ul.append(li);
  }
  $('result').replaceChildren(ul);
}

function renderSatisfiable(result) {
  setBadge('ok', `可共同装载 · 选定 ${result.assignment.length} 个组件`);
  const box = document.createElement('div');

  for (const w of result.warnings || []) {
    const warn = document.createElement('div');
    warn.className = 'warn-box';
    warn.textContent = `⚠ ${w.message}：${(w.components || []).join(', ')}`;
    box.append(warn);
  }

  const table = document.createElement('table');
  table.className = 'solve-table';
  table.innerHTML = `<thead><tr><th>组件（ASCII 顺序）</th><th>选定版本</th><th>满足范围的候选</th><th>满足依据</th></tr></thead>`;
  const tbody = document.createElement('tbody');

  for (const row of result.assignment) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.innerHTML = `<span class="comp-name">${esc(row.component)}</span>${row.isRoot ? '<span class="tag-root">ROOT</span>' : ''}`;
    tr.append(tdName);

    const tdPick = document.createElement('td');
    tdPick.innerHTML = `<span class="ver-pick">${esc(row.selectedVersion)}</span>`;
    tr.append(tdPick);

    const tdAccept = document.createElement('td');
    tdAccept.innerHTML = row.acceptableVersions
      .map((v) => `<span class="chip ${v === row.selectedVersion ? 'sel' : ''}">${esc(v)}</span>`)
      .join('');
    tr.append(tdAccept);

    const tdEv = document.createElement('td');
    if (row.evidence.length === 0) {
      tdEv.innerHTML = '<span class="placeholder">根组件无上游约束，候选中取最高版本</span>';
    } else {
      const det = document.createElement('details');
      det.className = 'evidence';
      det.innerHTML = `<summary>展开 ${row.evidence.length} 条入边范围的逐条核验</summary>`;
      const body = document.createElement('div');
      body.className = 'ev-body';
      for (const ev of row.evidence) {
        const r = document.createElement('div');
        r.className = 'ev-req';
        r.innerHTML = `来自 <code>${esc(ev.from)}</code> 的要求 <code>${esc(ev.range)}</code>：`;
        body.append(r);
        for (const c of ev.checks) {
          const line = document.createElement('span');
          line.className = 'check';
          line.innerHTML = `${c.holds ? '<span class="pass">✔</span>' : '<span class="fail">✗</span>'} ${esc(c.comparison)}，要求 ${esc(c.clause)} → ${c.holds ? '成立' : '不成立'}`;
          body.append(line);
        }
      }
      det.append(body);
      tdEv.append(det);
    }
    tr.append(tdEv);
    tbody.append(tr);
  }
  table.append(tbody);
  box.append(table);
  $('result').replaceChildren(box);
}

function renderConflict(result) {
  setBadge('conflict', `互斥冲突 · ${result.tree.conflicts.length} 个组件无法选版`);
  const box = document.createElement('div');
  const intro = document.createElement('p');
  intro.className = 'placeholder';
  intro.textContent = result.tree.summary + '；展开冲突树可查看每个候选版本被哪条上游要求否决。';
  box.append(intro);

  result.tree.conflicts.forEach((node, i) => {
    const det = document.createElement('details');
    det.className = 'conflict-node';
    if (i === 0) det.open = true;
    det.innerHTML = `<summary><span class="comp-name">${esc(node.component)}</span>
      <span class="placeholder">${node.candidates.length} 个候选版本全部被排除</span></summary>`;

    const body = document.createElement('div');
    body.className = 'conflict-body';
    for (const req of node.requirements) {
      const line = document.createElement('div');
      line.className = 'req-line';
      line.innerHTML = `上游 <code>${esc(req.from)}</code> 要求：<code>${esc(req.range)}</code>`;
      body.append(line);
    }

    const t = document.createElement('table');
    t.className = 'cand-table';
    t.innerHTML = '<thead><tr><th>候选版本</th><th>判定</th><th>否决依据</th></tr></thead>';
    const tb = document.createElement('tbody');
    for (const cand of node.candidates) {
      const tr = document.createElement('tr');
      const tdV = document.createElement('td');
      tdV.innerHTML = `<span class="ver-rejected">${esc(cand.version)}</span>`;
      tr.append(tdV);
      const tdR = document.createElement('td');
      tdR.textContent = cand.rejectedBy.length ? '排除' : '—';
      tdR.style.color = cand.rejectedBy.length ? 'var(--err)' : 'var(--muted)';
      tr.append(tdR);
      const tdWhy = document.createElement('td');
      tdWhy.innerHTML = cand.rejectedBy.length
        ? cand.rejectedBy.map((rb) => {
            const clauses = rb.failedClauses
              .map((fc) => `<span class="reason"><b>✗ ${esc(fc.comparison)}</b>，不满足 ${esc(fc.expected)}（来自 ${esc(rb.from)}）</span>`)
              .join('<br>');
            return clauses;
          }).join('<br>')
        : '<span class="reason">无上游要求直接否决（因其他组件冲突而整体无解时仍列于此）</span>';
      tr.append(tdWhy);
      tb.append(tr);
    }
    t.append(tb);
    body.append(t);
    det.append(body);
    box.append(det);
  });
  $('result').replaceChildren(box);
}

// ---------- 提交 ----------
async function submitModel(model) {
  // 立即清除旧结论，避免装载后才暴露互斥要求时仍残留上一次结果。
  clearResult('idle', '审计中…');
  let res;
  try {
    res = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(model),
    });
  } catch {
    setBadge('invalid', '网络错误');
    $('result').innerHTML = '<p class="placeholder">无法连接审计服务，请稍后重试。</p>';
    return;
  }
  let payload;
  try { payload = await res.json(); } catch { payload = { ok: false, errors: [{ code: 'BAD_RESPONSE', message: '服务返回了无法解析的响应' }] }; }

  if (!payload.ok) {
    renderErrors(payload.errors || []);
    return;
  }
  if (payload.result.status === 'satisfiable') renderSatisfiable(payload.result);
  else renderConflict(payload.result);
}

// ---------- 示例 ----------
async function loadSample(name) {
  const res = await fetch('/api/sample');
  const data = await res.json();
  const model = data.samples[name];
  loadModelIntoForm(model);
  $('jsonInput').value = JSON.stringify(model, null, 2);
  await submitModel(model);
}

// ---------- 装配 ----------
$('addComponent').addEventListener('click', () => {
  if (state.components.length >= MAX_COMPONENTS) return;
  state.components.push({ id: '', versionsText: '', deps: [] });
  renderComponents();
});

$('submitBtn').addEventListener('click', () => submitModel(buildModelFromForm()));
$('clearBtn').addEventListener('click', () => {
  state.components = [];
  $('rootsInput').value = '';
  $('jsonInput').value = '';
  renderComponents();
  clearResult();
});
$('loadCam').addEventListener('click', () => loadSample('camNav'));
$('loadBus').addEventListener('click', () => loadSample('busConflict'));

$('tabForm').addEventListener('click', () => {
  $('tabForm').classList.add('active'); $('tabJson').classList.remove('active');
  $('formView').hidden = false; $('jsonView').hidden = true;
});
$('tabJson').addEventListener('click', () => {
  $('tabJson').classList.add('active'); $('tabForm').classList.remove('active');
  $('formView').hidden = true; $('jsonView').hidden = false;
  $('jsonInput').value = JSON.stringify(buildModelFromForm(), null, 2);
});
$('submitJsonBtn').addEventListener('click', () => {
  let model;
  try { model = JSON.parse($('jsonInput').value); }
  catch { clearResult('invalid', 'JSON 解析失败'); renderErrors([{ code: 'MALFORMED_JSON', message: 'JSON 文本无法解析，请检查语法', path: 'jsonInput' }]); return; }
  submitModel(model);
});
$('jsonToFormBtn').addEventListener('click', () => {
  try {
    const model = JSON.parse($('jsonInput').value);
    loadModelIntoForm(model);
    $('tabForm').click();
  } catch { renderErrors([{ code: 'MALFORMED_JSON', message: 'JSON 文本无法解析，请检查语法', path: 'jsonInput' }]); }
});

// 初始页面：载入 CAM 示例表单但不自动审计（结论区保持空）。
state.components.push({ id: 'CAM', versionsText: '1.0.0', deps: [{ target: 'NAV', range: '>=2.0.0 <3.0.0' }] });
state.components.push({ id: 'NAV', versionsText: '1.0.0, 2.0.0', deps: [] });
$('rootsInput').value = 'CAM';
renderComponents();
