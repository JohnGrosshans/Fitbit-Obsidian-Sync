import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	requestUrl,
	normalizePath,
	MarkdownRenderer,
	Component,
} from "obsidian";

// ─── Constants ────────────────────────────────────────────────────────────────

const FITBIT_AUTH_URL = "https://www.fitbit.com/oauth2/authorize";
const FITBIT_TOKEN_URL = "https://api.fitbit.com/oauth2/token";
const FITBIT_API_BASE = "https://api.fitbit.com";
const CALLBACK_URI = "obsidian://fitbit-sync-callback";
const PLUGIN_PROTOCOL_ACTION = "fitbit-sync-callback";

// Scope required for all data we fetch
const FITBIT_SCOPE =
	"activity heartrate sleep profile";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FitbitTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // Unix ms timestamp
	userId: string;
}

interface FitbitSyncSettings {
	clientId: string;
	clientSecret: string;
	savePath: string;
	goalSteps: number;
	goalCardioMinutes: number;
	tokens: FitbitTokens | null;
	// PKCE state kept temporarily during the OAuth flow
	pkceVerifier: string;
	pkceState: string;
}

interface FitbitData {
	steps: number | null;
	sleepMinutes: number | null;
	sleepScore: number | null;
	sleepStageLight: number | null;
	sleepStageDeep: number | null;
	sleepStageRem: number | null;
	sleepStageAwake: number | null;
	restingHeartRate: number | null;
	sleepingHeartRate: number | null;
	hrv: number | null;
	readiness: number | null;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: FitbitSyncSettings = {
	clientId: "",
	clientSecret: "",
	savePath: "Fitbit",
	goalSteps: 10000,
	goalCardioMinutes: 150,
	tokens: null,
	pkceVerifier: "",
	pkceState: "",
};

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

function generateRandomString(length: number): string {
	const chars =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
	const array = new Uint8Array(length);
	crypto.getRandomValues(array);
	return Array.from(array, (b) => chars[b % chars.length]).join("");
}

async function sha256Base64url(plain: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(plain);
	const digest = await crypto.subtle.digest("SHA-256", data);
	// Base64url encode
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

// ─── Date helper ──────────────────────────────────────────────────────────────

function todayString(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class FitbitSyncPlugin extends Plugin {
	settings: FitbitSyncSettings;

	async onload() {
		await this.loadSettings();

		// Register the OAuth callback URI handler
		this.registerObsidianProtocolHandler(
			PLUGIN_PROTOCOL_ACTION,
			async (params) => {
				await this.handleOAuthCallback(params);
			}
		);

		// Register the main sync command
		this.addCommand({
			id: "sync-fitbit-today",
			name: "Sync Fitbit Data for Today",
			callback: async () => {
				await this.syncToday();
			},
		});

		// Add settings tab
		this.addSettingTab(new FitbitSyncSettingTab(this.app, this));
	}

	onunload() {
		// Obsidian automatically cleans up registered protocol handlers and commands
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ─── OAuth PKCE Flow ────────────────────────────────────────────────────────

	async startOAuthFlow() {
		if (!this.settings.clientId) {
			new Notice("Fitbit Sync: Please enter your Client ID first.");
			return;
		}

		const verifier = generateRandomString(64);
		const state = generateRandomString(16);
		const challenge = await sha256Base64url(verifier);

		// Persist so the callback can retrieve them
		this.settings.pkceVerifier = verifier;
		this.settings.pkceState = state;
		await this.saveSettings();

		const params = new URLSearchParams({
			response_type: "code",
			client_id: this.settings.clientId,
			redirect_uri: CALLBACK_URI,
			scope: FITBIT_SCOPE,
			state: state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		});

		const authUrl = `${FITBIT_AUTH_URL}?${params.toString()}`;
		window.open(authUrl);
		new Notice("Fitbit Sync: Browser opened. Authorize the app then return here.");
	}

	async handleOAuthCallback(params: Record<string, string>) {
		try {
			if (params["error"]) {
				new Notice(`Fitbit Sync: Authorization failed — ${params["error"]}`);
				return;
			}

			if (params["state"] !== this.settings.pkceState) {
				new Notice("Fitbit Sync: OAuth state mismatch. Please try connecting again.");
				return;
			}

			const code = params["code"];
			if (!code) {
				new Notice("Fitbit Sync: No authorization code received.");
				return;
			}

			await this.exchangeCodeForTokens(code);
		} catch (e) {
			console.error("Fitbit Sync: OAuth callback error", e);
			new Notice("Fitbit Sync: Failed to complete authorization. Check the console for details.");
		}
	}

	async exchangeCodeForTokens(code: string) {
		const body = new URLSearchParams({
			client_id: this.settings.clientId,
			grant_type: "authorization_code",
			redirect_uri: CALLBACK_URI,
			code: code,
			code_verifier: this.settings.pkceVerifier,
		});

		const credentials = btoa(
			`${this.settings.clientId}:${this.settings.clientSecret}`
		);

		const response = await requestUrl({
			url: FITBIT_TOKEN_URL,
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: `Basic ${credentials}`,
			},
			body: body.toString(),
		});

		if (response.status !== 200) {
			console.error("Fitbit Sync: Token exchange failed", response.text);
			new Notice("Fitbit Sync: Token exchange failed. Check your Client ID and Secret.");
			return;
		}

		const json = response.json;
		this.settings.tokens = {
			accessToken: json.access_token,
			refreshToken: json.refresh_token,
			expiresAt: Date.now() + json.expires_in * 1000,
			userId: json.user_id,
		};
		this.settings.pkceVerifier = "";
		this.settings.pkceState = "";
		await this.saveSettings();

		new Notice("Fitbit Sync: Successfully connected to Fitbit!");
	}

	async refreshTokenIfNeeded(): Promise<boolean> {
		if (!this.settings.tokens) return false;

		// Refresh 5 minutes before actual expiry
		const needsRefresh = Date.now() >= this.settings.tokens.expiresAt - 5 * 60 * 1000;
		if (!needsRefresh) return true;

		try {
			const body = new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: this.settings.tokens.refreshToken,
			});

			const credentials = btoa(
				`${this.settings.clientId}:${this.settings.clientSecret}`
			);

			const response = await requestUrl({
				url: FITBIT_TOKEN_URL,
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Authorization: `Basic ${credentials}`,
				},
				body: body.toString(),
			});

			if (response.status !== 200) {
				console.error("Fitbit Sync: Token refresh failed", response.text);
				new Notice("Fitbit Sync: Session expired. Please reconnect to Fitbit in settings.");
				this.settings.tokens = null;
				await this.saveSettings();
				return false;
			}

			const json = response.json;
			this.settings.tokens = {
				accessToken: json.access_token,
				refreshToken: json.refresh_token,
				expiresAt: Date.now() + json.expires_in * 1000,
				userId: this.settings.tokens.userId,
			};
			await this.saveSettings();
			return true;
		} catch (e) {
			console.error("Fitbit Sync: Token refresh error", e);
			new Notice("Fitbit Sync: Could not refresh token. Please reconnect in settings.");
			return false;
		}
	}

