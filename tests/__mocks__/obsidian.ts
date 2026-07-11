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

export class Modal {
	app: any;
	contentEl: any;

	constructor(app: any) {
		this.app = app;
	}

	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
}

export class SuggestModal<T> extends Modal {
	constructor(app: any) {
		super(app);
	}

	getSuggestions(_query: string): T[] {
		return [];
	}
	renderSuggestion(_value: T, _el: HTMLElement): void {}
	onChooseSuggestion(_item: T, _evt?: MouseEvent | KeyboardEvent): void {}
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
