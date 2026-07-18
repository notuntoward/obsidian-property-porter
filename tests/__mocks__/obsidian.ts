// Minimal mock of the type-only `obsidian` package so that unit tests can
// resolve `import { ... } from "obsidian"` without the real Obsidian runtime.
// Extend these stubs as your tests need them.

export class Plugin {
	app: any;
	manifest: any;

	constructor(app: any, manifest: any) {
		this.app = app;
		this.manifest = manifest;
	}

	async onload(): Promise<void> {}
	onunload(): void {}
	addCommand(_command: any): any {}
	addSettingTab(_tab: any): void {}
	addStatusBarItem(): HTMLElement {
		const el =
			typeof document !== "undefined"
				? document.createElement("div")
				: ({} as HTMLElement);
		(el as any).setText = (text: string) => {
			(el as HTMLElement).textContent = text;
		};
		return el as HTMLElement;
	}
	registerEvent(_event: any): void {}
	registerDomEvent(_el: any, _type: string, _callback: any): void {}
	registerInterval(_id: number): number {
		return _id;
	}

	async loadData(): Promise<any> {
		return {};
	}

	async saveData(_data: any): Promise<void> {}
}

export class PluginSettingTab {
	app: any;
	plugin: any;
	containerEl: any;

	constructor(app: any, plugin: any) {
		this.app = app;
		this.plugin = plugin;
	}

	display(): void {}
	hide(): void {}
}

export class Setting {
	static instances: Setting[] = [];

	containerEl: any;
	settingEl: any;
	name = "";
	components: {
		text?: any;
		dropdown?: any;
		toggle?: any;
		button?: any;
	} = {};

	constructor(containerEl: any) {
		this.containerEl = containerEl;
		this.settingEl =
			typeof document !== "undefined" ? document.createElement("div") : {};
		Setting.instances.push(this);
	}

	static clearInstances(): void {
		Setting.instances = [];
	}

	setName(name: string): this {
		this.name = name;
		return this;
	}
	setDesc(_desc: string): this {
		return this;
	}
	addText(cb: (text: any) => any): this {
		const text = {
			value: "",
			placeholder: "",
			disabled: false,
			setValue(value: string) {
				this.value = value;
				return this;
			},
			setPlaceholder(placeholder: string) {
				this.placeholder = placeholder;
				return this;
			},
			setDisabled(disabled: boolean) {
				this.disabled = disabled;
				return this;
			},
			onChange(fn: (value: string) => void) {
				this.onChangeFn = fn;
				return this;
			},
		};
		this.components.text = text;
		cb(text);
		return this;
	}
	addDropdown(cb: (dropdown: any) => any): this {
		const dropdown = {
			value: "",
			options: {} as Record<string, string>,
			addOption(value: string, display: string) {
				this.options[value] = display;
				return this;
			},
			setValue(value: string) {
				this.value = value;
				return this;
			},
			onChange(fn: (value: string) => void) {
				this.onChangeFn = fn;
				return this;
			},
		};
		this.components.dropdown = dropdown;
		cb(dropdown);
		return this;
	}
	addToggle(cb: (toggle: any) => any): this {
		const toggle = {
			value: false,
			setValue(value: boolean) {
				this.value = value;
				return this;
			},
			onChange(fn: (value: boolean) => void) {
				this.onChangeFn = fn;
				return this;
			},
		};
		this.components.toggle = toggle;
		cb(toggle);
		return this;
	}
	addButton(cb: (button: any) => any): this {
		const button = {
			setCta() {
				return this;
			},
			onClick(fn: () => void) {
				this.onClickFn = fn;
				return this;
			},
		};
		this.components.button = button;
		cb(button);
		return this;
	}
}

export class Notice {
	constructor(_message: string, _timeout?: number) {}
	setMessage(_message: string): this {
		return this;
	}
	hide(): void {}
}