	// ─── API Calls ──────────────────────────────────────────────────────────────

	private async fitbitGet(endpoint: string): Promise<unknown> {
		if (!this.settings.tokens) throw new Error("Not authenticated");

		const response = await requestUrl({
			url: `${FITBIT_API_BASE}${endpoint}`,
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.settings.tokens.accessToken}`,
			},
		});

		if (response.status === 429) {
			throw new Error("Fitbit API rate limit reached. Try again later.");
		}
		if (response.status === 401) {
			throw new Error("Unauthorized — token may have expired.");
		}
		if (response.status === 403) {
			// Premium-only endpoint — return null so callers can handle gracefully
			return null;
		}
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Fitbit API error ${response.status} on ${endpoint}`);
		}

		return response.json;
	}

	async fetchFitbitData(date: string): Promise<FitbitData> {
		const data: FitbitData = {
			steps: null,
			sleepMinutes: null,
			sleepScore: null,
			sleepStageLight: null,
			sleepStageDeep: null,
			sleepStageRem: null,
			sleepStageAwake: null,
			restingHeartRate: null,
			sleepingHeartRate: null,
			hrv: null,
			readiness: null,
		};

		// Run all requests concurrently; individual failures don't abort others
		const [activityResult, sleepResult, heartRateResult, hrvResult, readinessResult] =
			await Promise.allSettled([
				this.fitbitGet(`/1/user/-/activities/date/${date}.json`),
				this.fitbitGet(`/1.2/user/-/sleep/date/${date}.json`),
				this.fitbitGet(`/1/user/-/activities/heart/date/${date}/1d.json`),
				this.fitbitGet(`/1/user/-/hrv/date/${date}.json`),
				this.fitbitGet(`/1/user/-/readiness/date/${date}.json`),
			]);

		// Activity — steps
		if (activityResult.status === "fulfilled" && activityResult.value !== null) {
			try {
				const a = activityResult.value as Record<string, unknown>;
				const summary = a["summary"] as Record<string, unknown>;
				data.steps = (summary?.["steps"] as number) ?? null;
			} catch {
				// ignore parse errors
			}
		} else if (activityResult.status === "rejected") {
			console.warn("Fitbit Sync: Activity fetch failed", activityResult.reason);
		}

		// Sleep
		if (sleepResult.status === "fulfilled" && sleepResult.value !== null) {
			try {
				const s = sleepResult.value as Record<string, unknown>;
				const summary = s["summary"] as Record<string, Record<string, number>>;

				// Total minutes asleep (main sleep log)
				const stages = summary?.["stages"];
				if (stages) {
					data.sleepStageLight = stages["light"] ?? null;
					data.sleepStageDeep = stages["deep"] ?? null;
					data.sleepStageRem = stages["rem"] ?? null;
					data.sleepStageAwake = stages["wake"] ?? null;
					data.sleepMinutes =
						(stages["light"] ?? 0) +
						(stages["deep"] ?? 0) +
						(stages["rem"] ?? 0);
				} else {
					data.sleepMinutes =
						(summary?.["totalMinutesAsleep"] as number) ?? null;
				}

				// Sleep score from the `sleep` array
				const sleepArr = s["sleep"] as Array<Record<string, unknown>>;
				if (Array.isArray(sleepArr) && sleepArr.length > 0) {
					const main = sleepArr.find((e) => e["isMainSleep"]) ?? sleepArr[0];
					const efficiency = main["efficiency"] as number | undefined;
					if (efficiency !== undefined) {
						// Fitbit doesn't always expose the "sleep score" via basic API;
						// use efficiency as a proxy when score is unavailable
						data.sleepScore = efficiency;
					}
				}
			} catch {
				// ignore parse errors
			}
		} else if (sleepResult.status === "rejected") {
			console.warn("Fitbit Sync: Sleep fetch failed", sleepResult.reason);
		}

		// Heart Rate — resting HR
		if (heartRateResult.status === "fulfilled" && heartRateResult.value !== null) {
			try {
				const h = heartRateResult.value as Record<string, unknown>;
				const hrData = h["activities-heart"] as Array<Record<string, unknown>>;
				if (Array.isArray(hrData) && hrData.length > 0) {
					const value = hrData[0]["value"] as Record<string, unknown>;
					data.restingHeartRate = (value?.["restingHeartRate"] as number) ?? null;
					// sleeping HR can be in custom heart-rate-zones or via separate endpoint
					// We'll derive sleeping HR from the lowest zone start if resting is available
					const zones = value?.["heartRateZones"] as Array<Record<string, unknown>> | undefined;
					if (Array.isArray(zones)) {
						const outOfRange = zones.find((z) => z["name"] === "Out of Range");
						if (outOfRange) {
							data.sleepingHeartRate = (outOfRange["min"] as number) ?? null;
						}
					}
				}
			} catch {
				// ignore parse errors
			}
		} else if (heartRateResult.status === "rejected") {
			console.warn("Fitbit Sync: Heart rate fetch failed", heartRateResult.reason);
		}

		// HRV
		if (hrvResult.status === "fulfilled" && hrvResult.value !== null) {
			try {
				const h = hrvResult.value as Record<string, unknown>;
				const hrvArr = h["hrv"] as Array<Record<string, unknown>>;
				if (Array.isArray(hrvArr) && hrvArr.length > 0) {
					const val = hrvArr[0]["value"] as Record<string, number>;
					data.hrv = val?.["dailyRmssd"] ?? val?.["deepRmssd"] ?? null;
				}
			} catch {
				// ignore parse errors
			}
		} else if (hrvResult.status === "rejected") {
			console.warn("Fitbit Sync: HRV fetch failed", hrvResult.reason);
		}

		// Readiness (Premium — null on 403)
		if (readinessResult.status === "fulfilled" && readinessResult.value !== null) {
			try {
				const r = readinessResult.value as Record<string, unknown>;
				const rdArr = r["readiness"] as Array<Record<string, unknown>>;
				if (Array.isArray(rdArr) && rdArr.length > 0) {
					data.readiness = (rdArr[0]["score"] as number) ?? null;
				}
			} catch {
				// ignore parse errors
			}
		}
		// 403 / rejected → data.readiness stays null, which is fine

		return data;
	}

	// ─── Sync Command ────────────────────────────────────────────────────────────

	async syncToday() {
		if (!this.settings.tokens) {
			new Notice("Fitbit Sync: Not connected. Please authorize in settings.");
			return;
		}

		const isValid = await this.refreshTokenIfNeeded();
		if (!isValid) return;

		const date = todayString();
		new Notice(`Fitbit Sync: Fetching data for ${date}…`);

		let fitbitData: FitbitData;
		try {
			fitbitData = await this.fetchFitbitData(date);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Fitbit Sync: ${msg}`);
			console.error("Fitbit Sync: fetch error", e);
			return;
		}

		try {
			await this.writeNote(date, fitbitData);
			new Notice(`Fitbit Sync: Note updated for ${date}.`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Fitbit Sync: Failed to write note — ${msg}`);
			console.error("Fitbit Sync: write error", e);
		}
	}

	// ─── Note Writing ────────────────────────────────────────────────────────────

	async writeNote(date: string, data: FitbitData) {
		const folderPath = normalizePath(this.settings.savePath);
		const filePath = normalizePath(`${folderPath}/${date}.md`);

		// Ensure folder exists
		if (!(await this.app.vault.adapter.exists(folderPath))) {
			await this.app.vault.createFolder(folderPath);
		}

		const fitbitFrontmatter: Record<string, unknown> = {
			fitbit_steps: data.steps,
			fitbit_sleep_minutes: data.sleepMinutes,
			fitbit_sleep_score: data.sleepScore,
			fitbit_sleep_stage_light: data.sleepStageLight,
			fitbit_sleep_stage_deep: data.sleepStageDeep,
			fitbit_sleep_stage_rem: data.sleepStageRem,
			fitbit_sleep_stage_awake: data.sleepStageAwake,
			fitbit_resting_heart_rate: data.restingHeartRate,
			fitbit_sleeping_heart_rate: data.sleepingHeartRate,
			fitbit_hrv: data.hrv,
			fitbit_readiness: data.readiness,
			goal_steps: this.settings.goalSteps,
			goal_cardio_minutes: this.settings.goalCardioMinutes,
		};

		const existingFile = this.app.vault.getAbstractFileByPath(filePath);

		if (existingFile instanceof TFile) {
			// File exists — merge frontmatter, preserve everything else
			const rawContent = await this.app.vault.read(existingFile);
			const merged = mergeFrontmatter(rawContent, fitbitFrontmatter);
			await this.app.vault.modify(existingFile, merged);
		} else {
			// New file
			const content = buildNoteContent(date, fitbitFrontmatter);
			await this.app.vault.create(filePath, content);
		}
	}
}

