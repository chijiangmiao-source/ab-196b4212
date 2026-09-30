// 审计页面前端：结构化表单 / JSON 双模式录入，结论、满足依据与可展开冲突树渲染。
const MAX_COMPONENTS = 16;
const MAX_VERSIONS = 6;

const state = {
  components: [
    { id: 'CAM', versions: [{ version: '1.0.0', deps: [{ id: 'NAV', range: '>=2.0.0 <3.0.0' }] }] },
    { id: 'NAV', versions: [{ version: '1.0.0', deps: [] }, { version: '2.0.0', deps: [] }] },
  ],
  roots: [{ id: 'CAM', deps: [] }],
};

const $ = (sel) => document.querySelector(sel);
const componentList = $('#componentList');
const rootList = $('#rootList');
const resultBox = $('#result');

// ---------------------------------------------------------------- 录入表单

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function textInput(cls, value, onInput, placeholder = '') {
  return el('input', {
    type: 'text',
    class: cls,
    value,
    placeholder,
    oninput: (e) => onInput(e.target.value),
  });
}

function depRows(owner, list, targetOptions) {
  const wrap = el('div');
  list.forEach((dep, di) => {
    const sel = el(
      'select',
      { class: 'target', onchange: (e) => (dep.id = e.target.value) },
      el('option', { value: '' }, '(依赖组件)'),
      targetOptions.map((id) => el('option', { value: id, selected: id === dep.id || null }, id)),
    );
    const row = el(
      'div',
      { class: 'dep-row' },
      el('span', { class: 'small', text: '依赖' }),
      sel,
      textInput('range', dep.range, (v) => (dep.range = v), '如 >=2.0.0 <3.0.0'),
      el('button', {
        type: 'button',
        class: 'btn danger',
        text: '×',
        onclick: () => {
          list.splice(di, 1);
          renderAll();
        },
      }),
    );
    wrap.appendChild(row);
  });
  wrap.appendChild(
    el(
      'button',
      {
        type: 'button',
        class: 'btn',
        text: '+ 依赖范围',
        onclick: () => {
          list.push({ id: targetOptions[0] ?? '', range: '' });
          renderAll();
        },
      },
    ),
  );
  return wrap;
}

function renderComponents() {
  componentList.innerHTML = '';
  state.components.forEach((comp, ci) => {
    const card = el('div', { class: 'comp-card' });
    card.appendChild(
      el(
        'div',
        { class: 'comp-head' },
        el('strong', { text: '组件标识' }),
        textInput('id', comp.id, (v) => (comp.id = v), '如 CAM'),
        el(
          'button',
          {
            type: 'button',
            class: 'btn danger',
            text: '删除组件',
            onclick: () => {
              const removed = state.components.splice(ci, 1)[0].id;
              state.roots = state.roots.filter((r) => r.id !== removed);
              renderAll();
            },
          },
        ),
      ),
    );

    comp.versions.forEach((ver, vi) => {
      const others = state.components.map((c) => c.id).filter((id) => id && id !== comp.id);
      const block = el('div', { class: 'version-block' });
      block.appendChild(
        el(
          'div',
          { class: 'row' },
          el('span', { class: 'small', text: '版本' }),
          textInput('ver', ver.version, (v) => (ver.version = v), 'X.Y.Z'),
          el('button', {
            type: 'button',
            class: 'btn danger',
            text: '×',
            onclick: () => {
              comp.versions.splice(vi, 1);
              renderAll();
            },
          }),
        ),
      );
      block.appendChild(depRows(comp, ver.deps, others));
      card.appendChild(block);
    });

    if (comp.versions.length < MAX_VERSIONS) {
      card.appendChild(
        el('button', {
          type: 'button',
          class: 'btn',
          text: '+ 版本',
          onclick: () => {
            comp.versions.push({ version: '', deps: [] });
            renderAll();
          },
        }),
      );
    }
    componentList.appendChild(card);
  });

  $('#addComponent').disabled = state.components.length >= MAX_COMPONENTS;
}

