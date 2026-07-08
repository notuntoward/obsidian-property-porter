import { Plugin } from "obsidian";

export default class ObsidianPluginTemplate extends Plugin {
	async onload(): Promise<void> {
		// Add your plugin's commands, settings, and event handlers here.
	}

	onunload(): void {
		// Clean up any resources (intervals, event listeners, DOM) here.
	}
}