// ─── Frontmatter Utilities ───────────────────────────────────────────────────

/**
 * Parses a YAML frontmatter block from raw note content.
 * Returns { frontmatterRaw, body } where body is everything after the closing ---.
 */
function splitFrontmatter(raw: string): {
	frontmatterRaw: string | null;
	body: string;
} {
	const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
	const match = raw.match(FM_RE);
	if (!match) return { frontmatterRaw: null, body: raw };
	return {
		frontmatterRaw: match[1],
		body: raw.slice(match[0].length),
	};
}

/**
 * Very lightweight YAML serializer for flat key/value pairs.
 * Sufficient for the simple scalar types we write.
 */
function serializeYamlValue(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	// String — quote if it contains special YAML characters
	const str = String(value);
	if (/[:#\[\]{},&*?|<>=!%@`'"\\]/.test(str) || str.trim() !== str) {
		return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return str;
}

/**
 * Parse a simple flat YAML block into a plain object.
 * Only handles key: value lines (no nesting/arrays/multiline).
 */
function parseSimpleYaml(yaml: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of yaml.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const val = line.slice(colonIdx + 1).trim();
		if (key) result[key] = val;
	}
	return result;
}

/**
 * Serialize a merged key/value record back to YAML lines,
 * preserving original lines for non-Fitbit keys and injecting/updating
 * Fitbit keys in-place (or appending new ones at the end).
 */
function mergeFrontmatter(
	rawContent: string,
	newPairs: Record<string, unknown>
): string {
	const { frontmatterRaw, body } = splitFrontmatter(rawContent);

	const newPairKeys = new Set(Object.keys(newPairs));

	if (!frontmatterRaw) {
		// No existing frontmatter — prepend
		const fm = buildFrontmatterBlock(newPairs);
		return fm + rawContent;
	}

	// Rebuild YAML lines, replacing matching keys in-place
	const existingLines = frontmatterRaw.split("\n");
	const updatedLines: string[] = [];
	const writtenKeys = new Set<string>();

	for (const line of existingLines) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) {
			updatedLines.push(line);
			continue;
		}
		const key = line.slice(0, colonIdx).trim();
		if (newPairKeys.has(key)) {
			// Replace with new value
			updatedLines.push(
				`${key}: ${serializeYamlValue(newPairs[key])}`
			);
			writtenKeys.add(key);
		} else {
			updatedLines.push(line);
		}
	}

	// Append keys not yet written
	for (const [k, v] of Object.entries(newPairs)) {
		if (!writtenKeys.has(k)) {
			updatedLines.push(`${k}: ${serializeYamlValue(v)}`);
		}
	}

	return `---\n${updatedLines.join("\n")}\n---\n${body}`;
}

