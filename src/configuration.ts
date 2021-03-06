import * as os from 'os';
import * as path from 'path';
import * as uuid from 'uuid';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Log, LogConfiguration } from './util/log';
import { isWindowsPlatform, findAddonId } from './util/misc';
import { isExecutable } from './util/fs';
import { Minimatch } from 'minimatch';
import * as FirefoxProfile from 'firefox-profile';

let log = Log.create('ParseConfiguration');

export type AddonType = 'legacy' | 'addonSdk' | 'webExtension';

export interface CommonConfiguration {
	request: 'launch' | 'attach';
	url?: string;
	webRoot?: string;
	reloadOnAttach?: boolean;
	reloadOnChange?: ReloadConfiguration;
	pathMappings?: { url: string, path: string }[];
	skipFiles?: string[];
	showConsoleCallLocation?: boolean;
	log?: LogConfiguration;
	addonType?: AddonType;
	addonPath?: string;
	sourceMaps?: 'client' | 'server';
}

export interface LaunchConfiguration extends CommonConfiguration, DebugProtocol.LaunchRequestArguments {
	request: 'launch';
	file?: string;
	firefoxExecutable?: string;
	profileDir?: string;
	profile?: string;
	keepProfileChanges?: boolean;
	preferences?: { [key: string]: boolean | number | string | null };
	port?: number;
	firefoxArgs?: string[];
	reAttach?: boolean;
	installAddonInProfile?: boolean;
}

export interface AttachConfiguration extends CommonConfiguration, DebugProtocol.AttachRequestArguments {
	request: 'attach';
	port?: number;
	host?: string;
}

export type ReloadConfiguration = string | string[] | DetailedReloadConfiguration;

export interface DetailedReloadConfiguration {
	watch: string | string[];
	ignore?: string | string[];
	debounce?: number | boolean;
}

export interface NormalizedReloadConfiguration {
	watch: string[];
	ignore: string[];
	debounce: number;
}

export interface ParsedConfiguration {
	attach?: ParsedAttachConfiguration;
	launch?: ParsedLaunchConfiguration;
	addon?: ParsedAddonConfiguration;
	pathMappings: { url: string | RegExp, path: string }[];
	filesToSkip: RegExp[];
	reloadOnChange?: NormalizedReloadConfiguration,
	sourceMaps: 'client' | 'server';
	showConsoleCallLocation: boolean;
}

export interface ParsedAttachConfiguration {
	host: string;
	port: number;
	reloadTabs: boolean;
}

export interface FirefoxPreferences {
	[key: string]: boolean | number | string;
}

type PathMappings = { url: string | RegExp, path: string }[];

export interface ParsedLaunchConfiguration {
	firefoxExecutable: string;
	firefoxArgs: string[];
	profileDir: string;
	srcProfileDir?: string;
	preferences: FirefoxPreferences;
	tmpDirs: string[];
	port: number;
	detached: boolean;
}

export interface ParsedAddonConfiguration {
	type: AddonType;
	path: string;
	id: string;
	installInProfile: boolean;
}

export async function parseConfiguration(
	config: LaunchConfiguration | AttachConfiguration
): Promise<ParsedConfiguration> {

	let attach: ParsedAttachConfiguration | undefined = undefined;
	let launch: ParsedLaunchConfiguration | undefined = undefined;
	let addon: ParsedAddonConfiguration | undefined = undefined;
	let port = config.port || 6000;
	let pathMappings: PathMappings = [];

	if (config.request === 'launch') {

		let tmpDirs: string[] = [];

		if (config.reAttach) {
			attach = {
				host: 'localhost', port,
				reloadTabs: (config.reloadOnAttach !== false)
			};
		}

		let firefoxExecutable = await findFirefoxExecutable(config.firefoxExecutable);

		let firefoxArgs: string[] = [ '-start-debugger-server', String(port), '-no-remote' ];
		if (config.firefoxArgs) {
			firefoxArgs.push(...config.firefoxArgs);
		}

		let { profileDir, srcProfileDir } = await parseProfileConfiguration(config, tmpDirs);

		firefoxArgs.push('-profile', profileDir);

		let preferences = createFirefoxPreferences(config.preferences);

		if (config.file) {
			if (!path.isAbsolute(config.file)) {
				throw 'The "file" property in the launch configuration has to be an absolute path';
			}

			let fileUrl = config.file;
			if (isWindowsPlatform()) {
				fileUrl = 'file:///' + fileUrl.replace(/\\/g, '/');
			} else {
				fileUrl = 'file://' + fileUrl;
			}
			firefoxArgs.push(fileUrl);

		} else if (config.url) {
			firefoxArgs.push(config.url);
		} else if (config.addonType || config.addonPath) {
			firefoxArgs.push('about:blank');
		} else {
			throw 'You need to set either "file" or "url" in the launch configuration';
		}

		if (config.pathMappings) {
			pathMappings.push(...config.pathMappings);
		}

		let detached = !!config.reAttach;

		launch = {
			firefoxExecutable, firefoxArgs, profileDir, srcProfileDir,
			preferences, tmpDirs, port, detached
		};

	} else { // config.request === 'attach'

		attach = {
			host: config.host || 'localhost', port,
			reloadTabs: !!config.reloadOnAttach
		};
	}

	if (config.addonType || config.addonPath) {
		addon = await parseAddonConfiguration(config, pathMappings);
	}

	parseWebRootConfiguration(config, pathMappings);

	pathMappings.push({ url: (isWindowsPlatform() ? 'file:///' : 'file://'), path: ''});

	let filesToSkip = parseSkipFilesConfiguration(config);

	let reloadOnChange = parseReloadConfiguration(config.reloadOnChange);

	let sourceMaps = config.sourceMaps || 'server';
	let showConsoleCallLocation = config.showConsoleCallLocation || false;

	return {
		attach, launch, addon, pathMappings, filesToSkip, reloadOnChange,
		sourceMaps, showConsoleCallLocation
	}
}

