import { Socket } from 'net';
import { ChildProcess } from 'child_process';
import * as chokidar from 'chokidar';
import debounce = require('debounce');
import { DebugProtocol } from 'vscode-debugprotocol';
import { InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, ContinuedEvent } from 'vscode-debugadapter';
import { Log } from './util/log';
import { AddonManager } from './adapter/addonManager';
import { launchFirefox } from './firefox/launch';
import { DebugConnection, TabActorProxy, WorkerActorProxy, IThreadActorProxy, ConsoleActorProxy, ExceptionBreakpoints, ISourceActorProxy, ObjectGripActorProxy, LongStringGripActorProxy } from './firefox/index';
import { ThreadAdapter, ThreadPauseCoordinator, FrameAdapter, VariableAdapter, ConsoleAPICallAdapter, VariablesProvider, SourceAdapter, Registry, BreakpointsAdapter, SkipFilesManager } from './adapter/index';
import { ParsedConfiguration } from "./configuration";
import { PathMapper, urlDetector } from './util/pathMapper';
import { isWindowsPlatform as detectWindowsPlatform } from './util/misc';
import { tryRemoveRepeatedly } from './util/fs';
import { connect, waitForSocket } from './util/net';

let log = Log.create('FirefoxDebugSession');
let consoleActorLog = Log.create('ConsoleActor');

export class FirefoxDebugSession {

	public readonly isWindowsPlatform = detectWindowsPlatform();
	public readonly pathMapper: PathMapper;
	public readonly breakpointsAdapter: BreakpointsAdapter;
	public readonly skipFilesManager: SkipFilesManager;
	public readonly addonManager?: AddonManager;
	private reloadWatcher?: chokidar.FSWatcher;
	private threadPauseCoordinator = new ThreadPauseCoordinator();

	private firefoxProc?: ChildProcess;
	public firefoxDebugConnection: DebugConnection;
	private firefoxDebugSocketClosed: boolean;

	public readonly tabs = new Registry<TabActorProxy>();
	public readonly threads = new Registry<ThreadAdapter>();
	public readonly sources = new Registry<SourceAdapter>();
	public readonly frames = new Registry<FrameAdapter>();
	public readonly variablesProviders = new Registry<VariablesProvider>();

	private exceptionBreakpoints: ExceptionBreakpoints = ExceptionBreakpoints.All;

	private reloadTabs = false;

	private lastActiveThreadId: number = 0;

	public constructor(
		public readonly config: ParsedConfiguration,
		private readonly sendEvent: (ev: DebugProtocol.Event) => void
	) {
		this.pathMapper = new PathMapper(this.config.pathMappings, this.config.addon);
		this.breakpointsAdapter = new BreakpointsAdapter(this.threads, this.sendEvent);
		this.skipFilesManager = new SkipFilesManager(this.config.filesToSkip, this.threads);
		if (this.config.addon) {
			this.addonManager = new AddonManager(this);
		}
	}

	public async start(): Promise<void> {

		let socket = await this.connectToFirefox();

		this.firefoxDebugConnection = new DebugConnection(this.config.sourceMaps, socket);
		this.firefoxDebugSocketClosed = false;
		let rootActor = this.firefoxDebugConnection.rootActor;

		// attach to all tabs, register the corresponding threads and inform VSCode about them
		rootActor.onTabOpened(async ([tabActor, consoleActor]) => {
			log.info(`Tab opened with url ${tabActor.url}`);
			let tabId = this.tabs.register(tabActor);
			let threadAdapter = await this.attachTabOrAddon(tabActor, consoleActor, `Tab ${tabId}`, tabId);
			if (threadAdapter !== undefined) {
				this.attachConsole(consoleActor, threadAdapter);
			}
		});

		rootActor.onTabListChanged(() => {
			rootActor.fetchTabs();
		});

		rootActor.onInit(async () => {

			let actors = await rootActor.fetchTabs();

			if (this.addonManager) {
				this.addonManager.sessionStarted(rootActor, actors.addons, actors.preference, this);
			}

			this.reloadTabs = false;
		});

		socket.on('close', () => {
			log.info('Connection to Firefox closed - terminating debug session');
			this.firefoxDebugSocketClosed = true;
			this.sendEvent(new TerminatedEvent());
		});

		if (this.config.reloadOnChange) {

			this.reloadWatcher = chokidar.watch(this.config.reloadOnChange.watch, { 
				ignored: this.config.reloadOnChange.ignore,
				ignoreInitial: true
			});

			let reload: () => void;
			if (this.config.addon) {

				reload = () => {
					if (this.addonManager) {
						log.debug('Reloading add-on');
	
						this.addonManager.reloadAddon();
					}
				}

			} else {

				reload = () => {
					log.debug('Reloading tabs');

					for (let [, tabActor] of this.tabs) {
						tabActor.reload();
					}
				}
			}

			if (this.config.reloadOnChange.debounce > 0) {
				reload = debounce(reload, this.config.reloadOnChange.debounce);
			}

			this.reloadWatcher.on('add', reload);
			this.reloadWatcher.on('change', reload);
			this.reloadWatcher.on('unlink', reload);
		}

		// now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
		this.sendEvent(new InitializedEvent());
	}

