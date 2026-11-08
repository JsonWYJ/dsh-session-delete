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

		/** Fill one dictionary string's `{placeholder}` slots. */
		function fill(text, vars) {
			return vars === undefined ? text : String(text).replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])));
		}

		/** Locale face handed over by `apply`; `resolveText` follows the GUI language. */
		let localeFace = null;

		/** Look one key up in the dictionaries compiled into this bundle. */
		function localTranslate(key, vars) {
			let text;
			if (localeFace !== null && typeof localeFace.resolveText === 'function') {
				try {
					const map = {};
					for (const locale of Object.keys(MESSAGES)) map[locale] = MESSAGES[locale][key];
					const resolved = localeFace.resolveText(map);
					if (typeof resolved === 'string' && resolved !== '') text = resolved;
				} catch {
					// Fall through to the browser language below.
				}
			}
			if (text === undefined) {
				const language = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase();
				const dict = language.startsWith('zh') ? MESSAGES.zh : MESSAGES.en;
				text = dict[key] ?? MESSAGES.en[key] ?? key;
			}
			return fill(text, vars);
		}

		/**
		 * Owner of every string this plugin shows.
		 *
		 * `ctx.locale.bind(ns)` is consulted first so the row follows a GUI
		 * language switch. A Host whose locale service cannot see this namespace
		 * (registered late, disposed by a remount, served by a different locale
		 * instance) answers with the key itself, and a menu that reads
		 * `menu.delete` is never acceptable — so a key-shaped answer falls back to
		 * the dictionaries compiled into this module.
		 */
		let serviceTranslate = null;
		let translate = (key, vars) => {
			if (serviceTranslate !== null) {
				try {
					const served = serviceTranslate(key, vars);
					if (typeof served === 'string' && served !== key) return served;
				} catch {
					// A broken locale face must not blank the copy.
				}
			}
			return localTranslate(key, vars);
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

		/**
		 * Express a service's returned cleanup as the bare function Cordis
		 * accepts as an effect result.
		 *
		 * Cordis rejects anything that is neither a function, a thenable, nor an
		 * iterable (`TypeError: Invalid effect`), and Slot/menu services return
		 * their own Disposable objects. Returning one of those from an effect body
		 * would drop the whole registration, which is exactly how a glyph can go
		 * missing while the row still appears.
		 * @param produced - whatever the service returned.
		 * @returns a disposer, or undefined when the value carries no cleanup.
		 */
		function toCleanup(produced) {
			if (typeof produced === 'function') return produced;
			if (produced === null || produced === undefined) return undefined;
			if (typeof produced.dispose === 'function') return () => produced.dispose();
			if (typeof produced.abort === 'function') return () => produced.abort();
			if (typeof produced[Symbol.dispose] === 'function') return () => produced[Symbol.dispose]();
			return undefined;
		}

		/**
		 * Run one wiring body and hand its cleanup to the context.
		 *
		 * The body always runs exactly once, even on a Host whose `ctx.effect`
		 * refuses the service's own return shape: the registration must not
		 * depend on how a service spells "dispose me".
		 * @param ctx - client context.
		 * @param body - wiring to run; may return a disposer or a Disposable.
		 * @param label - effect label for the Host's diagnostics.
		 * @returns whatever `body` returned.
		 */
		function runEffect(ctx, body, label) {
			const produced = body();
			const cleanup = toCleanup(produced);
			if (cleanup === undefined || typeof ctx.effect !== 'function') return produced;
			try {
				ctx.effect(() => cleanup, label);
			} catch {
				// Cleanup bookkeeping is best effort; the registration already happened.
			}
			return produced;
		}

		/**
		 * Self-contained trash glyph.
		 *
		 * Used when the shared primitives module does not expose
		 * `IconTrashOutlineRegular`: an icon-less row next to the shipped rows is a
		 * visible regression, and a 16px inline SVG costs nothing.
		 */
		function TrashGlyph() {
			return React.createElement('svg', {
				viewBox: '0 0 20 20',
				width: 16,
				height: 16,
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.6,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': true,
			}, React.createElement('path', { d: 'M4.5 6.5h11' }), React.createElement('path', { d: 'M8 6.5V5.2h4v1.3' }), React.createElement('path', { d: 'M6.2 6.5l.6 8.3h6.4l.6-8.3' }), React.createElement('path', { d: 'M8.6 9.2v3.4M11.4 9.2v3.4' }));
		}

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

			// ── locale ───────────────────────────────────────────────────────
			// The dictionary registration and the bind are separate steps on
			// purpose: a Host that refuses the namespace still gets correct copy
			// from the bundled dictionaries, so neither failure blanks the row.
			const localeService = step('locale', () => (ctx.locale === undefined ? null : ctx.locale)) || null;
			localeFace = localeService;
			let dictionaries = 'absent';
			if (localeService !== null && typeof localeService.register === 'function') {
				let registered;
				step('locale-register', () => {
					runEffect(ctx, () => {
						registered = safe('locale-register', () => localeService.register(NS, MESSAGES));
						return registered;
					}, 'dsh-session-delete: dictionaries');
				});
				dictionaries = typeof registered === 'function' ? 'registered' : 'failed';
			}
			step('locale-bind', () => {
				if (localeService === null || typeof localeService.bind !== 'function') return;
				const bound = safe('locale-bind', () => localeService.bind(NS));
				if (typeof bound === 'function') serviceTranslate = bound;
			});

			// ── glyph ────────────────────────────────────────────────────────
			// The menu service renders whatever component this slot key resolves
			// to, exactly as the shipped actions do. The shared primitives icon is
			// preferred; a bundled SVG keeps the row from losing its glyph when
			// that module is not reachable from this bundle.
			let glyph = 'none';
			let iconReady = false;
			step('icon', () => {
				const slots = ctx.slots;
				if (slots === undefined || slots === null || typeof slots.inject !== 'function') return;
				let Icon = P.IconTrashOutlineRegular;
				glyph = Icon === undefined || Icon === null ? 'bundled-svg' : 'primitives';
				if (Icon === undefined || Icon === null) Icon = TrashGlyph;
				runEffect(ctx, () => safe('icon-register', () => slots.inject('contextMenu.icon', function* () {
					yield slots.register({ name: 'contextMenu.icon', key: ICON_KEY }, Icon);
				})), 'dsh-session-delete: menu icon');
				iconReady = true;
			});

			// ── menu row ─────────────────────────────────────────────────────
			let claimed = false;
			let legacy = false;
			const menus = step('menus', () => (ctx.contextMenus === undefined ? null : ctx.contextMenus)) || null;
			if (menus !== null && typeof menus.register === 'function') {
				step('menu-register', () => {
					runEffect(ctx, () => {
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
			}

			if (!claimed) {
				step('legacy-slot', () => {
					if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;
					runEffect(ctx, () => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
						name: 'sidebar.workspaces.session.menu.item',
						id: 'dsh-session-delete.delete',
						order: 500,
						locale: NS,
					}, LegacyMenuItem)), 'dsh-session-delete: legacy session menu item');
					legacy = true;
				});
			}

			// ── self-check ───────────────────────────────────────────────────
			// The browser has no log a person can read, so a broken wiring (raw
			// key, missing glyph, no menu row) is reported once where the Host's
			// owner can find it. A healthy activation writes nothing.
			step('self-check', () => {
				const copy = translate('menu.delete');
				if (copy !== 'menu.delete' && glyph !== 'none' && (claimed || legacy)) return;
				void call('report', {
					label: 'diagnose',
					detail: JSON.stringify({
						copy,
						glyph,
						icon: iconReady,
						menu: claimed,
						legacy: legacy === true,
						dictionaries,
						bound: serviceTranslate !== null,
					}),
				}).catch(() => {});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__testing = { MESSAGES, openDialog, closeDialog, call };
		return module.exports;
	},
});