async function findFirefoxExecutable(configuredPath?: string): Promise<string> {

	if (configuredPath) {
		if (await isExecutable(configuredPath)) {
			return configuredPath;
		} else {
			throw 'Couldn\'t find the Firefox executable. Please correct the path given in your launch configuration.';
		}
	}
	
	let candidates: string[] = [];
	switch (os.platform()) {
		
		case 'linux':
		case 'freebsd':
		case 'sunos':
			candidates = [
				'/usr/bin/firefox-developer',
				'/usr/bin/firefox'
			]
			break;

		case 'darwin':
			candidates = [
				'/Applications/FirefoxDeveloperEdition.app/Contents/MacOS/firefox',
				'/Applications/Firefox.app/Contents/MacOS/firefox'
			]
			break;

		case 'win32':
			candidates = [
				'C:\\Program Files (x86)\\Firefox Developer Edition\\firefox.exe',
				'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
				'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
				'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
			]
			break;
	}

	for (let i = 0; i < candidates.length; i++) {
		if (await isExecutable(candidates[i])) {
			return candidates[i];
		}
	}
	
	throw 'Couldn\'t find the Firefox executable. Please specify the path in your launch configuration.';
}

async function parseProfileConfiguration(config: LaunchConfiguration, tmpDirs: string[])
: Promise<{ profileDir: string, srcProfileDir?: string }> {

	let profileDir: string;
	let srcProfileDir: string | undefined;

	if (config.profileDir) {
		if (config.profile) {
			throw 'You can set either "profile" or "profileDir", but not both';
		}
		srcProfileDir = config.profileDir;
	} else if (config.profile) {
		srcProfileDir = await findFirefoxProfileDir(config.profile);
	}

	if (config.keepProfileChanges) {
		if (srcProfileDir) {
			profileDir = srcProfileDir;
			srcProfileDir = undefined;
		} else {
			throw 'To enable "keepProfileChanges" you need to set either "profile" or "profileDir"';
		}
	} else {
		profileDir = path.join(os.tmpdir(), `vscode-firefox-debug-profile-${uuid.v4()}`);
		tmpDirs.push(profileDir);
	}

	return { profileDir, srcProfileDir };
}

function findFirefoxProfileDir(profileName: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {

		let finder = new FirefoxProfile.Finder();

		finder.getPath(profileName, (err, path) => {
			if (err) {
				reject(err);
			} else {
				resolve(path);
			}
		});
	});
}

function createFirefoxPreferences(
	additionalPreferences?: { [key: string]: boolean | number | string | null }
): FirefoxPreferences {

	let preferences: FirefoxPreferences = {};

	preferences['browser.shell.checkDefaultBrowser'] = false;
	preferences['devtools.chrome.enabled'] = true;
	preferences['devtools.debugger.prompt-connection'] = false;
	preferences['devtools.debugger.remote-enabled'] = true;
	preferences['devtools.debugger.workers'] = true;
	preferences['extensions.autoDisableScopes'] = 10;
	preferences['xpinstall.signatures.required'] = false;
	preferences['extensions.sdk.console.logLevel'] = 'all';
	preferences['toolkit.telemetry.reportingpolicy.firstRun'] = false;

	if (additionalPreferences !== undefined) {
		for (let key in additionalPreferences) {
			let value = additionalPreferences[key];
			if (value !== null) {
				preferences[key] = value;
			} else {
				delete preferences[key];
			}
		}
	}

	return preferences;
}