function renderRoots() {
  rootList.innerHTML = '';
  const ids = state.components.map((c) => c.id).filter(Boolean);
  state.roots.forEach((root, ri) => {
    const sel = el(
      'select',
      { onchange: (e) => (root.id = e.target.value) },
      el('option', { value: '' }, '(选择根组件)'),
      ids.map((id) => el('option', { value: id, selected: id === root.id || null }, id)),
    );
    const card = el('div', { class: 'root-card' });
    card.appendChild(
      el(
        'div',
        { class: 'row' },
        el('strong', { text: '根组件' }),
        sel,
        el('button', {
          type: 'button',
          class: 'btn danger',
          text: '移除',
          onclick: () => {
            state.roots.splice(ri, 1);
            renderAll();
          },
        }),
      ),
    );
    card.appendChild(el('div', { class: 'small', text: '根级附加依赖范围（可选，对任意根版本持续生效）：' }));
    card.appendChild(depRows(root, root.deps, ids.filter((id) => id !== root.id)));
    rootList.appendChild(card);
  });
  $('#addRoot').disabled = state.roots.length >= MAX_COMPONENTS;
}

function renderAll() {
  renderComponents();
  renderRoots();
}

$('#addComponent').addEventListener('click', () => {
  if (state.components.length < MAX_COMPONENTS) {
    state.components.push({ id: '', versions: [{ version: '', deps: [] }] });
    renderAll();
  }
});
$('#addRoot').addEventListener('click', () => {
  state.roots.push({ id: '', deps: [] });
  renderAll();
});

// ---------------------------------------------------------------- 模式切换

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const jsonMode = $('input[name="mode"]:checked').value === 'json';
    $('#formMode').hidden = jsonMode;
    $('#jsonMode').hidden = !jsonMode;
    if (jsonMode) $('#jsonInput').value = JSON.stringify(buildPayload(), null, 2);
  });
});

function buildPayload() {
  const components = state.components.map((c) => ({
    id: c.id.trim(),
    versions: c.versions.map((v) => {
      const deps = {};
      for (const d of v.deps) {
        const id = (d.id ?? '').trim();
        if (id) deps[id] = d.range;
      }
      return { version: v.version.trim(), dependencies: deps };
    }),
  }));
  const roots = state.roots.map((r) => {
    const deps = {};
    for (const d of r.deps) {
      const id = (d.id ?? '').trim();
      if (id) deps[id] = d.range;
    }
    return { id: r.id.trim(), dependencies: deps };
  });
  return { components, roots };
}

// ---------------------------------------------------------------- 提交与结论

function setBusy() {
  // 立即清除旧结论，避免旧结论在新结果返回前残留。
  resultBox.innerHTML = '';
  resultBox.appendChild(el('p', { class: 'spin', text: '审计执行中…' }));
}

async function submit() {
  const jsonMode = $('input[name="mode"]:checked').value === 'json';
  let payload;
  if (jsonMode) {
    try {
      payload = JSON.parse($('#jsonInput').value);
    } catch (err) {
      resultBox.innerHTML = '';
      resultBox.appendChild(renderErrors([{ code: 'BAD_JSON', message: `JSON 解析失败: ${err.message}` }]));
      return;
    }
  } else {
    payload = buildPayload();
  }
  setBusy();
  let res, body;
  try {
    res = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    body = await res.json();
  } catch (err) {
    resultBox.innerHTML = '';
    resultBox.appendChild(renderErrors([{ code: 'NETWORK', message: `请求失败: ${err.message}` }]));
    return;
  }
  resultBox.innerHTML = '';
  if (body.status === 'invalid') {
    resultBox.appendChild(renderErrors(body.errors));
  } else if (body.status === 'sat') {
    resultBox.appendChild(renderSat(body));
  } else if (body.status === 'unsat') {
    resultBox.appendChild(renderUnsat(body));
  } else {
    resultBox.appendChild(renderErrors(body.errors ?? [{ code: 'UNKNOWN', message: '未知响应' }]));
  }
}

$('#submit').addEventListener('click', submit);