	public async stop(): Promise<void> {

		let detachPromises: Promise<void>[] = [];
		if (!this.firefoxDebugSocketClosed) {
			for (let [, threadAdapter] of this.threads) {
				detachPromises.push(threadAdapter.detach());
			}
		}
		await Promise.all(detachPromises);

		await this.disconnectFirefoxAndCleanup();
	}

	public setExceptionBreakpoints(exceptionBreakpoints: ExceptionBreakpoints) {

		this.exceptionBreakpoints = exceptionBreakpoints;

		for (let [, threadAdapter] of this.threads) {
			threadAdapter.setExceptionBreakpoints(this.exceptionBreakpoints);
		}
	}

	public setActiveThread(threadAdapter: ThreadAdapter): void {
		this.lastActiveThreadId = threadAdapter.id;
	}

	public getActiveThread(): ThreadAdapter | undefined {

		let threadAdapter = this.threads.find(this.lastActiveThreadId);
		if (threadAdapter !== undefined) {
			return threadAdapter;
		}

		// last active thread not found -> we return the first thread we get from the registry
		for (let [, threadAdapter] of this.threads) {
			this.setActiveThread(threadAdapter);
			return threadAdapter;
		}

		return undefined;
	}

	public getOrCreateObjectGripActorProxy(objectGrip: FirefoxDebugProtocol.ObjectGrip): ObjectGripActorProxy {
		return this.firefoxDebugConnection.getOrCreate(objectGrip.actor, () =>
			new ObjectGripActorProxy(objectGrip, this.firefoxDebugConnection));
	}

	public getOrCreateLongStringGripActorProxy(longStringGrip: FirefoxDebugProtocol.LongStringGrip): LongStringGripActorProxy {
		return this.firefoxDebugConnection.getOrCreate(longStringGrip.actor, () =>
			new LongStringGripActorProxy(longStringGrip, this.firefoxDebugConnection));
	}

	private async connectToFirefox(): Promise<Socket> {

		let socket: Socket | undefined = undefined;

		if (this.config.attach) {
			try {

				socket = await connect(this.config.attach.port, this.config.attach.host);

				this.reloadTabs = this.config.attach.reloadTabs;

			} catch(err) {
				if (!this.config.launch) {
					throw err;
				}
			}
		}

		if (socket === undefined) {

			// send messages from Firefox' stdout to the debug console when debugging an addonSdk extension
			let sendToConsole: (msg: string) => void = 
				(this.config.addon && this.config.addon.type === 'addonSdk') ? 
					(msg) => this.sendEvent(new OutputEvent(msg + '\n', 'stdout')) :
					(msg) => undefined;

			this.firefoxProc = await launchFirefox(this.config.launch!, sendToConsole, this.addonManager);

			socket = await waitForSocket(this.config.launch!.port);
		}

		return socket;
	}

	private async disconnectFirefoxAndCleanup(): Promise<void> {

		if (this.reloadWatcher !== undefined) {
			this.reloadWatcher.close();
			this.reloadWatcher = undefined;
		}

		if (!this.firefoxDebugSocketClosed) {
			await this.firefoxDebugConnection.disconnect();
		}

		if (this.config.launch) {
			let launchConfig = this.config.launch;

			if (this.firefoxProc) {
				let firefoxProc = this.firefoxProc;

				if (launchConfig.tmpDirs.length > 0) {

					await new Promise<void>((resolve) => {

						this.firefoxProc!.once('exit', async () => {
							try {
								await Promise.all(launchConfig.tmpDirs.map(
									(tmpDir) => tryRemoveRepeatedly(tmpDir)));
							} catch (err) {
								log.warn(`Failed to remove temporary directory: ${err}`);
							}
							resolve();
						});

						firefoxProc.kill('SIGTERM');
					});

				} else {
					firefoxProc.kill('SIGTERM');
				}

				this.firefoxProc = undefined;
			}
		}
	}