function parseWebRootConfiguration(config: CommonConfiguration, pathMappings: PathMappings): void {

	if (config.url) {
		if (!config.webRoot) {
			if (!config.pathMappings) {
				throw `If you set "url" you also have to set "webRoot" or "pathMappings" in the ${config.request} configuration`;
			}
			return;
		} else if (!path.isAbsolute(config.webRoot)) {
			throw `The "webRoot" property in the ${config.request} configuration has to be an absolute path`;
		}

		let webRootUrl = config.url;
		if (webRootUrl.indexOf('/') >= 0) {
			webRootUrl = webRootUrl.substr(0, webRootUrl.lastIndexOf('/'));
		}

		let webRoot = path.normalize(config.webRoot);
		if (isWindowsPlatform()) {
			webRoot = webRoot.replace(/\\/g, '/');
		}
		if (webRoot[webRoot.length - 1] === '/') {
			webRoot = webRoot.substr(0, webRoot.length - 1);
		}

		pathMappings.forEach((pathMapping) => {
			const to = pathMapping.path;
			if ((typeof to === 'string') && (to.substr(0, 10) === '${webRoot}')) {
				pathMapping.path = webRoot + to.substr(10);
			}
		});

		pathMappings.push({ url: webRootUrl, path: webRoot });

	} else if (config.webRoot) {
		throw `If you set "webRoot" you also have to set "url" in the ${config.request} configuration`;
	}
}

function parseSkipFilesConfiguration(config: CommonConfiguration): RegExp[] {

	let filesToSkip: RegExp[] = [];

	if (config.skipFiles) {
		config.skipFiles.forEach((glob) => {

			let minimatch = new Minimatch(glob);
			let regExp = minimatch.makeRe();

			if (regExp) {
				filesToSkip.push(regExp);
			} else {
				log.warn(`Invalid glob pattern "${glob}" specified in "skipFiles"`);
			}
		})
	}

	return filesToSkip;
}

function parseReloadConfiguration(
	reloadConfig: ReloadConfiguration | undefined
): NormalizedReloadConfiguration | undefined {

	if (reloadConfig === undefined) {
		return undefined;
	}

	const defaultDebounce = 100;

	if (typeof reloadConfig === 'string') {

		return {
			watch: [ reloadConfig ],
			ignore: [],
			debounce: defaultDebounce
		};

	} else if (Array.isArray(reloadConfig)) {

		return {
			watch: reloadConfig,
			ignore: [],
			debounce: defaultDebounce
		};

	} else {

		let _config = <DetailedReloadConfiguration>reloadConfig;

		let watch: string[];
		if (typeof _config.watch === 'string') {
			watch = [ _config.watch ];
		} else {
			watch = _config.watch;
		}

		let ignore: string[];
		if (_config.ignore === undefined) {
			ignore = [];
		} else if (typeof _config.ignore === 'string') {
			ignore = [ _config.ignore ];
		} else {
			ignore = _config.ignore;
		}

		let debounce: number;
		if (typeof _config.debounce === 'number') {
			debounce = _config.debounce;
		} else {
			debounce = (_config.debounce !== false) ? defaultDebounce : 0;
		}

		return { watch, ignore, debounce };
	}
}

async function parseAddonConfiguration(
	config: LaunchConfiguration | AttachConfiguration,
	pathMappings: PathMappings
): Promise<ParsedAddonConfiguration> {

	let addonType = config.addonType;
	let addonPath = config.addonPath;

	if (!addonType) {
		throw `If you set "addonPath" you also have to set "addonType" in the ${config.request} configuration`;
	}
	if (!addonPath) {
		throw `If you set "addonType" you also have to set "addonPath" in the ${config.request} configuration`;
	}

	let addonId = await findAddonId(addonPath);

	let installInProfile = false;
	if (config.request === 'launch') {
		if (config.installAddonInProfile !== undefined) {
			if (config.installAddonInProfile && config.reAttach) {
				throw '"installAddonInProfile" is not available with "reAttach"';
			}
			installInProfile = config.installAddonInProfile;
		} else {
			installInProfile = !config.reAttach;
		}
	}

	if (config.addonType === 'addonSdk') {

		let rewrittenAddonId = addonId.replace("@", "-at-");
		let sanitizedAddonPath = addonPath;
		if (sanitizedAddonPath[sanitizedAddonPath.length - 1] === '/') {
			sanitizedAddonPath = sanitizedAddonPath.substr(0, sanitizedAddonPath.length - 1);
		}
		pathMappings.push({
			url: 'resource://' + rewrittenAddonId,
			path: sanitizedAddonPath
		});

	} else if (config.addonType === 'webExtension') {

		let rewrittenAddonId = addonId.replace('{', '%7B').replace('}', '%7D');
		let sanitizedAddonPath = addonPath;
		if (sanitizedAddonPath[sanitizedAddonPath.length - 1] === '/') {
			sanitizedAddonPath = sanitizedAddonPath.substr(0, sanitizedAddonPath.length - 1);
		}
		pathMappings.push({ 
			url: new RegExp('^moz-extension://[0-9a-f-]*(/.*)$'),
			path: sanitizedAddonPath
		});
		pathMappings.push({ 
			url: new RegExp(`^jar:file:.*/extensions/${rewrittenAddonId}.xpi!(/.*)$`),
			path: sanitizedAddonPath
		});
	}

	return {
		type: addonType, path: addonPath, id: addonId, installInProfile
	}
}
