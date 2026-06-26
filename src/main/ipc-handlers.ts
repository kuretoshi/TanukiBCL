import { app, dialog, ipcMain, shell } from 'electron';
import { platform, homedir } from 'os';
import { enumerateValues, enumerateKeys, HKEY } from 'registry-js';
import {
	DefaultGamePlatforms,
	GamePlatform,
	GamePlatformInstance,
	GamePlatformMap,
	PlatformRunType,
} from '../common/GamePlatform';
import { parse } from 'vdf-parser';
import spawn from 'cross-spawn';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';

import { InquiryPayload, IpcHandlerMessages, IpcMessages, IpcOverlayMessages } from '../common/ipc-messages';
import { INQUIRY_DISCORD_FORUM_TAG_IDS, INQUIRY_DISCORD_FORUM_WEBHOOK_URL } from './inquiryConfig';
import { getLogFilePaths } from './logger';

const DISCORD_FORUM_WEBHOOK_URL =
	process.env.BETTERCREWLINK_DISCORD_FORUM_WEBHOOK_URL || INQUIRY_DISCORD_FORUM_WEBHOOK_URL;
const DISCORD_ATTACHMENT_LIMIT_BYTES = 24 * 1024 * 1024;
const DISCORD_BODY_LIMIT = 1800;
const INQUIRY_LOG_TAIL_BYTES = 1024 * 1024;
const TEXT = {
	attachmentTooLarge:
		'\u6dfb\u4ed8\u30d5\u30a1\u30a4\u30eb\u306e\u5408\u8a08\u30b5\u30a4\u30ba\u306f24MB\u4ee5\u4e0b\u306b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
	discordPostFailed: 'Discord\u3078\u306e\u6295\u7a3f\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002',
	invalidAttachment: '\u6dfb\u4ed8\u3067\u304d\u306a\u3044\u30d5\u30a1\u30a4\u30eb\u3067\u3059',
	missingFields: '\u4ef6\u540d\u3068\u672c\u6587\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
	missingTag:
		'\u9078\u629e\u3055\u308c\u305f\u30d5\u30a9\u30fc\u30e9\u30e0\u30bf\u30b0ID\u304c\u8a2d\u5b9a\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002',
	missingWebhook:
		'Discord\u30d5\u30a9\u30fc\u30e9\u30e0Webhook URL\u304c\u8a2d\u5b9a\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002',
};

function appendWebhookWait(url: string): string {
	const webhookUrl = new URL(url);
	webhookUrl.searchParams.set('wait', 'true');
	return webhookUrl.toString();
}

function sanitizeDiscordText(value: string, maxLength: number): string {
	return value.trim().replace(/\r\n/g, '\n').slice(0, maxLength);
}