function buildFrontmatterBlock(pairs: Record<string, unknown>): string {
	const lines = Object.entries(pairs)
		.map(([k, v]) => `${k}: ${serializeYamlValue(v)}`)
		.join("\n");
	return `---\n${lines}\n---\n`;
}

function buildNoteContent(date: string, pairs: Record<string, unknown>): string {
	return `${buildFrontmatterBlock(pairs)}\n# ${date}\n`;
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

const INSTRUCTIONS_MARKDOWN = `
## Setup Instructions

### 1 — Create a Fitbit App

1. Go to [dev.fitbit.com/apps/new](https://dev.fitbit.com/apps/new) and sign in.
2. Fill in the form:
   - **Application Name**: anything you like (e.g. *My Obsidian Sync*)
   - **Description**: brief description
   - **Application Website URL**: \`https://localhost\`
   - **Organization**: your name
   - **OAuth 2.0 Application Type**: **Personal**
   - **Callback URL**: \`obsidian://fitbit-sync-callback\`
   - **Default Access Type**: Read Only
3. Submit. You will be shown a **Client ID** and **Client Secret** — copy both.

### 2 — Configure the Plugin

1. Paste your **Client ID** and **Client Secret** into the fields below.
2. Set the **Save Path** to the folder where your daily notes should be created.
3. Set your personal **step goal** and **weekly cardio goal**.
4. Click **Connect to Fitbit** — a browser window will open for you to authorize.
5. After approving, Obsidian will capture the callback automatically.

### 3 — Sync

Run the command **Fitbit Sync: Sync Fitbit Data for Today** from the command palette (⌘P / Ctrl+P).

A note named \`YYYY-MM-DD.md\` will be created (or updated) in your save path with all Fitbit data as YAML frontmatter.

### Available Frontmatter Keys

| Key | Description |
|-----|-------------|
| \`fitbit_steps\` | Total steps for the day |
| \`fitbit_sleep_minutes\` | Total sleep in minutes |
| \`fitbit_sleep_score\` | Sleep efficiency / score |
| \`fitbit_sleep_stage_light\` | Light sleep (min) |
| \`fitbit_sleep_stage_deep\` | Deep sleep (min) |
| \`fitbit_sleep_stage_rem\` | REM sleep (min) |
| \`fitbit_sleep_stage_awake\` | Awake time (min) |
| \`fitbit_resting_heart_rate\` | Resting heart rate |
| \`fitbit_sleeping_heart_rate\` | Sleeping heart rate (low zone) |
| \`fitbit_hrv\` | Heart rate variability (RMSSD) |
| \`fitbit_readiness\` | Daily Readiness Score (Premium) |
| \`goal_steps\` | Your configured step goal |
| \`goal_cardio_minutes\` | Your configured cardio goal |
`;

class FitbitSyncSettingTab extends PluginSettingTab {
	plugin: FitbitSyncPlugin;
	private instructionsComponent: Component;

	constructor(app: App, plugin: FitbitSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.instructionsComponent = new Component();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.instructionsComponent.unload();
		this.instructionsComponent = new Component();
		this.instructionsComponent.load();

		containerEl.createEl("h2", { text: "Fitbit Obsidian Sync" });

		// ── Instructions ──
		const instructionsEl = containerEl.createDiv({
			cls: "fitbit-sync-instructions",
		});
		MarkdownRenderer.render(
			this.app,
			INSTRUCTIONS_MARKDOWN,
			instructionsEl,
			"",
			this.instructionsComponent
		);

		containerEl.createEl("hr");
		containerEl.createEl("h3", { text: "Configuration" });

		// ── Client ID ──
		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("Your Fitbit app's Client ID from dev.fitbit.com.")
			.addText((text) =>
				text
					.setPlaceholder("Enter Client ID")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		// ── Client Secret ──
		new Setting(containerEl)
			.setName("Client Secret")
			.setDesc("Your Fitbit app's Client Secret. Stored locally in data.json.")
			.addText((text) => {
				text
					.setPlaceholder("Enter Client Secret")
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		// ── Connect button ──
		const connectSetting = new Setting(containerEl)
			.setName("Fitbit Authorization")
			.setDesc(
				this.plugin.settings.tokens
					? "Connected. Click to re-authorize."
					: "Not connected. Click to authorize with Fitbit."
			);

		if (this.plugin.settings.tokens) {
			connectSetting.addButton((btn) =>
				btn
					.setButtonText("Disconnect")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.tokens = null;
						await this.plugin.saveSettings();
						new Notice("Fitbit Sync: Disconnected.");
						this.display();
					})
			);
		}

		connectSetting.addButton((btn) =>
			btn
				.setButtonText(
					this.plugin.settings.tokens ? "Re-connect to Fitbit" : "Connect to Fitbit"
				)
				.setCta()
				.onClick(async () => {
					await this.plugin.startOAuthFlow();
				})
		);

		containerEl.createEl("hr");
		containerEl.createEl("h3", { text: "Save Location" });

		// ── Save Path ──
		new Setting(containerEl)
			.setName("Save Path")
			.setDesc("Vault folder where daily Fitbit notes will be created.")
			.addText((text) =>
				text
					.setPlaceholder("Fitbit")
					.setValue(this.plugin.settings.savePath)
					.onChange(async (value) => {
						this.plugin.settings.savePath = value.trim() || "Fitbit";
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("hr");
		containerEl.createEl("h3", { text: "Personal Goals" });

		// ── Step Goal ──
		new Setting(containerEl)
			.setName("Daily Step Goal")
			.setDesc("Written to every note as goal_steps.")
			.addText((text) =>
				text
					.setPlaceholder("10000")
					.setValue(String(this.plugin.settings.goalSteps))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.goalSteps = n;
							await this.plugin.saveSettings();
						}
					})
			);

		// ── Cardio Goal ──
		new Setting(containerEl)
			.setName("Weekly Cardio Goal (minutes)")
			.setDesc("Written to every note as goal_cardio_minutes.")
			.addText((text) =>
				text
					.setPlaceholder("150")
					.setValue(String(this.plugin.settings.goalCardioMinutes))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.goalCardioMinutes = n;
							await this.plugin.saveSettings();
						}
					})
			);
	}

	hide(): void {
		this.instructionsComponent.unload();
	}
}