// Decorates a real jsdom element with the subset of Obsidian's HTMLElement
// helper methods that plugin code relies on (empty, setText, addClass,
// createDiv/createEl/createSpan). This mirrors Obsidian's runtime prototype
// extensions closely enough for unit tests to exercise real DOM behavior
// (event bubbling, querySelector, classList) instead of hand-rolled stubs.
export function decorateEl<T extends HTMLElement>(el: T): T {
	const anyEl = el as any;
	if (anyEl.__ppDecorated) return el;
	anyEl.__ppDecorated = true;
	anyEl.empty = function (): void {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	anyEl.setText = function (text: string): void {
		this.textContent = text;
	};
	anyEl.addClass = function (cls: string): void {
		this.classList.add(cls);
	};
	anyEl.removeClass = function (cls: string): void {
		this.classList.remove(cls);
	};
	anyEl.createDiv = function (options: any = {}): HTMLElement {
		return createChild(this, "div", options);
	};
	anyEl.createSpan = function (options: any = {}): HTMLElement {
		return createChild(this, "span", options);
	};
	anyEl.createEl = function (tag: string, options: any = {}): HTMLElement {
		return createChild(this, tag, options);
	};
	return el;
}

function createChild(parent: any, tag: string, options: any = {}): any {
	const child = document.createElement(tag);
	if (options.cls) {
		child.className = Array.isArray(options.cls)
			? options.cls.join(" ")
			: options.cls;
	}
	if (options.text !== undefined) child.textContent = options.text;
	if (options.type) (child as any).type = options.type;
	if (options.attr) {
		for (const [key, value] of Object.entries(options.attr)) {
			child.setAttribute(key, String(value));
		}
	}
	parent.appendChild(child);
	return decorateEl(child);
}

export class Modal {
	app: any;
	contentEl: any;
	containerEl: any;
	modalEl: any;
	titleEl: any;

	constructor(app: any) {
		this.app = app;
		this.contentEl = decorateEl(document.createElement("div"));
		this.modalEl = decorateEl(document.createElement("div"));
		this.containerEl = decorateEl(document.createElement("div"));
		this.titleEl = decorateEl(document.createElement("div"));
	}

	open(): void {
		this.onOpen();
	}
	close(): void {
		this.onClose();
	}
	onOpen(): void {}
	onClose(): void {}
}

export class SuggestModal<T> extends Modal {
	constructor(app: any) {
		super(app);
	}

	setPlaceholder(_placeholder: string): void {}
	setInstructions(_instructions: any[]): void {}

	getSuggestions(_query: string): T[] {
		return [];
	}
	renderSuggestion(_value: T, _el: HTMLElement): void {}
	onChooseSuggestion(_item: T, _evt?: MouseEvent | KeyboardEvent): void {}
	selectSuggestion(_value: T, _evt?: MouseEvent | KeyboardEvent): void {}
	selectActiveSuggestion(_evt?: MouseEvent | KeyboardEvent): void {}
}

export class Component {
	load(): void {}
	onload(): void {}
	unload(): void {}
	onunload(): void {}
}

export class TFile {
	path: string;
	name: string;
	basename: string;
	extension: string;

	constructor(path: string) {
		this.path = path;
		this.name = path.split("/").pop() ?? path;
		const dot = this.name.lastIndexOf(".");
		this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
		this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
	}
}

export class App {
	vault: any;
	workspace: any;
	metadataCache: any;
	fileManager: any;

	constructor(options: any = {}) {
		this.vault = options.vault ?? {};
		this.workspace = options.workspace ?? {};
		this.metadataCache = options.metadataCache ?? {};
		this.fileManager = options.fileManager ?? {};
	}
}

// Mirrors the real obsidian.getAllTags(cache): collects inline body tags
// (cache.tags, an array of { tag: string } with the `#` prefix already
// applied) plus frontmatter tags under either the `tags` or singular `tag`
// key, supporting both array and comma-separated string forms. Returns null
// when nothing is found, matching the real function's signature.
export function getAllTags(cache: any): string[] | null {
	const tags = new Set<string>();

	if (Array.isArray(cache?.tags)) {
		for (const entry of cache.tags) {
			if (entry?.tag) tags.add(entry.tag);
		}
	}

	const fm = cache?.frontmatter;
	if (fm) {
		const fmTags = fm.tags ?? fm.tag;
		if (Array.isArray(fmTags)) {
			for (const t of fmTags) {
				if (typeof t === "string" && t.length > 0) {
					tags.add(t.startsWith("#") ? t : `#${t}`);
				}
			}
		} else if (typeof fmTags === "string" && fmTags.length > 0) {
			for (const part of fmTags.split(",")) {
				const trimmed = part.trim();
				if (trimmed.length > 0) {
					tags.add(trimmed.startsWith("#") ? trimmed : `#${trimmed}`);
				}
			}
		}
	}

	return tags.size > 0 ? Array.from(tags) : null;
}