// ---------------------------------------------------------------- 渲染：错误

function locChip(label, value) {
  if (value === undefined || value === null || value === '') return null;
  return el('span', { class: 'chip', text: `${label}: ${value}` });
}

function renderErrors(errors) {
  const wrap = el('div');
  wrap.appendChild(el('p', {}, el('span', { class: 'badge err', text: '输入非法 · 无结论' })));
  wrap.appendChild(el('p', { class: 'small', text: '已立即清除旧结论。请按以下定位修正后重新提交：' }));
  errors.forEach((e) => {
    const item = el('div', { class: 'error-item' });
    item.appendChild(el('div', {}, el('strong', { text: e.code }), ' ', document.createTextNode(e.message)));
    const chips = el(
      'div',
      { class: 'loc-chips' },
      locChip('组件序号', e.componentIndex),
      locChip('组件', e.component),
      locChip('版本序号', e.versionIndex),
      locChip('版本', e.version),
      locChip('根序号', e.rootIndex),
      locChip('依赖', e.dependency),
      typeof e.offset === 'number' ? locChip('字符位置', e.offset) : null,
      e.range ? locChip('范围', e.range) : null,
    );
    item.appendChild(chips);
    wrap.appendChild(item);
  });
  return wrap;
}

// ---------------------------------------------------------------- 渲染：可满足

