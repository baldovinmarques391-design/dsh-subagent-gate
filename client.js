/**
 * 设置 → 通用设置 里的「原生子代理」开关（浏览器侧）。
 * 值来自宿主插件 @local/dsh-subagent-gate 的 Config（configForms 命名空间 = 行 id = subagent-gate）。
 * 只依赖 react 与主题令牌，不 import 任何 Harness 客户端包。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-subagent-gate',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const en = {
      title: 'Native subagents',
      description: 'Off: every subagent prompt text disappears and the Subagent card leaves the Plugins page. On: the card returns, and the prompt is injected only for sessions that really have subagents.',
      saved: 'Preference saved',
      failed: 'Could not save preference',
    }
    const zh = {
      title: '原生子代理',
      description: '关掉后：关于子代理的提示词整块消失，插件页里的「子智能体」卡片也不再显示。打开后卡片回来，提示词只在会话里确实有子代理时才注入。',
      saved: '设置已保存',
      failed: '无法保存设置',
    }

    const CSS = [
      '.sg_row{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.sg_title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.sg_desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}',
      '.sg_knob{width:16px;height:16px;border-radius:50%;background:#fff;display:block;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
    ].join('')

    function Row(props) {
      const form = props.useValue((value) => value)
      // 设置表单的 value 只带"显式写过的字段"；没写过就等于 schema 默认值（本插件默认开）。
      const raw = form?.value
      const record = raw && typeof raw === 'object'
        ? (Object.prototype.hasOwnProperty.call(raw, 'enabled') ? raw : (raw['subagent-gate'] ?? {}))
        : {}
      const checked = record.enabled !== false
      const refused = form?.writable === false
      const track = {
        flex: 'none', width: 36, height: 20, borderRadius: 10, border: 'none', padding: 2,
        display: 'flex', alignItems: 'center',
        background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-idle-primary)',
        justifyContent: checked ? 'flex-end' : 'flex-start',
        cursor: refused ? 'default' : 'pointer',
        opacity: refused ? 0.5 : 1,
        transition: 'background .15s ease',
      }
      return h('div', { className: 'sg_row' }, [
        h('div', { key: 'copy' }, [
          h('div', { className: 'sg_title', key: 'title' }, props.t('title')),
          h('div', { className: 'sg_desc', key: 'desc' }, props.t('description')),
        ]),
        h('button', {
          key: 'switch',
          type: 'button',
          role: 'switch',
          style: track,
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': props.t('title'),
          disabled: refused,
          onClick: () => props.setEnabled(!checked),
        }, h('span', { className: 'sg_knob' })),
      ])
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const locale = 'settings.subagentGate'
        const namespace = 'subagent-gate'
        ctx.effect(() => ctx.locale.register(locale, { en, zh }))
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = '@local/dsh-subagent-gate'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => { tag.remove() }
        })
        const form = ctx.configForms.get(namespace)
        const face = () => ({
          hooks: { value: form },
          setEnabled: (enabled) => { void form.set('enabled', enabled === true) },
        })
        ctx.effect(() => ctx.configForms.whileServed([namespace], () => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: namespace,
          order: 95,
          locale,
          inject: face,
        }, Row))))
      },
    }
  },
})