	public async attachTabOrAddon(
		tabActor: TabActorProxy,
		consoleActor: ConsoleActorProxy,
		threadName: string,
		tabId?: number
	): Promise<ThreadAdapter | undefined> {

		let reload = (tabId != null) && this.reloadTabs;

		let threadActor: IThreadActorProxy;
		try {
			threadActor = await tabActor.attach();
		} catch (err) {
			log.error(`Failed attaching to tab: ${err}`);
			return undefined;
		}

		log.debug(`Attached to tab ${tabActor.name}`);

		let threadAdapter = new ThreadAdapter(threadActor, consoleActor,
			this.threadPauseCoordinator, threadName, this);

		this.attachThread(threadAdapter, threadActor.name);

		if (tabId != null) {

			let nextWorkerId = 1;
			tabActor.onWorkerStarted(async (workerActor) => {

				log.info(`Worker started with url ${tabActor.url}`);

				let workerId = nextWorkerId++;

				try {
					await this.attachWorker(workerActor, tabId, workerId);
				} catch (err) {
					log.error(`Failed attaching to worker: ${err}`);
				}
			});

			tabActor.onWorkerListChanged(() => tabActor.fetchWorkers());
			tabActor.fetchWorkers();

			tabActor.onDetached(() => {

				this.threadPauseCoordinator.threadTerminated(threadAdapter.id, threadAdapter.name);

				if (this.threads.has(threadAdapter.id)) {
					this.threads.unregister(threadAdapter.id);
					this.sendEvent(new ThreadEvent('exited', threadAdapter.id));
				}

				threadAdapter.dispose();

				this.tabs.unregister(tabId);

				tabActor.dispose();
			});
		}

		try {

			await threadAdapter.init(this.exceptionBreakpoints, reload);

			this.sendEvent(new ThreadEvent('started', threadAdapter.id));

			return threadAdapter;

		} catch (err) {
			log.info(`Failed attaching to tab: ${err}`);
			return undefined;
		}
	}

	private async attachWorker(workerActor: WorkerActorProxy, tabId: number, workerId: number): Promise<void> {

		await workerActor.attach();
		let [threadActor, consoleActor] = await workerActor.connect();

		log.debug(`Attached to worker ${workerActor.name}`);

		let threadAdapter = new ThreadAdapter(threadActor, consoleActor,
			this.threadPauseCoordinator, `Worker ${tabId}/${workerId}`, this);

		this.attachThread(threadAdapter, threadActor.name);

		await threadAdapter.init(this.exceptionBreakpoints, false);

		this.sendEvent(new ThreadEvent('started', threadAdapter.id));

		workerActor.onClose(() => {
			this.threads.unregister(threadAdapter.id);
			this.sendEvent(new ThreadEvent('exited', threadAdapter.id));
		});
	}

	private attachThread(threadAdapter: ThreadAdapter, actorName: string): void {

		threadAdapter.onNewSource((sourceActor) => {
			this.attachSource(sourceActor, threadAdapter);
		});

		threadAdapter.onPaused((reason) => {
			log.info(`Thread ${actorName} paused , reason: ${reason.type}`);
			this.sendStoppedEvent(threadAdapter, reason);
		});

		threadAdapter.onResumed(() => {
			log.info(`Thread ${actorName} resumed unexpectedly`);
			this.sendEvent(new ContinuedEvent(threadAdapter.id));
		});

		threadAdapter.onExited(() => {
			log.info(`Thread ${actorName} exited`);
			this.threads.unregister(threadAdapter.id);
			this.sendEvent(new ThreadEvent('exited', threadAdapter.id));
		});
	}

