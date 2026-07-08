import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/playwright",
	timeout: 30_000,
	fullyParallel: true,
	use: {
		baseURL: "http://127.0.0.1:4173",
		headless: true,
	},
	webServer: {
		command: "npx vite --host 127.0.0.1 --port 4173",
		port: 4173,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
