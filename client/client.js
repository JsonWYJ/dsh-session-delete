/**
 * dsh-session-delete browser half.
 *
 * Registers one destructive action on a Session row. The menu contribution goes
 * through `ctx.contextMenus` when the Host ships it (so Delete lands after the
 * shipped Archive), and falls back to the legacy
 * `sidebar.workspaces.session.menu.item` Slot on older Hosts.
 *
 * The confirmation dialog cannot live inside the menu: the menu unmounts the
 * instant an entry is chosen. It is therefore plain DOM on a body-level
 * container, with no React root and no second renderer to depend on.
 *
 * Activation is deliberately fault-tolerant. A Host whose locale, menu, or slot
 * service behaves differently must not turn into a boot failure: every wiring
 * step reports its own failure to the Host
 * (`<DSH_HOME>/cache/dsh-session-delete/client-error.json`) and the rest still
 * runs.
 *
 * @module dsh-session-delete/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-session-delete',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		/** Shared primitives; optional so a Host without them still renders plain buttons. */
		let P = {};
		try {
			P = require('@deepseek-ai/dsh-client-ui-primitives') || {};
		} catch (e) {
			P = {};
		}
		const hasUI = (name) => P[name] !== undefined && P[name] !== null;

		// ── locale ───────────────────────────────────────────────────────────
		const NS = 'dshSessionDelete';
		const MESSAGES = {
			zh: {
				'menu.delete': '删除会话…',
				'dialog.title': '永久删除这个会话？',
				'dialog.desc': '「{title}」会从侧栏移除，对话记录移动到本地回收目录，需要时可以手动恢复。',
				'dialog.descBlank': '这个空白会话会从侧栏移除，对话记录移动到本地回收目录。',
				'dialog.cancel': '取消',
				'dialog.confirm': '删除',
				'dialog.pending': '正在删除…',
				'error.busy': '这个会话的文件正被占用（可能正在使用），请先切到其他会话或重启 DSH 后再删除。',
				'error.invalid': '会话标识无效。',
				'error.failed': '删除失败：{detail}',
			},
			en: {
				'menu.delete': 'Delete session…',
				'dialog.title': 'Delete this session for good?',
				'dialog.desc': '"{title}" leaves the sidebar and its transcript moves to the local trash directory, which you can restore from by hand.',
				'dialog.descBlank': 'This blank session leaves the sidebar and its files move to the local trash directory.',
				'dialog.cancel': 'Cancel',
				'dialog.confirm': 'Delete',
				'dialog.pending': 'Deleting…',
				'error.busy': 'This session\u2019s files are in use. Switch to another session, or restart DSH, and try again.',
				'error.invalid': 'Invalid session id.',
				'error.failed': 'Delete failed: {detail}',
			},
		};

		/** Stand-in translator used until `ctx.locale` hands over the real one. */
		let translate = (key, vars) => {
			const language = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase();
			const dict = language.startsWith('zh') ? MESSAGES.zh : MESSAGES.en;
			const text = dict[key] ?? MESSAGES.en[key] ?? key;
			return vars === undefined ? text : String(text).replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])));
		};

		// ── styles ───────────────────────────────────────────────────────────
		const CSS = [
			'.dshsd-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.34)}',
			'.dshsd-panel{box-sizing:border-box;width:min(380px,100%);display:flex;flex-direction:column;gap:14px;padding:18px;border-radius:var(--dsw-radius-lg,12px);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);box-shadow:0 16px 48px rgba(0,0,0,.22);font:inherit;font-size:13px;line-height:1.55}',
			'.dshsd-title{margin:0;font-size:15px;font-weight:600}',
			'.dshsd-desc{margin:0;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary,#444))}',
			'.dshsd-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}',
			'.dshsd-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,#d33)}',
			'.dshsd-footer{display:flex;justify-content:flex-end;gap:8px}',
			'.dshsd-btn{height:30px;padding:0 14px;border-radius:var(--dsw-radius-md,8px);border:0.5px solid var(--dsw-alias-border-l4);background:transparent;color:inherit;font:inherit;cursor:pointer}',
			'.dshsd-btn:disabled{opacity:.5;cursor:default}',
			'.dshsd-btn-danger{border-color:transparent;background:var(--dsw-alias-state-error-primary,#d33);color:#fff}',
		].join('');

		const STYLE_ID = 'dsh-session-delete/dialog.css';
		function installStyles() {
			if (typeof document === 'undefined') return;
			let tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']');
			if (tag === null) {
				tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-session-delete';
				tag.dataset.pluginCss = STYLE_ID;
				document.head.appendChild(tag);
			}
			tag.textContent = CSS;
		}

		function el(tag, className, text) {
			const node = document.createElement(tag);
			if (className !== undefined) node.className = className;
			if (text !== undefined) node.textContent = text;
			return node;
		}

		// ── host calls (Typert Remote `sessionDelete/*`) ─────────────────────
		let connection = null;
		async function call(method, request) {
			if (connection === null || connection === undefined) throw new Error('connection not ready');
			const envelope = await connection.rpc.call('/api', 'sessionDelete/' + method, { args: { request } });
			if (envelope && typeof envelope === 'object' && envelope.ok === false) {
				throw new Error((envelope.error && envelope.error.message) || 'request failed');
			}
			return envelope && typeof envelope === 'object' && envelope.ok === true && 'value' in envelope ? envelope.value : envelope;
		}

		/** Record one browser-half failure where the Host's owner can read it. */
		function report(label, error) {
			const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
			try {
				if (typeof console !== 'undefined' && typeof console.error === 'function') console.error('[dsh-session-delete]', label, error);
			} catch (e) {
				// console is best effort
			}
			try {
				void call('report', { label, detail }).catch(() => {});
			} catch (e) {
				// reporting is best effort
			}
		}

		// ── dialog (plain DOM: no React root, no second renderer) ────────────
		let dialog = null;

		function closeDialog() {
			const current = dialog;
			dialog = null;
			if (current === null) return;
			document.removeEventListener('keydown', current.onKey, true);
			current.backdrop.remove();
		}

		function openDialog(target) {
			if (dialog !== null) return;
			installStyles();
			const backdrop = el('div', 'dshsd-backdrop');
			const panel = el('div', 'dshsd-panel');
			panel.setAttribute('role', 'dialog');
			panel.setAttribute('aria-modal', 'true');
			panel.setAttribute('aria-label', translate('dialog.title'));

			const title = el('h2', 'dshsd-title', translate('dialog.title'));
			const blank = target.blank === true || !target.displayTitle;
			const desc = el('p', 'dshsd-desc', blank ? translate('dialog.descBlank') : translate('dialog.desc', { title: target.displayTitle }));
			const hints = el('div', 'dshsd-hints');
			const footer = el('div', 'dshsd-footer');

			const cancel = el('button', 'dshsd-btn', translate('dialog.cancel'));
			cancel.type = 'button';
			const confirm = el('button', 'dshsd-btn dshsd-btn-danger', translate('dialog.confirm'));
			confirm.type = 'button';

			let pending = false;
			const setPending = (value) => {
				pending = value;
				cancel.disabled = value;
				confirm.disabled = value;
				if (value) hints.replaceChildren(el('p', 'dshsd-hint', translate('dialog.pending')));
				else hints.replaceChildren();
			};
			const showError = (text) => {
				setPending(false);
				hints.replaceChildren(el('p', 'dshsd-error', text));
			};

			cancel.addEventListener('click', () => {
				if (!pending) closeDialog();
			});
			confirm.addEventListener('click', () => {
				if (pending) return;
				setPending(true);
				call('delete', { sessionId: target.sessionId }).then((result) => {
					if (result && result.deleted === true) {
						closeDialog();
						return;
					}
					const code = result && typeof result.code === 'string' ? result.code : 'failed';
					if (code === 'busy') showError(translate('error.busy'));
					else if (code === 'invalid') showError(translate('error.invalid'));
					else showError(translate('error.failed', { detail: (result && result.detail) || code }));
				}).catch((reason) => {
					report('delete', reason);
					showError(translate('error.failed', { detail: (reason && reason.message) || String(reason) }));
				});
			});

			const onKey = (event) => {
				if (event.key === 'Escape' && !pending) closeDialog();
			};
			backdrop.addEventListener('mousedown', (event) => {
				if (event.target === backdrop && !pending) closeDialog();
			});

			footer.append(cancel, confirm);
			panel.append(title, desc, hints, footer);
			backdrop.append(panel);
			document.body.append(backdrop);
			document.addEventListener('keydown', onKey, true);
			dialog = { backdrop, onKey };
			cancel.focus();
		}

		// ── menu contributions ───────────────────────────────────────────────
		/**
		 * Legacy Slot entry, used only when the Host has no `contextMenus` service.
		 * @param props - the Slot project: Session identity, its label, and menu dismissal.
		 * @returns the menu row.
		 */
		function LegacyMenuItem(props) {
			const { sessionId, displayTitle, useMenuOpenState } = props;
			const onClick = () => {
				if (typeof useMenuOpenState === 'function') {
					const pair = useMenuOpenState();
					if (Array.isArray(pair) && typeof pair[1] === 'function') pair[1](false);
				}
				openDialog({ sessionId, displayTitle });
			};
			if (hasUI('MenuItemButton')) {
				return React.createElement(P.MenuItemButton, { separatorBefore: true, onSelect: onClick }, translate('menu.delete'));
			}
			return React.createElement('button', {
				type: 'button',
				role: 'menuitem',
				className: 'dshsd-btn',
				style: { width: '100%', textAlign: 'left', border: 'none', background: 'transparent' },
				onClick,
			}, translate('menu.delete'));
		}

		const inject = ['slots', 'locale', 'connection', 'contextMenus'];

		/** Slot key for the glyph this plugin contributes to `contextMenu.icon`. */
		const ICON_KEY = 'session-delete.delete';

		/** Run one wiring step; a failure is reported, never fatal. */
		function step(label, run) {
			try {
				return run();
			} catch (error) {
				report(label, error);
				return undefined;
			}
		}

		/** Run one call that a Cordis effect may invoke later; never throws. */
		function safe(label, run) {
			try {
				return run();
			} catch (error) {
				report(label, error);
				return undefined;
			}
		}

		function apply(ctx) {
			connection = step('connection', () => (ctx.connection !== undefined ? ctx.connection : ctx.get ? ctx.get('connection') : null)) || null;

			step('locale-register', () => {
				if (ctx.locale && typeof ctx.locale.register === 'function') {
					ctx.effect(() => safe('locale-register', () => ctx.locale.register(NS, MESSAGES)), 'dsh-session-delete: dictionaries');
				}
			});
			step('locale-bind', () => {
				if (ctx.locale && typeof ctx.locale.bind === 'function') {
					const bound = safe('locale-bind', () => ctx.locale.bind(NS));
					if (typeof bound === 'function') translate = (key, vars) => bound(key, vars);
				}
			});

			// Glyph for the menu row: the menu service renders whatever component
			// this slot key resolves to, exactly as the shipped actions do.
			let iconReady = false;
			step('icon', () => {
				const Icon = P.IconTrashOutlineRegular;
				if (Icon === undefined || Icon === null) return;
				if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;
				ctx.effect(() => safe('icon-register', () => ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
					name: 'contextMenu.icon',
					key: ICON_KEY,
				}, Icon))), 'dsh-session-delete: menu icon');
				iconReady = true;
			});

			const menus = step('menus', () => ctx.contextMenus);
			if (menus !== undefined && menus !== null && typeof menus.register === 'function') {
				let claimed = false;
				step('menu-register', () => {
					ctx.effect(() => {
						const dispose = safe('menu-register', () => menus.register({
							id: 'session.delete',
							target: 'session',
							order: 700,
							observe: () => [],
							resolve: (target) => [{
								id: 'delete',
								label: translate('menu.delete'),
								...(iconReady ? { icon: { key: ICON_KEY } } : {}),
								danger: true,
								separatorBefore: true,
								afterContent: true,
								run: () => openDialog({ sessionId: target.sessionId, displayTitle: target.displayTitle, blank: target.blank }),
							}],
						}));
						if (typeof dispose === 'function') claimed = true;
					}, 'dsh-session-delete: session menu action');
				});
				if (claimed) return;
			}

			step('legacy-slot', () => {
				if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;
				ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
					name: 'sidebar.workspaces.session.menu.item',
					id: 'dsh-session-delete.delete',
					order: 500,
					locale: NS,
				}, LegacyMenuItem)), 'dsh-session-delete: legacy session menu item');
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__testing = { MESSAGES, openDialog, closeDialog, call };
		return module.exports;
	},
});