	private attachSource(sourceActor: ISourceActorProxy, threadAdapter: ThreadAdapter): void {

		const source = sourceActor.source;
		const sourcePath = this.pathMapper.convertFirefoxSourceToPath(source);
		let sourceAdapter = threadAdapter.findCorrespondingSourceAdapter(source);

		if (sourceAdapter !== undefined) {

			sourceAdapter.actor = sourceActor;

		} else {

			sourceAdapter = threadAdapter.createSourceAdapter(sourceActor, sourcePath);

		}

		// check if this source should be skipped
		let skipThisSource: boolean | undefined = undefined;
		if (sourcePath !== undefined) {
			skipThisSource = this.skipFilesManager.shouldSkipPath(sourcePath);
		} else if (source.generatedUrl && (!source.url || !urlDetector.test(source.url))) {
			skipThisSource = this.skipFilesManager.shouldSkipUrl(source.generatedUrl);
		} else if (source.url) {
			skipThisSource = this.skipFilesManager.shouldSkipUrl(source.url);
		}

		if (skipThisSource !== undefined) {
			if (source.isBlackBoxed !== skipThisSource) {
				sourceActor.setBlackbox(skipThisSource);
			}
		}

		this.breakpointsAdapter.setBreakpointsOnNewSource(sourceAdapter, threadAdapter);
	}

	public attachConsole(consoleActor: ConsoleActorProxy, threadAdapter: ThreadAdapter): void {

		consoleActor.onConsoleAPICall((consoleEvent) => {
			consoleActorLog.debug(`Console API: ${JSON.stringify(consoleEvent)}`);

			let category = (consoleEvent.level === 'error') ? 'stderr' :
				(consoleEvent.level === 'warn') ? 'console' : 'stdout';

			let outputEvent: DebugProtocol.OutputEvent;
			if ((consoleEvent.arguments.length === 1) && (typeof consoleEvent.arguments[0] !== 'object')) {

				let msg = String(consoleEvent.arguments[0]);
				if (this.config.showConsoleCallLocation) {
					let filename = this.pathMapper.convertFirefoxUrlToPath(consoleEvent.filename);
					msg += ` (${filename}:${consoleEvent.lineNumber}:${consoleEvent.columnNumber})`;
				}
				outputEvent = new OutputEvent(msg + '\n', category);

			} else {

				let args = consoleEvent.arguments.map((grip, index) =>
					VariableAdapter.fromGrip(String(index), undefined, undefined, grip, true, threadAdapter));

				if (this.config.showConsoleCallLocation) {
					let filename = this.pathMapper.convertFirefoxUrlToPath(consoleEvent.filename);
					let locationVar = new VariableAdapter(
						'location', undefined, undefined,
						`(${filename}:${consoleEvent.lineNumber}:${consoleEvent.columnNumber})`,
						threadAdapter);
					args.push(locationVar);
				}

				let argsAdapter = new ConsoleAPICallAdapter(args, threadAdapter);

				outputEvent = new OutputEvent('', category);
				outputEvent.body.variablesReference = argsAdapter.variablesProviderId;
			}

			this.sendEvent(outputEvent);
		});

		consoleActor.onPageErrorCall((err) => {
			consoleActorLog.debug(`Page Error: ${JSON.stringify(err)}`);

			if (err.category === 'content javascript') {
				let category = err.exception ? 'stderr' : 'stdout';
				this.sendEvent(new OutputEvent(err.errorMessage + '\n', category));
			}
		});

		consoleActor.startListeners();
		consoleActor.getCachedMessages();
	}

	public sendStoppedEvent(
		threadAdapter: ThreadAdapter,
		reason?: FirefoxDebugProtocol.ThreadPausedReason
	): void {

		let pauseType = reason ? reason.type : 'interrupt';
		let stoppedEvent: DebugProtocol.StoppedEvent = new StoppedEvent(pauseType, threadAdapter.id);
		stoppedEvent.body.allThreadsStopped = false;

		if (reason && reason.exception) {

			if (typeof reason.exception === 'string') {

				stoppedEvent.body.text = reason.exception;

			} else if ((typeof reason.exception === 'object') && (reason.exception.type === 'object')) {

				let exceptionGrip = <FirefoxDebugProtocol.ObjectGrip>reason.exception;
				if (exceptionGrip.preview.message) {
					stoppedEvent.body.text = `${exceptionGrip.class}: ${exceptionGrip.preview.message}`;
				} else {
					stoppedEvent.body.text = exceptionGrip.class;
				}
			}
		}

		this.sendEvent(stoppedEvent);
	}
}
