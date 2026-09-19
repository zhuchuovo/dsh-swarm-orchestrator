/**
 * dsh-swarm-orchestrator/client — 并行子代理集群的可视化半边。
 *
 * 两个席位：
 *   - `conversation.input.dock`（id `swarm-board`）：输入框上方的实时看板，一行一个子代理，
 *     显示状态、模型、此刻正在执行的工具与目标文件、步数/工具次数、耗时、进度条；点行打开该
 *     子代理的会话。当前会话没有集群任务时返回 null，不占位。
 *   - `settings.section`（id `swarm`）：配置页——并发数、验收代理开关、子代理后端、逐切片模型分配。
 *
 * 数据面走 host 半边的 `/api/swarm/*` 路由（常驻插件没有 host.call，那是动态 Package 的私有 RPC）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-swarm-orchestrator',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');

    const API = '/api/swarm';
    const STYLE_ID = 'swarm-orchestrator-style';

    const CSS = `
.swrm-wrap{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;margin:6px 0;font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;line-height:1.5}
.swrm-head{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;user-select:none;flex-wrap:wrap}
.swrm-title{font-weight:600}
.swrm-meta{color:var(--dsw-alias-label-secondary)}
.swrm-spacer{flex:1}
.swrm-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 8px;cursor:pointer;font-size:11px;font-family:inherit}
.swrm-btn:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.swrm-body{border-top:1px solid var(--dsw-alias-border-l1)}
.swrm-row{display:flex;gap:8px;padding:7px 10px;align-items:flex-start;border-top:1px solid var(--dsw-alias-border-l1);cursor:pointer}
.swrm-row:first-child{border-top:none}
.swrm-row:hover{background:var(--dsw-alias-bg-layer-2)}
.swrm-dot{width:8px;height:8px;border-radius:50%;margin-top:6px;flex:0 0 auto;background:var(--dsw-alias-label-secondary)}
.swrm-dot.run{background:var(--dsw-alias-brand-primary);animation:swrm-pulse 1.1s ease-in-out infinite}
.swrm-dot.done{background:var(--dsw-alias-state-success-primary)}
.swrm-dot.fail{background:var(--dsw-alias-state-error-primary)}
.swrm-dot.wait{background:var(--dsw-alias-state-warn-primary)}
@keyframes swrm-pulse{0%,100%{opacity:1}50%{opacity:.3}}
.swrm-main{flex:1;min-width:0}
.swrm-name{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
.swrm-name b{font-weight:600}
.swrm-tag{color:var(--dsw-alias-label-secondary);font-size:11px}
.swrm-act{margin-top:1px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.swrm-act b{color:var(--dsw-alias-label-primary);font-weight:500}
.swrm-last{margin-top:1px;color:var(--dsw-alias-label-secondary);opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.swrm-right{flex:0 0 auto;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.swrm-bar{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);margin-top:5px;overflow:hidden}
.swrm-bar>i{display:block;height:100%;width:35%;background:var(--dsw-alias-brand-primary);animation:swrm-slide 1.3s linear infinite}
.swrm-bar.done>i{width:100%;animation:none;background:var(--dsw-alias-state-success-primary)}
.swrm-bar.fail>i{width:100%;animation:none;background:var(--dsw-alias-state-error-primary)}
.swrm-bar.wait>i{width:12%;animation:none;background:var(--dsw-alias-state-warn-primary)}
@keyframes swrm-slide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
.swrm-foot{padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.swrm-set{display:flex;flex-direction:column;gap:16px;max-width:660px;padding:2px}
.swrm-field{display:flex;flex-direction:column;gap:6px}
.swrm-label{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:600}
.swrm-input,.swrm-select{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 6px;font-size:12px;font-family:inherit}
.swrm-input{width:80px}
.swrm-slot{display:flex;gap:8px;align-items:center}
.swrm-slot>span{width:56px;flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:12px}
.swrm-slot .swrm-select{flex:1;min-width:0}
.swrm-note{font-size:12px;color:var(--dsw-alias-label-secondary)}
.swrm-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.swrm-primary{background:var(--dsw-alias-brand-primary);color:#fff;border:none;border-radius:6px;padding:5px 14px;font-size:12px;cursor:pointer;font-family:inherit}
.swrm-check{display:flex;gap:6px;align-items:center;font-size:12px}
.swrm-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.7}
.swrm-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:0 4px}
`;

    function ensureStyle() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID)) return;
      const tag = document.createElement('style');
      tag.id = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** 调 host 半边的 /api/swarm/*。 */
    async function api(path, options) {
      const res = await fetch(API + path, options);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    const post = (path, payload) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    function formatMs(ms) {
      const total = Math.max(0, Math.round(ms / 1000));
      const m = Math.floor(total / 60);
      const s = total % 60;
      return (m < 10 ? '0' + m : String(m)) + ':' + (s < 10 ? '0' + s : String(s));
    }

    const STATUS_TEXT = {
      queued: '排队', running: '运行中', verifying: '验收中', done: '完成', failed: '失败', cancelled: '已中止',
    };
    const DOT_CLASS = {
      queued: 'wait', running: 'run', verifying: 'run', done: 'done', failed: 'fail', cancelled: 'fail',
    };
    const ACTIVITY_ICON = {
      read: '⌕', write: '✎', run: '▶', web: '☁', tool: '⚙', thinking: '…', idle: '·', error: '✕', queued: '○',
    };

    /** 轮询看板：1.2s 一次，未挂载时自动停。 */
    function useBoard(sessionId) {
      const [board, setBoard] = React.useState(null);
      React.useEffect(() => {
        if (!sessionId) {
          setBoard(null);
          return undefined;
        }
        let alive = true;
        const tick = () => {
          api('/snapshot?sessionId=' + encodeURIComponent(sessionId))
            .then((value) => { if (alive) setBoard(value && value.board ? value.board : null); })
            .catch(() => { /* 保留上一帧快照 */ });
        };
        tick();
        const handle = setInterval(tick, 1200);
        return () => {
          alive = false;
          clearInterval(handle);
        };
      }, [sessionId]);
      return board;
    }

    function unitRow(unit, parentSessionId, sessions, onCancel) {
      const statusText = STATUS_TEXT[unit.status] || unit.status;
      const icon = ACTIVITY_ICON[unit.activity.kind] || '·';
      const barClass = 'swrm-bar ' + (DOT_CLASS[unit.status] || 'wait');
      const route = unit.provider ? unit.provider + '/' + unit.model : '继承父会话';
      const openChild = () => {
        if (!sessions || !unit.childSessionId || !parentSessionId) return;
        try {
          sessions.openSubagent({ parentSessionId, childSessionId: unit.childSessionId, mode: 'one-shot' });
        } catch (error) {
          console.error('[swarm] open child failed', error);
        }
      };
      return React.createElement('div', {
        key: unit.key,
        className: 'swrm-row',
        onClick: openChild,
        title: unit.childSessionId ? '点击打开该子代理的会话' : '',
      }, [
        React.createElement('span', { key: 'dot', className: 'swrm-dot ' + (DOT_CLASS[unit.status] || 'wait') }),
        React.createElement('div', { key: 'main', className: 'swrm-main' }, [
          React.createElement('div', { key: 'name', className: 'swrm-name' }, [
            React.createElement('b', { key: 'n' }, unit.name),
            React.createElement('span', { key: 't' }, unit.title),
            React.createElement('span', { key: 's', className: 'swrm-tag' }, statusText),
            React.createElement('span', { key: 'm', className: 'swrm-tag' }, route),
          ]),
          React.createElement('div', { key: 'act', className: 'swrm-act' }, [
            React.createElement('b', { key: 'i' }, icon + ' ' + (unit.activity.label || '')),
            unit.activity.detail ? React.createElement('span', { key: 'd' }, '  ' + unit.activity.detail) : null,
            React.createElement('span', { key: 'c', className: 'swrm-tag' }, '  · 步 ' + unit.steps + ' · 工具 ' + unit.toolCalls),
          ]),
          unit.lastText ? React.createElement('div', { key: 'last', className: 'swrm-last' }, unit.lastText) : null,
          React.createElement('div', { key: 'bar', className: barClass }, React.createElement('i', null)),
        ]),
        React.createElement('div', { key: 'right', className: 'swrm-right' }, [
          React.createElement('div', { key: 'e' }, formatMs(unit.elapsedMs)),
          unit.status === 'running' || unit.status === 'verifying'
            ? React.createElement('button', {
              key: 'x',
              className: 'swrm-btn',
              onClick: (event) => {
                event.stopPropagation();
                onCancel(unit.key);
              },
            }, '中止')
            : null,
        ]),
      ]);
    }

    function BoardView(props) {
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : '';
      const board = useBoard(sessionId);
      const [open, setOpen] = React.useState(true);
      const sessions = props && props.__sessions ? props.__sessions : null;
      if (!board) return null;
      const counts = board.counts || { running: 0, done: 0, failed: 0, queued: 0 };
      const cancel = (unitKey) => {
        post('/cancel', { sessionId, unitKey: unitKey || '' }).catch(() => { /* 忽略 */ });
      };
      const head = React.createElement('div', {
        className: 'swrm-head',
        onClick: () => setOpen(!open),
      }, [
        React.createElement('span', { key: 't', className: 'swrm-title' }, '🐝 并行子代理集群'),
        React.createElement('span', { key: 'c', className: 'swrm-meta' }, '并发 ' + board.concurrency),
        React.createElement('span', { key: 'r', className: 'swrm-meta' }, '● ' + counts.running + ' 运行'),
        counts.queued > 0 ? React.createElement('span', { key: 'q', className: 'swrm-meta' }, '○ ' + counts.queued + ' 排队') : null,
        React.createElement('span', { key: 'd', className: 'swrm-meta' }, '✓ ' + counts.done + ' 完成'),
        counts.failed > 0 ? React.createElement('span', { key: 'f', className: 'swrm-meta' }, '✕ ' + counts.failed + ' 失败') : null,
        board.verify ? React.createElement('span', { key: 'v', className: 'swrm-meta' }, '含验收') : null,
        React.createElement('span', { key: 's', className: 'swrm-spacer' }),
        React.createElement('span', { key: 'e', className: 'swrm-meta' }, formatMs(board.elapsedMs)),
        React.createElement('span', { key: 'o', className: 'swrm-meta' }, open ? '收起 ▾' : '展开 ▸'),
      ]);
      const body = open
        ? React.createElement('div', { className: 'swrm-body' }, board.units.map(
          unit => unitRow(unit, board.parentSessionId, sessions, cancel),
        ))
        : null;
      const foot = open
        ? React.createElement('div', { className: 'swrm-foot' }, [
          React.createElement('span', { key: 'g' }, '目标：' + board.goal),
          React.createElement('span', { key: 'sp', className: 'swrm-spacer' }),
          board.status === 'running' || board.status === 'verifying'
            ? React.createElement('button', { key: 'c', className: 'swrm-btn', onClick: () => cancel('') }, '中止全部')
            : React.createElement('span', { key: 'c', className: 'swrm-tag' }, '已结束 · 后端 ' + (board.provider || '—')),
        ])
        : null;
      return React.createElement('div', { className: 'swrm-wrap' }, [head, body, foot]);
    }

    function findProvider(options, id) {
      if (!options || !Array.isArray(options.providers)) return null;
      return options.providers.find(item => item.id === id) || null;
    }

    function routeSelects(label, route, options, onRoute) {
      const providers = options && Array.isArray(options.providers) ? options.providers : [];
      const providerId = route ? route.provider : '';
      const provider = findProvider(options, providerId);
      const models = provider && Array.isArray(provider.models) ? provider.models : [];
      const providerOptions = [React.createElement('option', { key: '__inherit', value: '' }, '继承父会话（默认）')].concat(
        providers.map(item => React.createElement('option', { key: item.id, value: item.id }, item.name || item.id)),
      );
      const modelOptions = models.map(item => React.createElement('option', { key: item.id, value: item.id }, item.name || item.id));
      return React.createElement('div', { key: 'slot-' + label, className: 'swrm-slot' }, [
        React.createElement('span', { key: 'l' }, label),
        React.createElement('select', {
          key: 'p',
          className: 'swrm-select',
          value: providerId,
          onChange: (event) => {
            const next = event.target.value;
            if (!next) { onRoute(null); return; }
            const found = findProvider(options, next);
            onRoute({ provider: next, model: found && found.models.length > 0 ? found.models[0].id : '' });
          },
        }, providerOptions),
        React.createElement('select', {
          key: 'm',
          className: 'swrm-select',
          value: route ? route.model : '',
          disabled: !providerId,
          onChange: (event) => onRoute({ provider: providerId, model: event.target.value }),
        }, modelOptions.length > 0 ? modelOptions : [React.createElement('option', { key: '__none', value: '' }, '（无可选模型）')]),
      ]);
    }

    function SettingsView() {
      const [loaded, setLoaded] = React.useState(false);
      const [cfg, setCfg] = React.useState(null);
      const [options, setOptions] = React.useState(null);
      const [note, setNote] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(() => {
        setNote('');
        api('/options').then((value) => {
          setOptions(value || null);
          setCfg(value && value.config ? value.config : null);
          setLoaded(true);
        }).catch((error) => {
          setNote('读取失败：' + String((error && error.message) || error));
          setLoaded(true);
        });
      }, []);

      React.useEffect(() => { load(); }, [load]);

      if (!loaded) return React.createElement('div', { className: 'swrm-note' }, '读取中…');
      if (!cfg) return React.createElement('div', { className: 'swrm-note' }, note || '无法读取配置。');

      const patch = changes => setCfg(Object.assign({}, cfg, changes));
      const setSlot = (index, route) => {
        const next = (cfg.slots || []).slice();
        while (next.length < 8) next.push(null);
        next[index] = route;
        patch({ slots: next });
      };
      const save = () => {
        setBusy(true);
        post('/config', { config: cfg }).then((value) => {
          setBusy(false);
          if (value && value.config) setCfg(value.config);
          setNote('已保存到 $DSH_HOME/swarm-orchestrator.json，下个集群任务生效。');
        }).catch((error) => {
          setBusy(false);
          setNote('保存失败：' + String((error && error.message) || error));
        });
      };

      const slotRows = [];
      for (let i = 0; i < cfg.concurrency; i += 1) {
        slotRows.push(routeSelects('#' + (i + 1), (cfg.slots || [])[i] || null, options, route => setSlot(i, route)));
      }
      const providerNames = options && Array.isArray(options.subagentProviders) ? options.subagentProviders : [];
      const providerOptions = [React.createElement('option', { key: '__auto', value: '' }, '自动（优先 fork，其次 spawn）')].concat(
        providerNames.map(name => React.createElement('option', { key: name, value: name }, name)),
      );

      return React.createElement('div', { className: 'swrm-set' }, [
        React.createElement('div', { key: 'h', className: 'swrm-hint' }, [
          '母代理用 ',
          React.createElement('span', { key: 'a', className: 'swrm-code' }, 'swarm_run'),
          ' 把目标拆成多个切片，插件按下面的并发数同时驱动多个独立子代理（每个都是独立会话，可分别指定模型），全部完成后可选派发一名独立验收代理。会话输入框上方会实时显示每个子代理正在做什么。',
        ]),
        React.createElement('div', { key: 'c', className: 'swrm-field' }, [
          React.createElement('span', { key: 'l', className: 'swrm-label' }, '并发子代理数（1-8）'),
          React.createElement('input', {
            key: 'i',
            className: 'swrm-input',
            type: 'number',
            min: 1,
            max: 8,
            value: cfg.concurrency,
            onChange: (event) => {
              const parsed = parseInt(event.target.value, 10);
              patch({ concurrency: isNaN(parsed) ? 1 : Math.min(8, Math.max(1, parsed)) });
            },
          }),
          React.createElement('span', { key: 'n', className: 'swrm-note' }, '例如 2 表示同时有 2 个子代理在写代码，其余切片排队等空位。'),
        ]),
        React.createElement('div', { key: 'v', className: 'swrm-field' }, [
          React.createElement('label', { key: 'l', className: 'swrm-check' }, [
            React.createElement('input', {
              key: 'c',
              type: 'checkbox',
              checked: Boolean(cfg.verify),
              onChange: event => patch({ verify: event.target.checked }),
            }),
            React.createElement('span', { key: 't' }, '全部切片完成后派发独立验收代理（检测与验收）'),
          ]),
          React.createElement('span', { key: 'n', className: 'swrm-note' }, '验收代理优先使用全新会话（spawn）保持独立判断，只读不改；可单独指定模型。'),
        ]),
        React.createElement('div', { key: 'p', className: 'swrm-field' }, [
          React.createElement('span', { key: 'l', className: 'swrm-label' }, '子代理后端'),
          React.createElement('select', {
            key: 's',
            className: 'swrm-select',
            value: cfg.provider || '',
            onChange: event => patch({ provider: event.target.value }),
          }, providerOptions),
          React.createElement('span', { key: 'n', className: 'swrm-note' }, 'fork = 子代理继承父代理已完成轮次的上下文；spawn = 全新空上下文。当前生效：' + ((options && options.active) || '—')),
        ]),
        React.createElement('div', { key: 'm', className: 'swrm-field' }, [
          React.createElement('span', { key: 'l', className: 'swrm-label' }, '模型分配（在已有运营商中选取，可多个 DeepSeek 模型混用）'),
          React.createElement('div', { key: 'rows' }, slotRows),
          routeSelects('验收', cfg.verifier || null, options, route => patch({ verifier: route })),
          React.createElement('span', { key: 'n', className: 'swrm-note' }, '每个子代理按 #1、#2… 顺序取对应行的模型；「继承父会话」表示不指定，沿用母代理的路由。'),
        ]),
        React.createElement('div', { key: 'a', className: 'swrm-actions' }, [
          React.createElement('button', { key: 's', className: 'swrm-primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          React.createElement('button', { key: 'r', className: 'swrm-btn', onClick: load }, '重新读取'),
          note ? React.createElement('span', { key: 'n', className: 'swrm-note' }, note) : null,
        ]),
        React.createElement('div', { key: 't', className: 'swrm-hint' }, [
          '这是常驻插件：重启后依然在，配置存在 $DSH_HOME/swarm-orchestrator.json。',
        ]),
      ]);
    }

    const inject = ['slots'];

    function apply(ctx) {
      ensureStyle();
      const slots = ctx.get('slots');
      if (!slots) return;
      const sessions = ctx.get('sessions');

      const contribute = (options, component) => {
        try {
          slots.inject(options.name, () => slots.register(options, component));
        } catch (error) {
          console.error('[swarm] register failed for ' + options.name, error);
        }
      };

      // 看板需要 sessions 才能点行跳转；通过 props 透传，避免组件内重复 ctx.get。
      contribute(
        { name: 'conversation.input.dock', id: 'swarm-board', order: 5 },
        props => React.createElement(BoardView, Object.assign({}, props, { __sessions: sessions })),
      );
      contribute(
        { name: 'settings.section', id: 'swarm', order: 30, label: '并行子代理集群' },
        () => React.createElement(SettingsView, null),
      );
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