function sanitizeFilename(value: string): string {
	return value.replace(/[\r\n"]/g, '_');
}

function getInquiryLogAttachments(): string[] {
	const attachments: string[] = [];
	for (const logPath of getLogFilePaths()) {
		try {
			if (!fs.existsSync(logPath)) {
				continue;
			}

			const stat = fs.statSync(logPath);
			if (!stat.isFile() || stat.size === 0) {
				continue;
			}

			if (stat.size <= INQUIRY_LOG_TAIL_BYTES) {
				attachments.push(logPath);
				continue;
			}

			const fd = fs.openSync(logPath, 'r');
			try {
				const buffer = Buffer.alloc(INQUIRY_LOG_TAIL_BYTES);
				fs.readSync(fd, buffer, 0, INQUIRY_LOG_TAIL_BYTES, stat.size - INQUIRY_LOG_TAIL_BYTES);
				const tailPath = path.join(
					app.getPath('temp'),
					`bettercrewlink-inquiry-${Date.now()}-${path.basename(logPath)}`
				);
				fs.writeFileSync(tailPath, buffer);
				attachments.push(tailPath);
			} finally {
				fs.closeSync(fd);
			}
		} catch (error) {
			console.error('Could not attach inquiry log:', error);
		}
	}

	return attachments;
}

function buildMultipartBody(payload: Record<string, unknown>, files: string[]) {
	const boundary = `----BetterCrewLinkInquiry${Date.now().toString(16)}`;
	const chunks: Buffer[] = [];

	const pushText = (value: string) => chunks.push(Buffer.from(value, 'utf8'));
	pushText(`--${boundary}\r\n`);
	pushText('Content-Disposition: form-data; name="payload_json"\r\n');
	pushText('Content-Type: application/json\r\n\r\n');
	pushText(`${JSON.stringify(payload)}\r\n`);

	files.forEach((filePath, index) => {
		const filename = sanitizeFilename(path.basename(filePath));
		pushText(`--${boundary}\r\n`);
		pushText(`Content-Disposition: form-data; name="files[${index}]"; filename="${filename}"\r\n`);
		pushText('Content-Type: application/octet-stream\r\n\r\n');
		chunks.push(fs.readFileSync(filePath));
		pushText('\r\n');
	});

	pushText(`--${boundary}--\r\n`);
	return {
		body: Buffer.concat(chunks),
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

async function submitDiscordInquiry(inquiry: InquiryPayload) {
	if (!DISCORD_FORUM_WEBHOOK_URL) {
		throw new Error(TEXT.missingWebhook);
	}

	const subject = sanitizeDiscordText(inquiry.subject, 100);
	const body = sanitizeDiscordText(inquiry.body, DISCORD_BODY_LIMIT);
	if (!subject || !body) {
		throw new Error(TEXT.missingFields);
	}

	const attachmentPaths = [...inquiry.attachmentPaths, ...getInquiryLogAttachments()];
	let totalAttachmentSize = 0;
	for (const filePath of attachmentPaths) {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) {
			throw new Error(`${TEXT.invalidAttachment}: ${path.basename(filePath)}`);
		}
		totalAttachmentSize += stat.size;
	}

	if (totalAttachmentSize > DISCORD_ATTACHMENT_LIMIT_BYTES) {
		throw new Error(TEXT.attachmentTooLarge);
	}

	const tagId = INQUIRY_DISCORD_FORUM_TAG_IDS[inquiry.tag];
	if (!tagId) {
		throw new Error(TEXT.missingTag);
	}

	const payload = {
		thread_name: subject,
		content: body,
		applied_tags: [tagId],
		allowed_mentions: { parse: [] },
	};

	const webhookUrl = appendWebhookWait(DISCORD_FORUM_WEBHOOK_URL);
	const response =
		attachmentPaths.length > 0
			? await (async () => {
					const multipart = buildMultipartBody(payload, attachmentPaths);
					return fetch(webhookUrl, {
						method: 'POST',
						headers: { 'Content-Type': multipart.contentType },
						body: multipart.body,
					});
			  })()
			: await fetch(webhookUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
			  });

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${TEXT.discordPostFailed}HTTP ${response.status}: ${text}`);
	}
}

// Listeners are fire and forget, they do not have "responses" or return values
export const initializeIpcListeners = (): void => {
	ipcMain.on(IpcMessages.SHOW_ERROR_DIALOG, (e, opts: { title: string; content: string }) => {
		if (typeof opts === 'object' && opts && typeof opts.title === 'string' && typeof opts.content === 'string') {
			dialog.showErrorBox(opts.title, opts.content);
		}
	});

	ipcMain.on(IpcMessages.OPEN_AMONG_US_GAME, (_, platform: GamePlatformInstance) => {
		const error = () => dialog.showErrorBox('Error', 'Could not start the game.');

		if (platform.launchType === PlatformRunType.URI) {
			// Just open the URI if we can to launch the game
			// TODO: Try to add error checking here
			shell.openExternal(platform.runPath);
		} else if (platform.launchType === PlatformRunType.EXE) {
			try {
				const process = spawn(path.join(platform.runPath, platform.execute[0]), platform.execute.slice(1), {
					detached: true,
					stdio: 'ignore',
				});
				process.on('error', error);
				process.unref();
			} catch (e) {
				error();
			}
		}
	});

	ipcMain.on(IpcMessages.RESTART_CREWLINK, () => {
		app.relaunch();
		app.quit();
	});

	ipcMain.on(IpcMessages.SEND_TO_OVERLAY, (_, event: IpcOverlayMessages, ...args: unknown[]) => {
		try {
			if (global.overlay) global.overlay.webContents.send(event, ...args);
		} catch (e) {
			/*empty*/
		}
	});

	ipcMain.on(IpcMessages.SEND_TO_MAINWINDOW, (_, event: IpcOverlayMessages, ...args: unknown[]) => {
		console.log('SEND TO MAINWINDOW CALLLED');
		try {
			if (global.mainWindow) global.mainWindow.webContents.send(event, ...args);
		} catch (e) {
			/*empty*/
		}
	});

	ipcMain.on(IpcMessages.QUIT_CREWLINK, () => {
		try {
			const mainWindow = global.mainWindow;
			const overlay = global.overlay;
			global.mainWindow = null;
			global.overlay = null;
			mainWindow?.close();
			overlay?.close();
			mainWindow?.destroy();
			overlay?.destroy();
		} catch {
			/* empty */
		}
		app.quit();
	});
};

// Handlers are async cross-process instructions, they should have a return value
// or the caller should be "await"'ing them.  If neither of these are the case
// consider making it a "listener" instead for performance and readability
export const initializeIpcHandlers = (): void => {
	ipcMain.handle(IpcHandlerMessages.SELECT_INQUIRY_ATTACHMENTS, async () => {
		const result = global.mainWindow
			? await dialog.showOpenDialog(global.mainWindow, {
					properties: ['openFile', 'multiSelections'],
			  })
			: await dialog.showOpenDialog({
					properties: ['openFile', 'multiSelections'],
			  });
		if (result.canceled) {
			return [];
		}

		return result.filePaths.map((filePath) => {
			const stat = fs.statSync(filePath);
			return {
				path: filePath,
				name: path.basename(filePath),
				size: stat.size,
			};
		});
	});

	ipcMain.handle(IpcHandlerMessages.SUBMIT_INQUIRY, async (_, inquiry: InquiryPayload) => {
		await submitDiscordInquiry(inquiry);
	});

	ipcMain.handle(IpcMessages.REQUEST_PLATFORMS_AVAILABLE, (_, customPlatforms: GamePlatformMap) => {
		const desktop_platform = platform();

		// Assume all game platforms are unavailable unless proven otherwise
		const availableGamePlatforms: GamePlatformMap = {};

		// Deal with default platforms first
		if (desktop_platform === 'win32') {
			// Steam
			if (
				enumerateValues(HKEY.HKEY_CLASSES_ROOT, 'steam').find((value) =>
					value ? value.name === 'URL Protocol' : false
				)
			) {
				availableGamePlatforms[GamePlatform.STEAM] = DefaultGamePlatforms[GamePlatform.STEAM];
			}

			// Epic Games
			if (
				enumerateValues(HKEY.HKEY_CLASSES_ROOT, 'com.epicgames.launcher').find((value) =>
					value ? value.name === 'URL Protocol' : false
				)
			) {
				availableGamePlatforms[GamePlatform.EPIC] = DefaultGamePlatforms[GamePlatform.EPIC];
			}

			// Microsoft Store
			// Search for 'Innersloth.Among Us....' key and grab it
			const microsoft_regkey = enumerateKeys(
				HKEY.HKEY_CURRENT_USER,
				'SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages'
			).find((reg_key) => reg_key.startsWith('Innersloth.AmongUs' as string));

			if (microsoft_regkey) {
				// Grab the game path from the above key
				const value_found = enumerateValues(
					HKEY.HKEY_CURRENT_USER,
					'SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages' +
						'\\' +
						microsoft_regkey
				).find((value) => (value ? value.name === 'PackageRootFolder' : false));
				if (value_found) {
					availableGamePlatforms[GamePlatform.MICROSOFT] = DefaultGamePlatforms[GamePlatform.MICROSOFT];
					availableGamePlatforms[GamePlatform.MICROSOFT].runPath = value_found.data as string;
				}
			}
		} else if (desktop_platform === 'linux') {
			// Add platform to availableGamePlatforms and setup data if platform is available, do nothing otherwise
			try {
				const vdfString = fs.readFileSync(homedir() + '/.steam/registry.vdf').toString();
				const vdfObject = parse(vdfString) as {
					Registry: { HKCU: { Software: { Valve: { Steam: { Apps: { 945360: { installed: number } } } } } } };
				};
				//checks if Among Us's listed as installed in the .vdf-file
				if (vdfObject['Registry']['HKCU']['Software']['Valve']['Steam']['Apps']['945360']['installed'] == 1) {
					availableGamePlatforms[GamePlatform.STEAM] = DefaultGamePlatforms[GamePlatform.STEAM];
				}
			} catch (e) {
				/* empty */
			}
		}

		// Deal with custom client-added platforms
		for (const key in customPlatforms) {
			const game_platform = customPlatforms[key];

			if (game_platform.launchType === PlatformRunType.URI) {
				// I really have no clue how to check this, so we're trusting they exist
				availableGamePlatforms[key] = game_platform;
			} else if (game_platform.launchType === PlatformRunType.EXE) {
				try {
					fs.accessSync(path.join(game_platform.runPath, game_platform.execute[0]), fs.constants.X_OK);
					availableGamePlatforms[key] = game_platform;
				} catch {
					continue;
				}
			}
		}

		return availableGamePlatforms;
	});
};
