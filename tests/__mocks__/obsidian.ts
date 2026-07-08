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
	registerEvent(_event: any): void {}
	registerDomEvent(_el: any, _type: string, _callback: any): void {}
	registerInterval(_id: number): number {
		return _id;
	}
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
	containerEl: any;
	settingEl: any;

	constructor(_containerEl: any) {
		this.containerEl = _containerEl;
	}

	setName(_name: string): this {
		return this;
	}
	setDesc(_desc: string): this {
		return this;
	}
	addText(_cb: (text: any) => any): this {
		return this;
	}
	addToggle(_cb: (toggle: any) => any): this {
		return this;
	}
	addButton(_cb: (button: any) => any): this {
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

export class Component {
	load(): void {}
	onload(): void {}
	unload(): void {}
	onunload(): void {}
}