function renderSat(body) {
  const wrap = el('div');
  wrap.appendChild(
    el('p', {}, el('span', { class: 'badge ok', text: '存在兼容选定' }), ' ',
      el('span', { class: 'small', text: `（可达组件 ${body.reachable.length} 个，按 ASCII 顺序、版本优先取高）` })),
  );
  const table = el('table');
  table.appendChild(el('thead', {}, el('tr', {}, el('th', { text: '组件 (ASCII 顺序)' }), el('th', { text: '选定版本' }), el('th', { text: '满足依据' }))));
  const tbody = el('tbody');
  for (const id of body.reachable) {
    const ev = body.evidence[id];
    const details = el('details', { class: 'tree' }, el('summary', { text: `查看 ${id} 的满足依据` }), renderEvidence(ev));
    tbody.appendChild(el('tr', {}, el('td', { text: id }), el('td', { class: 'pick', text: ev.selected }), el('td', {}, details)));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderEvidence(ev) {
  const box = el('div');
  if (ev.constraints.length === 0) {
    box.appendChild(el('div', { class: 'evidence-list met', text: '该组件无外部范围约束，按规则选取其最高候选版本。' }));
  } else {
    box.appendChild(el('div', { class: 'small', text: '入约束核对：' }));
    ev.constraints.forEach((c) => {
      box.appendChild(
        el(
          'div',
          { class: `evidence-list ${c.satisfied ? 'met' : 'unmet'}` },
          `${c.satisfied ? '✓' : '✗'} [${c.source}] ${c.constraint}  →  ${ev.selected}`,
        ),
      );
    });
  }
  if (ev.requires && ev.requires.length) {
    box.appendChild(el('div', { class: 'small', text: '本版本声明的依赖：' }));
    ev.requires.forEach((r) => {
      box.appendChild(
        el(
          'div',
          { class: `evidence-list ${r.satisfied ? 'met' : 'unmet'}` },
          `${r.satisfied ? '✓' : '✗'} → ${r.target} ${r.range}  选定 ${r.satisfiedVersion}`,
        ),
      );
    });
  }
  return box;
}

// ---------------------------------------------------------------- 渲染：冲突树

function renderUnsat(body) {
  const wrap = el('div');
  wrap.appendChild(el('p', {}, el('span', { class: 'badge err', text: '无兼容版本组合' })));
  wrap.appendChild(el('p', { text: body.tree.title }));
  const rootLine = el('p', { class: 'small' }, '根组件：');
  body.tree.roots.forEach((r) => rootLine.appendChild(el('span', { class: 'chip', text: r })));
  wrap.appendChild(rootLine);
  wrap.appendChild(el('p', {
    class: 'small',
    text: '下方为稳定冲突证明树（沿依赖传播方向展开，候选版本从高到低、覆盖全部候选）：',
  }));
  if (body.tree.node) wrap.appendChild(renderProofNode(body.tree.node, true));
  return wrap;
}

function renderProofNode(node, open) {
  const details = el('details', { class: 'tree' });
  details.appendChild(
    el('summary', {},
      el('strong', { text: node.component }),
      document.createTextNode(` — ${node.candidateCount} 个候选，直接可行 ${node.viableCount} 个`)),
  );
  if (open) details.open = true;

  if (node.incoming?.length) {
    const edges = el('div', { class: 'small', text: '对该组件的入约束：' });
    node.incoming.forEach((e) => {
      edges.appendChild(el('div', { class: 'evidence-list' }, `[${e.source}] 要求 ${node.component} ${e.range}`));
    });
    details.appendChild(edges);
  }

  node.candidates.forEach((c) => {
    const box = el('div', { class: 'cand' });
    if (c.rejected) {
      const d = el('details');
      d.appendChild(el('summary', {}, el('span', { class: 'badge err', text: c.version }), ' ',
        el('span', { class: 'small', text: `被 ${c.violated.length} 条约束直接否决` })));
      c.violated.forEach((vi) => {
        d.appendChild(el('div', { class: 'violations' }, `✗ [${vi.source}] ${vi.constraint}：${vi.reason}`));
      });
      box.appendChild(d);
    } else if (node.expanded?.version === c.version) {
      const d = el('details');
      d.appendChild(el('summary', {}, el('span', { class: 'badge warn', text: c.version }), ' ',
        el('span', { class: 'small', text: '自身不违反当前约束，但选定后回溯全部版本组合仍无解' })));
      d.appendChild(renderProofNode(node.expanded.child, false));
      box.appendChild(d);
    } else if (c.deadBranch) {
      box.appendChild(el('div', {}, el('span', { class: 'badge warn', text: c.version }), ' ',
        el('span', { class: 'small', text: '回溯证明：选定该版本后无完整解' })));
    } else {
      box.appendChild(el('span', {}, el('span', { class: 'badge ok', text: c.version }), ' ',
        el('span', { class: 'small', text: '可行' })));
    }
    details.appendChild(box);
  });
  return details;
}

// ---------------------------------------------------------------- 示例

async function loadSamplePayload(payload) {
  $('input[name="mode"][value="form"]').checked = true;
  $('#formMode').hidden = false;
  $('#jsonMode').hidden = true;
  $('#jsonInput').value = JSON.stringify(payload, null, 2);
  // 将载入的 JSON 回填到表单状态。
  state.components = payload.components.map((c) => ({
    id: c.id,
    versions: c.versions.map((v) => ({
      version: v.version,
      deps: Object.entries(v.dependencies ?? {}).map(([id, range]) => ({ id, range })),
    })),
  }));
  state.roots = payload.roots.map((r) => ({
    id: r.id,
    deps: Object.entries(r.dependencies ?? {}).map(([id, range]) => ({ id, range })),
  }));
  renderAll();
  resultBox.innerHTML = '';
  resultBox.appendChild(el('p', { class: 'hint', text: '示例已载入，点击「执行审计」。' }));
}

$('#loadSample').addEventListener('click', async () => {
  const res = await fetch('/api/sample');
  const body = await res.json();
  loadSamplePayload(body.sample);
});
$('#loadConflict').addEventListener('click', () => {
  loadSamplePayload({
    components: [
      { id: 'BUS', versions: ['1.0.0', '1.5.0', '2.0.0', '2.1.0'].map((v) => ({ version: v, dependencies: {} })) },
      { id: 'CTRL', versions: [{ version: '1.0.0', dependencies: { BUS: '>=2.0.0' } }] },
      { id: 'PWR', versions: [{ version: '1.0.0', dependencies: { BUS: '<2.0.0' } }] },
    ],
    roots: [{ id: 'CTRL', dependencies: {} }, { id: 'PWR', dependencies: {} }],
  });
});

renderAll();
