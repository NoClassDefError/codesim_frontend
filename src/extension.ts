import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const extensionNamespace = 'codesim-frontend';
const viewerCommandId = `${extensionNamespace}.openViewer`;
const signalsCommandId = `${extensionNamespace}.openSignals`;
const selectBackendCommandId = `${extensionNamespace}.selectBackendDirectory`;
const selectUserWorkspaceCommandId = `${extensionNamespace}.selectUserWorkspace`;
const userWorkspaceSetting = 'userWorkspace';
/** When true, always run the codesimpy package installed in the selected interpreter. */
const useInstalledBackendSetting = 'useInstalledBackend';
/** Wait this long after the last .py change before rescanning the user workspace. */
const workspaceRescanDelay_ms = 500;
const viewerViewId = `${extensionNamespace}.viewer`;
const backendStatusColorId = 'codesim.backendRunningForeground';
const defaultSystem = 'SMIB__GFM_A_C_LC';
const pythonExtensionId = 'ms-python.python';

type AnalysisKind = 'simulation' | 'smallSignal' | 'interaction' | 'rms';
// 'viewer' is the topology sidebar, 'signals' the results panel.
type WebviewRole = 'viewer' | 'signals';
type SnapshotReason = 'load' | 'analysis' | 'request';

// Results the topology viewer never reads. Simulation traces alone can be
// hundreds of MB of JSON for large systems, so they are not sent to it.
const viewerOmittedSnapshotFields = [
	'signals',
	'simulationData',
	'smallSignal',
	'interactionAnalysis',
	'rmsSimulation',
];

/** RMS descriptor shown while an RMS run streams; chunks fill its signals. */
function liveRMSPlaceholder(): Record<string, unknown> {
	return {
		available: true,
		streaming: true,
		model: 'RMS',
		differentialStateNames: [],
		algebraicStateNames: [],
		time_s: [],
		algebraicResidual: [],
		maxAlgebraicResidual: 0,
		signals: [],
	};
}

/** Local wall-clock time with milliseconds, e.g. 14:03:07.512. */
function timestamp(): string {
	const now = new Date();
	const pad = (value: number, width = 2) => String(value).padStart(width, '0');
	return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function formatDuration(start_ms: number): string {
	const elapsed_ms = Date.now() - start_ms;
	return elapsed_ms < 1000 ? `${elapsed_ms} ms` : `${(elapsed_ms / 1000).toFixed(2)} s`;
}

/** Short JSON for logs; long values are cut so one line stays readable. */
function brief(value: unknown, limit = 300): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	return text.length > limit ? `${text.slice(0, limit)}… (${text.length} chars)` : text;
}

function appendInPlace(target: unknown[], source: unknown): void {
	if (!Array.isArray(source)) {
		return;
	}
	for (const value of source) {
		target.push(value);
	}
}

interface Backend {
	cwd: string;
	module: string;
	pythonPath?: string;
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

/** A codesim checkout (or its codesimpy package), or a PESLite checkout. */
function detectBackend(directory: string): Backend | undefined {
	if (fs.existsSync(path.join(directory, 'codesimpy', 'core', 'system.py'))) {
		return { cwd: directory, module: 'codesimpy.api.cli' };
	}
	if (fs.existsSync(path.join(directory, 'core', 'system.py'))) {
		return { cwd: path.dirname(directory), module: 'codesimpy.api.cli' };
	}
	if (fs.existsSync(path.join(directory, 'src', 'peslite', 'frontend', 'service.py'))) {
		return { cwd: directory, module: 'peslite.frontend', pythonPath: path.join(directory, 'src') };
	}
	return undefined;
}

/** The folder a user recognises as the backend: the codesimpy package, or a PESLite checkout. */
function backendDisplayDirectory(backend: Backend): string {
	return backend.module.startsWith('codesimpy.') ? path.join(backend.cwd, 'codesimpy') : backend.cwd;
}

interface SourceReference {
	file: string;
	line?: number;
	column?: number;
}

interface WebviewMessage {
	type?: string;
	reference?: SourceReference;
	layout?: unknown;
	systemName?: string;
	analysis?: AnalysisKind;
	parameterName?: string;
	parameterValue?: unknown;
	correction?: boolean;
	cutoff_Hz?: number;
	maxStep_s?: number;
}

interface BackendResponse {
	id?: number;
	ok?: boolean;
	result?: Record<string, unknown> | string[];
	error?: string;
	type?: string;
	requestId?: number;
	[key: string]: unknown;
}

/** One user file that failed to load, as reported by `workspace.set`. */
interface WorkspaceLoadError {
	file: string;
	line?: number;
	error: string;
	traceback?: string;
}

interface WorkspaceScan {
	workspace: string | null;
	systems: Array<{ id: string; source: string; file?: string }>;
	errors: WorkspaceLoadError[];
}

interface PythonEnvironmentPath {
	readonly path: string;
}

interface ResolvedPythonEnvironment {
	readonly executable: {
		readonly uri: vscode.Uri | undefined;
	};
}

interface PythonExtensionApi {
	readonly environments: {
		getActiveEnvironmentPath(
			resource?: vscode.Uri | vscode.WorkspaceFolder,
		): PythonEnvironmentPath | undefined;
		resolveEnvironment(
			environment: PythonEnvironmentPath | string,
		): Promise<ResolvedPythonEnvironment | undefined>;
	};
}

export function activate(context: vscode.ExtensionContext): void {
	const host = new CodeSimHost(context);
	const viewerProvider = new CodeSimViewerProvider(context, host);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(viewerViewId, viewerProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand(viewerCommandId, async () => {
			await vscode.commands.executeCommand(`${viewerViewId}.focus`);
		}),
		vscode.commands.registerCommand(signalsCommandId, () => {
			SignalsPanel.createOrShow(context, host);
		}),
		vscode.commands.registerCommand(selectBackendCommandId, () => host.selectBackendDirectory()),
		vscode.commands.registerCommand(selectUserWorkspaceCommandId, () => host.selectUserWorkspace()),
	);
}

class CodeSimHost {
	private readonly webviews = new Map<vscode.Webview, WebviewRole>();
	private readonly output: vscode.OutputChannel;
	private readonly backendStatus: vscode.StatusBarItem;
	private currentSnapshotUri: vscode.Uri | undefined;
	private currentSnapshot: unknown;
	private selectedSystem = defaultSystem;
	private parameterOverrides: Record<string, unknown> = {};
	private backendProcess: ChildProcessWithoutNullStreams | undefined;
	private backendStart: Promise<void> | undefined;
	private backendBuffer = '';
	private backendMessageQueue: Promise<void> = Promise.resolve();
	private nextRequestId = 1;
	private activeAction: string | undefined;
	/** Chunk and sample counts of the current streaming run, for the log. */
	private streamChunks = 0;
	private streamSamples = 0;
	/** The folder the backend last scanned for @system classes, and how many files failed. */
	private appliedWorkspace: string | undefined;
	private workspaceErrors = 0;
	private workspaceWatcher: vscode.FileSystemWatcher | undefined;
	/** Directory the running backend was loaded from (checkout or installed package). */
	private runningBackendDirectory: string | undefined;
	private workspaceRescanTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly pendingRequests = new Map<number, {
		resolve: (value: Record<string, unknown> | string[]) => void;
		reject: (error: Error) => void;
	}>();

	/** Append a timestamped, scoped line to the CodeSim output channel. */
	private log(scope: string, message: string): void {
		this.output.appendLine(`[${timestamp()}] [${scope}] ${message}`);
	}

	constructor(private readonly context: vscode.ExtensionContext) {
		this.output = vscode.window.createOutputChannel('CodeSim');
		this.backendStatus = vscode.window.createStatusBarItem(
			`${extensionNamespace}.backendStatus`,
			vscode.StatusBarAlignment.Left,
			10,
		);
		this.backendStatus.name = 'CodeSim Python backend';
		this.backendStatus.command = viewerCommandId;
		this.setBackendStatus(false);
		this.backendStatus.show();
		context.subscriptions.push(
			this.output,
			this.backendStatus,
			{ dispose: () => { void this.stopBackend(); } },
			{ dispose: () => this.disposeWorkspaceWatcher() },
			vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.refreshUserWorkspace(); }),
			vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.refreshUserWorkspace(); }),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(`${extensionNamespace}.${userWorkspaceSetting}`)) {
					void this.refreshUserWorkspace();
				} else if (
					event.affectsConfiguration(`${extensionNamespace}.backendPath`)
					|| event.affectsConfiguration(`${extensionNamespace}.${useInstalledBackendSetting}`)
				) {
					void this.sendBackendInfo();
				}
			}),
		);
	}

	/**
	 * The folder scanned for user @system classes: the configured
	 * `userWorkspace`, else the first VS Code workspace folder. User code is
	 * never executed in an untrusted workspace.
	 */
	private userWorkspace(): string | undefined {
		if (!vscode.workspace.isTrusted) {
			return undefined;
		}
		const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
		const configured = vscode.workspace
			.getConfiguration(extensionNamespace, firstFolder)
			.get<string>(userWorkspaceSetting, '')
			.trim();
		if (configured) {
			return path.isAbsolute(configured)
				? configured
				: path.resolve(firstFolder?.fsPath ?? '', configured);
		}
		return firstFolder?.fsPath;
	}

	async selectUserWorkspace(): Promise<void> {
		const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
		const current = this.userWorkspace();
		const selected = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			defaultUri: current ? vscode.Uri.file(current) : firstFolder,
			openLabel: 'Use this folder',
			title: 'Select the folder with your @system classes',
		});
		if (!selected?.[0]) {
			return;
		}
		const configuration = vscode.workspace.getConfiguration(extensionNamespace, firstFolder);
		// Without an open workspace there is no workspace settings file to write to.
		const target = firstFolder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
		// The configuration listener rescans the backend.
		await configuration.update(userWorkspaceSetting, selected[0].fsPath, target);
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage(
				'CodeSim loads user systems only in a trusted workspace. Trust this workspace to use them.',
			);
		}
	}

	/** Rescan the user workspace in a running backend and refresh the system list. */
	private async refreshUserWorkspace(): Promise<void> {
		this.watchUserWorkspace();
		if (!this.backendProcess || this.activeAction) {
			await this.sendBackendInfo();
			return;
		}
		await this.applyUserWorkspace();
		if (await this.sendBackendInfo()) {
			await this.runDescriptor(this.selectedSystem);
		}
	}

	/** Tell the backend which folder to scan; load errors go to the output channel. */
	private async applyUserWorkspace(): Promise<void> {
		const workspace = this.userWorkspace();
		let scan: WorkspaceScan;
		try {
			scan = await this.request<Record<string, unknown>>(
				'workspace.set', { path: workspace ?? null },
			) as unknown as WorkspaceScan;
		} catch (error) {
			// e.g. a PESLite backend, which has no user workspace.
			const detail = error instanceof Error ? error.message : String(error);
			this.log('workspace', `${detail}`);
			this.appliedWorkspace = undefined;
			this.workspaceErrors = 0;
			return;
		}
		this.appliedWorkspace = scan.workspace ?? undefined;
		this.workspaceErrors = scan.errors.length;
		const userSystems = scan.systems.filter((entry) => entry.source === 'workspace');
		this.log(
			'workspace',
			`${scan.workspace ?? '(none)'}: ` +
			`${userSystems.length} user system(s)` +
			(userSystems.length ? ` (${userSystems.map((entry) => entry.id).join(', ')})` : ''),
		);
		for (const failure of scan.errors) {
			this.log('workspace', `${failure.file}:${failure.line ?? 0} ${failure.error}`);
			if (failure.traceback) {
				this.output.appendLine(failure.traceback);
			}
		}
		if (scan.errors.length) {
			const first = scan.errors[0];
			const openFile = 'Open file';
			void vscode.window.showWarningMessage(
				`CodeSim could not load ${scan.errors.length} user file(s): ${first.error}`,
				openFile,
				'Show output',
			).then((choice) => {
				if (choice === openFile) {
					void this.openSource({ file: first.file, line: first.line || 1 });
				} else if (choice) {
					this.output.show(true);
				}
			});
		}
	}

	/** Rescan on .py changes in the user workspace (debounced, only while idle). */
	private watchUserWorkspace(): void {
		this.disposeWorkspaceWatcher();
		const workspace = this.userWorkspace();
		if (!workspace) {
			return;
		}
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(workspace), '**/*.py'),
		);
		const schedule = () => {
			if (this.workspaceRescanTimer) {
				clearTimeout(this.workspaceRescanTimer);
			}
			this.workspaceRescanTimer = setTimeout(() => {
				this.workspaceRescanTimer = undefined;
				if (this.backendProcess && !this.activeAction) {
					void this.refreshUserWorkspace();
				}
			}, workspaceRescanDelay_ms);
		};
		watcher.onDidChange(schedule);
		watcher.onDidCreate(schedule);
		watcher.onDidDelete(schedule);
		this.workspaceWatcher = watcher;
	}

	private disposeWorkspaceWatcher(): void {
		if (this.workspaceRescanTimer) {
			clearTimeout(this.workspaceRescanTimer);
			this.workspaceRescanTimer = undefined;
		}
		this.workspaceWatcher?.dispose();
		this.workspaceWatcher = undefined;
	}

	private setBackendStatus(running: boolean): void {
		this.backendStatus.text = running
			? '$(vm-running) CodeSim: Running'
			: '$(circle-slash) CodeSim: Stopped';
		this.backendStatus.tooltip = running
			? 'CodeSim Python backend is running. Click to open the System Viewer.'
			: 'CodeSim Python backend is stopped. Click to open the System Viewer.';
		this.backendStatus.color = running
			? new vscode.ThemeColor(backendStatusColorId)
			: undefined;
		this.backendStatus.accessibilityInformation = {
			label: running
				? 'CodeSim Python backend is running'
				: 'CodeSim Python backend is stopped',
		};
	}

	registerWebview(webview: vscode.Webview, role: WebviewRole): () => void {
		this.webviews.set(webview, role);
		return () => this.webviews.delete(webview);
	}

	/**
	 * Choose the backend: the codesimpy package pip-installed in the selected
	 * interpreter, a source checkout folder, or automatic detection.
	 */
	async selectBackendDirectory(): Promise<void> {
		const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
		const configuration = vscode.workspace.getConfiguration(extensionNamespace, workspaceUri);
		const configured = configuration.get<string>('backendPath', '').trim();
		const useInstalled = configuration.get<boolean>(useInstalledBackendSetting, false);
		type BackendChoice = vscode.QuickPickItem & { choice: 'installed' | 'directory' | 'auto' };
		let executable: string | undefined;
		let installed: string | undefined;
		// Probing the interpreter takes a moment; the quick pick shows a busy state meanwhile.
		const items = (async (): Promise<BackendChoice[]> => {
			try {
				executable = await this.pythonExecutable();
				installed = await this.findInstalledBackend(executable, this.existingWorkingDirectory());
			} catch (error) {
				this.log('backend', error instanceof Error ? error.message : String(error));
			}
			return [
				{
					choice: 'installed',
					label: '$(package) Installed package (pip)',
					description: useInstalled ? 'current' : undefined,
					// The origin is <site-packages>/codesimpy/api/cli.py.
					detail: installed
						? path.dirname(path.dirname(installed))
						: executable
							? `codesimpy is not installed in ${executable}`
							: 'No Python interpreter selected',
				},
				{
					choice: 'directory',
					label: '$(folder) Source checkout…',
					description: !useInstalled && configured ? 'current' : undefined,
					detail: configured || 'Choose a codesimpy checkout folder',
				},
				{
					choice: 'auto',
					label: '$(search) Automatic',
					description: !useInstalled && !configured ? 'current' : undefined,
					detail: 'A codesimpy checkout in the open workspace, else the installed package',
				},
			];
		})();
		const picked = await vscode.window.showQuickPick(items, {
			title: 'Select the CodeSim backend',
			placeHolder: 'Which codesimpy should the backend run?',
		});
		if (!picked) {
			return;
		}
		// Without an open workspace there is no workspace settings file to write to.
		const target = workspaceUri ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
		let summary: string;
		if (picked.choice === 'installed') {
			if (!installed) {
				const selectInterpreter = 'Select Interpreter';
				const choice = await vscode.window.showWarningMessage(
					executable
						? `codesimpy is not installed in ${executable}. Install it with ` +
							'"python -m pip install git+https://github.com/NoClassDefError/codesimpy.git" ' +
							'or select another interpreter.'
						: 'Select a Python interpreter first.',
					selectInterpreter,
				);
				if (choice === selectInterpreter) {
					await vscode.commands.executeCommand('python.setInterpreter');
				}
				return;
			}
			await configuration.update(useInstalledBackendSetting, true, target);
			summary = `installed codesimpy (${path.dirname(path.dirname(installed))})`;
		} else if (picked.choice === 'directory') {
			const selected = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				defaultUri: configured
					? vscode.Uri.file(path.isAbsolute(configured)
						? configured
						: path.resolve(workspaceUri?.fsPath ?? '', configured))
					: workspaceUri,
				openLabel: 'Use this directory',
				title: 'Select the CodeSim backend directory',
			});
			if (!selected?.[0]) {
				return;
			}
			const backend = detectBackend(selected[0].fsPath)?.cwd;
			if (!backend) {
				void vscode.window.showErrorMessage(
					'Select a codesim project (or its codesimpy directory) or a PESLite checkout.',
				);
				return;
			}
			await configuration.update('backendPath', backend, target);
			await configuration.update(useInstalledBackendSetting, false, target);
			summary = backend;
		} else {
			await configuration.update('backendPath', '', target);
			await configuration.update(useInstalledBackendSetting, false, target);
			summary = 'automatic';
		}
		this.log('backend', `backend set to ${summary}`);
		await this.sendBackendInfo();
		if (!this.backendProcess) {
			return;
		}
		const restart = 'Restart backend';
		const choice = await vscode.window.showInformationMessage(
			`CodeSim backend: ${summary}. Restart the backend to apply it.`,
			restart,
		);
		if (choice === restart) {
			await this.restartBackend();
		}
	}

	/** Stop the running backend, wait for it to exit, and start it again. */
	private async restartBackend(): Promise<void> {
		const process = this.backendProcess;
		if (process) {
			const exited = new Promise<void>((resolve) => process.once('close', () => resolve()));
			await this.stopBackend();
			await exited;
		}
		await this.startBackendFromUi();
	}

	/**
	 * The backend directory shown next to the start button: where the running
	 * backend was loaded from, else the source checkout it would use now.
	 */
	private backendDirectory(): string | undefined {
		if (this.backendProcess) {
			return this.runningBackendDirectory;
		}
		const { backend, useInstalled } = this.findBackendCheckout();
		if (useInstalled) {
			return 'pip-installed codesimpy';
		}
		return backend ? backendDisplayDirectory(backend) : undefined;
	}

	async handleMessage(message: WebviewMessage, source?: vscode.Webview): Promise<void> {
		switch (message.type) {
			case 'requestBackendInfo':
				await this.sendBackendInfo();
				break;
			case 'startBackend':
				await this.startBackendFromUi();
				break;
			case 'stopBackend':
				await this.stopBackend();
				break;
			case 'requestSystemSnapshot':
				// Answer only the webview that asked: opening the Signals panel
				// must not re-send (and re-lay out) the snapshot in the viewer.
				if (this.currentSnapshot) {
					await this.postSnapshot(this.currentSnapshot, 'request', source);
				}
				break;
			case 'loadSystemDescriptor':
				await this.runDescriptor(message.systemName);
				break;
			case 'runAnalysis':
				await this.runAnalysis(message.analysis, message.systemName);
				break;
			case 'runRMS':
				await this.runRMS(message);
				break;
			case 'updateSystemParameter':
				this.updateSystemParameter(message.parameterName, message.parameterValue);
				break;
			case 'openSignalsView':
				SignalsPanel.createOrShow(this.context, this);
				break;
			case 'openSource':
				await this.openSource(message.reference);
				break;
			case 'saveLayout':
				await this.saveLayout(message.layout);
				break;
			case 'selectUserWorkspace':
				await this.selectUserWorkspace();
				break;
			case 'selectBackendDirectory':
				await this.selectBackendDirectory();
				break;
		}
	}

	/** Publish the backend state; true when the selection fell back to the first system. */
	private async sendBackendInfo(): Promise<boolean> {
		let systems: string[] = [];
		if (this.backendProcess) {
			try {
				systems = await this.request<string[]>('getSystems', {});
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				this.log('backend', `${detail}`);
			}
		}
		// Backends list different systems (codesim classes, PESLite files): keep the
		// selection only when this backend offers it.
		const fellBack = systems.length > 0 && !systems.includes(this.selectedSystem);
		if (fellBack) {
			this.selectedSystem = systems[0];
		}
		await this.postToWebviews({
			type: 'backendInfo',
			systems,
			selectedSystem: this.selectedSystem,
			backendRunning: Boolean(this.backendProcess),
			running: Boolean(this.activeAction),
			userWorkspace: this.backendProcess ? this.appliedWorkspace : this.userWorkspace(),
			workspaceErrors: this.backendProcess ? this.workspaceErrors : 0,
			backendDirectory: this.backendDirectory(),
		});
		return fellBack;
	}

	private async startBackendFromUi(): Promise<void> {
		try {
			await this.startBackend();
			this.watchUserWorkspace();
			await this.applyUserWorkspace();
			// Selecting the system already shown in the dropdown fires no change event, so
			// load a fallback selection here; a backend offering the default keeps the old flow.
			if (await this.sendBackendInfo()) {
				await this.runDescriptor(this.selectedSystem);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Unable to start CodeSim backend: ${detail}`);
			await this.sendBackendInfo();
		}
	}

	private async runDescriptor(systemName: string | undefined): Promise<void> {
		const selected = await this.validateSystemName(systemName);
		if (selected) {
			this.parameterOverrides = {};
			await this.runBackend('descriptor', selected);
		}
	}

	private updateSystemParameter(name: string | undefined, value: unknown): void {
		if (name) {
			this.parameterOverrides[name] = value;
			this.log(
				'parameters',
				`${name} = ${brief(value)} (${Object.keys(this.parameterOverrides).length} override(s) pending)`,
			);
		}
	}

	private async runAnalysis(
		analysis: AnalysisKind | undefined,
		systemName: string | undefined,
	): Promise<void> {
		if (!analysis) {
			return;
		}
		const selected = await this.validateSystemName(systemName);
		if (!selected) {
			return;
		}
		await this.runBackend(analysis, selected);
	}

	private async runRMS(message: WebviewMessage): Promise<void> {
		const selected = await this.validateSystemName(message.systemName);
		if (!selected) {
			return;
		}
		const finite = (value: unknown) => (
			typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
		);
		await this.runBackend('rms', selected, {
			correction: message.correction === true,
			cutoff_Hz: finite(message.cutoff_Hz),
			maxStep_s: finite(message.maxStep_s),
		});
	}

	private async validateSystemName(systemName: string | undefined): Promise<string | undefined> {
		try {
			const systems = await this.request<string[]>('getSystems', {});
			const selected = systemName?.trim();
			if (!selected || !systems.includes(selected)) {
				const detail = `Unknown system "${selected ?? ''}". Select one of: ${systems.join(', ')}.`;
				this.log('backend', `${detail}`);
				void vscode.window.showErrorMessage(detail);
				return undefined;
			}
			this.selectedSystem = selected;
			return selected;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(detail);
			return undefined;
		}
	}

	/**
	 * Locate the backend: a source checkout (configured path or workspace folder)
	 * wins, so local edits are used; otherwise fall back to a `codesimpy` package
	 * installed into the selected interpreter (e.g. `pip install codesimpy`).
	 */
	private async resolveBackend(executable: string): Promise<Backend> {
		const { backend, candidates, configuredPaths, useInstalled } = this.findBackendCheckout();
		if (useInstalled) {
			this.log('backend', `${extensionNamespace}.${useInstalledBackendSetting} is on; skipping source checkouts`);
		}
		if (backend) {
			this.log('backend', `using source checkout: ${backend.cwd}`);
			this.runningBackendDirectory = backendDisplayDirectory(backend);
			return backend;
		}
		this.log('backend', `no source checkout in: ${candidates.join(' | ') || '(no folders)'}; probing installed package`);
		// Run outside any checkout so the import resolves to site-packages, and in
		// the user workspace so relative output paths land there.
		const cwd = this.existingWorkingDirectory();
		const installed = await this.findInstalledBackend(executable, cwd);
		if (installed) {
			this.log('backend', `using installed codesimpy: ${installed}`);
			// The origin is <site-packages>/codesimpy/api/cli.py.
			this.runningBackendDirectory = path.dirname(path.dirname(installed));
			return { cwd, module: 'codesimpy.api.cli' };
		}
		this.log('backend', `checked: ${candidates.join(' | ') || '(no folders)'}`);
		this.log('backend', `codesimpy.api.cli is not importable by ${executable}`);
		throw new Error(
			'Cannot find the CodeSim backend. Install it into the selected Python interpreter ' +
			'(pip install codesimpy), select another interpreter with "Python: Select Interpreter", ' +
			'or run "CodeSim: Select Backend" to use a source checkout. ' +
			`backendPath: ${[...configuredPaths].join(' | ') || '(empty)'}.`,
		);
	}

	/** Ask the interpreter where `codesimpy.api.cli` would be imported from. */
	/**
	 * A working directory that exists. Node reports a missing `cwd` as
	 * "spawn <python> ENOENT", which looks like a missing interpreter, so a stale
	 * `userWorkspace` setting (e.g. synced from another machine) must not reach spawn.
	 */
	private existingWorkingDirectory(): string {
		const userWorkspace = this.userWorkspace();
		const candidates = [
			userWorkspace,
			...(vscode.workspace.workspaceFolders ?? []).map(({ uri }) => uri.fsPath),
			os.homedir(),
		];
		const cwd = candidates.find((candidate) => candidate && isDirectory(candidate)) ?? os.tmpdir();
		if (userWorkspace && cwd !== userWorkspace) {
			this.log(
				'backend',
				`user workspace folder does not exist: ${userWorkspace}; running in ${cwd}. ` +
				`Fix the ${extensionNamespace}.${userWorkspaceSetting} setting or run "CodeSim: Select User Workspace Folder".`,
			);
		}
		return cwd;
	}

	private findInstalledBackend(executable: string, cwd: string): Promise<string | undefined> {
		const probe =
			'import importlib.util\n' +
			'spec = importlib.util.find_spec("codesimpy.api.cli")\n' +
			'print(spec.origin if spec and spec.origin else "")\n';
		return new Promise((resolve) => {
			execFile(
				executable, ['-c', probe],
				{
					cwd,
					timeout: 30_000,
					windowsHide: true,
					env: { ...globalThis.process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
				},
				(error, stdout, stderr) => {
					if (error) {
						this.log('backend', `probe failed (cwd ${cwd}): ${(stderr || error.message).trim()}`);
						resolve(undefined);
						return;
					}
					resolve(stdout.trim() || undefined);
				},
			);
		});
	}

	private findBackendCheckout(): {
		backend?: Backend;
		candidates: string[];
		configuredPaths: Set<string>;
		useInstalled: boolean;
	} {
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		const configuredPaths = new Set<string>();
		const useInstalled = vscode.workspace
			.getConfiguration(extensionNamespace, workspaceFolders[0]?.uri)
			.get<boolean>(useInstalledBackendSetting, false);
		if (useInstalled) {
			return { candidates: [], configuredPaths, useInstalled };
		}
		for (const uri of [undefined, ...workspaceFolders.map(({ uri }) => uri)]) {
			const configured = vscode.workspace
				.getConfiguration(extensionNamespace, uri)
				.get<string>('backendPath', '')
				.trim();
			if (configured) {
				configuredPaths.add(configured);
			}
		}
		const candidates: string[] = [];
		for (const configured of configuredPaths) {
			if (path.isAbsolute(configured)) {
				candidates.push(configured);
			} else {
				for (const { uri } of workspaceFolders) {
					candidates.push(path.resolve(uri.fsPath, configured));
				}
			}
		}
		for (const { uri } of workspaceFolders) {
			candidates.push(uri.fsPath, path.join(uri.fsPath, 'codesim'));
		}
		for (const candidate of candidates) {
			const backend = candidate ? detectBackend(candidate) : undefined;
			if (backend) {
				return { backend, candidates, configuredPaths, useInstalled };
			}
		}
		return { candidates, configuredPaths, useInstalled };
	}

	private async runBackend(
		action: 'descriptor' | AnalysisKind,
		systemName: string,
		analysisParameters: Record<string, unknown> = {},
	): Promise<void> {
		if (this.activeAction) {
			void vscode.window.showWarningMessage('A CodeSim Python task is already running.');
			return;
		}

		let failure: string | undefined;
		const started_ms = Date.now();
		try {
			this.activeAction = action;
			this.output.show(true);
			this.output.appendLine('');
			this.output.appendLine(`=== ${systemName} · ${action} · started ${new Date().toLocaleString()} ===`);
			const overrides = Object.entries(this.parameterOverrides);
			this.log('run', overrides.length
				? `parameter overrides (${overrides.length}): ` +
					overrides.map(([key, value]) => `${key}=${brief(value, 80)}`).join(', ')
				: 'parameter overrides: none (model defaults)');
			const options = Object.entries(analysisParameters).filter(([, value]) => value !== undefined);
			if (options.length) {
				this.log('run', `options: ${options.map(([key, value]) => `${key}=${brief(value, 80)}`).join(', ')}`);
			}
			await this.postToWebviews({
				type: 'backendStatus',
				running: true,
				action,
				selectedSystem: systemName,
			});
			const method = action === 'descriptor'
				? 'model.load'
				: action === 'simulation'
					? 'simulation.start'
					: action === 'smallSignal'
						? 'smallSignal.run'
						: action === 'interaction'
							? 'interaction.run'
							: 'rms.run';
			const result = await this.request<Record<string, unknown>>(method, {
				systemName,
				parameters: this.parameterOverrides,
				options: {},
				...analysisParameters,
			});
			if (typeof result.snapshotFile === 'string') {
				this.currentSnapshotUri = vscode.Uri.file(result.snapshotFile);
				this.log('run', `snapshot file: ${result.snapshotFile}`);
			}
			const reason: SnapshotReason = action === 'descriptor' ? 'load' : 'analysis';
			if (!(await this.acceptSnapshot(result.descriptor, reason))) {
				throw new Error('Python returned an invalid System descriptor.');
			}
			this.logSnapshotSummary(this.currentSnapshot);
			this.output.appendLine(`=== completed in ${formatDuration(started_ms)} ===`);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			failure = detail;
			this.output.appendLine(`=== failed after ${formatDuration(started_ms)} · ${detail} ===`);
			void vscode.window.showErrorMessage(`CodeSim backend failed: ${detail}`);
		} finally {
			this.activeAction = undefined;
			await this.postToWebviews({
				type: 'backendStatus',
				running: false,
				finishedAction: action,
				error: failure,
				selectedSystem: this.selectedSystem,
			});
		}
	}

	private async request<T extends Record<string, unknown> | string[]>(
		method: string,
		params: Record<string, unknown>,
	): Promise<T> {
		if (!this.backendProcess) {
			throw new Error('Start the CodeSim backend first.');
		}
		const id = this.nextRequestId++;
		const started_ms = Date.now();
		this.log('request', `#${id} → ${method}`);
		return await new Promise<T>((resolve, reject) => {
			this.pendingRequests.set(id, {
				resolve: (value) => {
					this.log('request', `#${id} ← ${method} ok (${formatDuration(started_ms)})`);
					resolve(value as T);
				},
				reject: (error) => {
					this.log('request', `#${id} ← ${method} failed (${formatDuration(started_ms)}): ${error.message}`);
					reject(error);
				},
			});
			this.backendProcess?.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}

	private async startBackend(): Promise<void> {
		if (this.backendProcess) {
			return;
		}
		if (this.backendStart) {
			return await this.backendStart;
		}
		this.backendStart = this.launchBackend().catch((error: unknown) => {
			this.backendStart = undefined;
			throw error;
		});
		return await this.backendStart;
	}

	private async launchBackend(): Promise<void> {
		const executable = await this.pythonExecutable();
		this.log('backend', `Python executable: ${executable}`);
		const backend = await this.resolveBackend(executable);
		this.log('backend', `module: ${backend.module}`);
		this.log('backend', `working directory: ${backend.cwd}`);
		await new Promise<void>((resolve, reject) => {
			// The backend protocol is UTF-8 JSON lines; never use the locale encoding (e.g. GBK).
			const env: NodeJS.ProcessEnv = {
				...globalThis.process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
			};
			// Keep bytecode caches out of site-packages: with a user workspace they go
			// to <workspace>/codegen/__pycache__, like the generated snapshots.
			const userWorkspace = this.userWorkspace();
			if (userWorkspace) {
				env.PYTHONPYCACHEPREFIX = path.join(userWorkspace, 'codegen', '__pycache__');
			}
			if (backend.pythonPath) {
				env.PYTHONPATH = [backend.pythonPath, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
				this.log('backend', `PYTHONPATH: ${env.PYTHONPATH}`);
			}
			if (env.PYTHONPYCACHEPREFIX) {
				this.log('backend', `bytecode cache: ${env.PYTHONPYCACHEPREFIX}`);
			}
			this.log('backend', `user workspace: ${userWorkspace ?? '(none)'}`);
			const process = spawn(executable, ['-u', '-m', backend.module], {
				cwd: backend.cwd, env, windowsHide: true, stdio: 'pipe',
			});
			this.backendProcess = process;
			process.stdout.setEncoding('utf8');
			process.stderr.setEncoding('utf8');
			process.stdout.on('data', (chunk: string) => this.readBackendOutput(chunk));
			process.stderr.on('data', (chunk: string) => this.output.append(chunk));
			process.once('spawn', () => {
				this.log('backend', `started (pid ${process.pid})`);
				this.setBackendStatus(true);
				resolve();
			});
			process.once('error', (error) => {
				this.log('backend', `failed to start: ${error.message}`);
				this.backendProcess = undefined;
				this.backendStart = undefined;
				this.setBackendStatus(false);
				reject(error);
			});
			process.once('close', (code, signal) => {
				const aborted = this.pendingRequests.size;
				this.log(
					'backend',
					`exited (code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}` +
					`${aborted ? `, ${aborted} request(s) aborted` : ''})`,
				);
				if (this.backendProcess === process) {
					this.backendProcess = undefined;
				}
				this.backendStart = undefined;
				this.activeAction = undefined;
				this.setBackendStatus(false);
				const error = new Error(`CodeSim Python backend exited with code ${code}.`);
				for (const pending of this.pendingRequests.values()) {
					pending.reject(error);
				}
				this.pendingRequests.clear();
				void this.postToWebviews({
					type: 'backendInfo',
					systems: [],
					selectedSystem: this.selectedSystem,
					backendRunning: false,
					running: false,
					userWorkspace: this.userWorkspace(),
					workspaceErrors: 0,
					backendDirectory: this.backendDirectory(),
				});
			});
		});
	}

	private async pythonExecutable(): Promise<string> {
		const extension = vscode.extensions.getExtension<PythonExtensionApi>(pythonExtensionId);
		if (!extension) {
			throw new Error(
				'Install and enable the Microsoft Python extension, then run "Python: Select Interpreter".',
			);
		}
		const pythonApi = extension.isActive ? extension.exports : await extension.activate();
		const workspace = vscode.workspace.workspaceFolders?.[0];
		const activeEnvironment = pythonApi?.environments
			.getActiveEnvironmentPath(workspace);
		if (!activeEnvironment) {
			throw new Error('Run "Python: Select Interpreter" before starting the CodeSim backend.');
		}
		const resolvedEnvironment = await pythonApi.environments
			.resolveEnvironment(activeEnvironment);
		const executable = resolvedEnvironment?.executable.uri?.fsPath;
		if (!executable || !fs.existsSync(executable)) {
			throw new Error(
				'The interpreter selected by the Microsoft Python extension is unavailable. ' +
				'Run "Python: Select Interpreter" and choose a valid environment.',
			);
		}
		return executable;
	}

	private readBackendOutput(chunk: string): void {
		this.backendBuffer += chunk;
		const lines = this.backendBuffer.split(/\r?\n/);
		this.backendBuffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) {
				continue;
			}
			try {
				const message = JSON.parse(line) as BackendResponse;
				this.backendMessageQueue = this.backendMessageQueue
					.then(() => this.handleBackendMessage(message))
					.catch((error) => {
						this.log('backend message', `${String(error)}`);
					});
			} catch {
				this.log('backend stdout', `${line}`);
			}
		}
	}

	private async handleBackendMessage(message: BackendResponse): Promise<void> {
		if (message.type) {
			this.logStreamEvent(message);
			if (message.type === 'simulation.started' && this.isSystemSnapshot(this.currentSnapshot)) {
				(this.currentSnapshot as Record<string, unknown>).signals = [];
			}
			if (message.type === 'simulation.chunk' && this.isSystemSnapshot(this.currentSnapshot)) {
				this.appendSimulationChunk(
					this.currentSnapshot as Record<string, unknown>,
					message.signals,
				);
			}
			// A streaming RMS run replaces the previous RMS result with a live
			// placeholder; the final descriptor arrives with the response.
			if (message.type === 'rms.started' && this.isSystemSnapshot(this.currentSnapshot)) {
				(this.currentSnapshot as Record<string, unknown>).rmsSimulation = liveRMSPlaceholder();
			}
			if (message.type === 'rms.chunk' && this.isSystemSnapshot(this.currentSnapshot)) {
				const snapshot = this.currentSnapshot as Record<string, unknown>;
				const rms = snapshot.rmsSimulation as Record<string, unknown> | undefined;
				if (rms?.streaming) {
					this.appendSimulationChunk(rms, message.signals);
				}
			}
			// Streaming events only matter to the Signals panel.
			await this.postToWebviews(
				message,
				message.type.startsWith('simulation.') || message.type.startsWith('rms.')
					? 'signals'
					: undefined,
			);
			return;
		}
		if (typeof message.id !== 'number') {
			return;
		}
		const pending = this.pendingRequests.get(message.id);
		if (!pending) {
			return;
		}
		this.pendingRequests.delete(message.id);
		if (message.ok) {
			pending.resolve(message.result ?? {});
		} else {
			pending.reject(new Error(message.error ?? 'Python backend request failed.'));
		}
	}

	private async stopBackend(): Promise<void> {
		const process = this.backendProcess;
		if (!process) {
			await this.sendBackendInfo();
			return;
		}
		const id = this.nextRequestId++;
		this.log('backend', `stopping (pid ${process.pid})`);
		process.stdin.write(`${JSON.stringify({ id, method: 'server.shutdown', params: {} })}\n`);
		setTimeout(() => {
			if (this.backendProcess === process) {
				process.kill();
			}
		}, 500).unref();
	}

	/**
	 * Fold one streamed chunk into the cached snapshot.
	 *
	 * Each trace keeps one array that grows in place; rebuilding the arrays
	 * per chunk ([...old, ...chunk]) made a run with N samples cost O(N²).
	 */
	private appendSimulationChunk(snapshot: Record<string, unknown>, incoming: unknown): void {
		if (!Array.isArray(incoming)) {
			return;
		}
		const signals = snapshot.signals as Array<Record<string, unknown>>;
		const byId = new Map(signals.map((signal) => [signal.id, signal]));
		for (const signal of incoming as Array<Record<string, unknown>>) {
			const existing = byId.get(signal.id);
			if (existing && Array.isArray(existing.time) && Array.isArray(existing.values)) {
				appendInPlace(existing.time, signal.time);
				appendInPlace(existing.values, signal.values);
			} else if (!existing) {
				// Copy so the cached trace never aliases the message being posted.
				const copy = {
					...signal,
					time: Array.isArray(signal.time) ? [...signal.time] : [],
					values: Array.isArray(signal.values) ? [...signal.values] : [],
				};
				signals.push(copy);
				byId.set(signal.id, copy);
			}
		}
	}

	private async postToWebviews(message: unknown, role?: WebviewRole): Promise<void> {
		await Promise.all(Array.from(this.webviews)
			.filter(([, webviewRole]) => !role || webviewRole === role)
			.map(([webview]) => webview.postMessage(message)));
	}

	/** Send a snapshot; the topology viewer gets it without analysis results. */
	private async postSnapshot(
		snapshot: unknown,
		reason: SnapshotReason,
		only?: vscode.Webview,
	): Promise<void> {
		let viewerMessage: unknown;
		await Promise.all(Array.from(this.webviews)
			.filter(([webview]) => !only || webview === only)
			.map(([webview, role]) => {
				if (role === 'viewer') {
					viewerMessage ??= {
						type: 'systemSnapshot',
						reason,
						snapshot: this.viewerSnapshot(snapshot),
					};
					return webview.postMessage(viewerMessage);
				}
				return webview.postMessage({ type: 'systemSnapshot', reason, snapshot });
			}));
	}

	private viewerSnapshot(snapshot: unknown): unknown {
		if (!snapshot || typeof snapshot !== 'object') {
			return snapshot;
		}
		const trimmed: Record<string, unknown> = { ...snapshot as Record<string, unknown> };
		for (const field of viewerOmittedSnapshotFields) {
			delete trimmed[field];
		}
		trimmed.signals = [];
		return trimmed;
	}

	private async acceptSnapshot(value: unknown, reason: SnapshotReason): Promise<boolean> {
		try {
			const snapshot = this.restoreOmittedFields(this.unwrapSnapshot(value));
			if (!this.isSystemSnapshot(snapshot)) {
				throw new Error(
					'The backend response does not contain system, components, connections, and signals.',
				);
			}
			this.currentSnapshot = snapshot;
			await this.postSnapshot(snapshot, reason);
			return true;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Unable to load the CodeSim model: ${detail}`);
			return false;
		}
	}

	/** Log one line per streaming milestone; chunks are only counted. */
	private logStreamEvent(message: BackendResponse): void {
		const type = message.type ?? '';
		if (type.endsWith('.chunk')) {
			this.streamChunks += 1;
			const signals = Array.isArray(message.signals)
				? message.signals as Array<Record<string, unknown>>
				: [];
			this.streamSamples += signals.reduce(
				(max, signal) => Math.max(max, Array.isArray(signal.time) ? signal.time.length : 0),
				0,
			);
			return;
		}
		if (type.endsWith('.started')) {
			this.streamChunks = 0;
			this.streamSamples = 0;
		}
		const extra = Object.entries(message)
			.filter(([key]) => key !== 'type' && key !== 'signals')
			.map(([key, value]) => `${key}=${brief(value, 80)}`)
			.join(', ');
		const progress = this.streamChunks
			? ` · ${this.streamChunks} chunk(s), ${this.streamSamples} sample(s) so far`
			: '';
		this.log('stream', `${type}${extra ? ` ${extra}` : ''}${progress}`);
	}

	/** Summarize what a loaded snapshot contains. */
	private logSnapshotSummary(snapshot: unknown): void {
		if (!this.isSystemSnapshot(snapshot)) {
			return;
		}
		const record = snapshot as Record<string, unknown>;
		const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
		const system = record.system as Record<string, unknown> | undefined;
		const name = typeof system?.name === 'string'
			? system.name
			: typeof system?.id === 'string' ? system.id : undefined;
		this.log(
			'result',
			`${name ? `${name}: ` : ''}${count(record.components)} component(s), ` +
			`${count(record.connections)} connection(s), ${count(record.signals)} signal(s)`,
		);
		const results = viewerOmittedSnapshotFields
			.filter((field) => field !== 'signals' && record[field] !== undefined && record[field] !== null);
		if (results.length) {
			this.log('result', `analysis results: ${results.join(', ')}`);
		}
	}

	private async saveLayout(layout: unknown): Promise<void> {
		if (!layout || typeof layout !== 'object') {
			void vscode.window.showErrorMessage('Unable to save the layout: invalid layout data.');
			return;
		}
		const snapshotUri = this.currentSnapshotUri;
		if (!snapshotUri) {
			this.log('layout', 'save skipped: no snapshot file is loaded');
			void vscode.window.showWarningMessage(
				'Load a System descriptor before saving the topology layout.',
			);
			return;
		}

		const temporaryUri = vscode.Uri.file(`${snapshotUri.fsPath}.CodeSim-layout.tmp`);
		try {
			const contents = await vscode.workspace.fs.readFile(snapshotUri);
			const document = JSON.parse(Buffer.from(contents).toString('utf8')) as unknown;
			if (!document || typeof document !== 'object') {
				throw new Error('The snapshot root is not a JSON object.');
			}
			const root = document as Record<string, unknown>;
			const descriptor = root.frontendDescriptor &&
				typeof root.frontendDescriptor === 'object'
				? root.frontendDescriptor as Record<string, unknown>
				: root;
			descriptor.layout = layout;
			const serialized = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
			await vscode.workspace.fs.writeFile(temporaryUri, serialized);
			await vscode.workspace.fs.rename(temporaryUri, snapshotUri, { overwrite: true });
			const savedPath = snapshotUri.fsPath;
			this.log('layout', `saved topology layout (${serialized.byteLength} bytes) to ${savedPath}`);
			const openFile = 'Open file';
			const reveal = 'Reveal in file explorer';
			const copyPath = 'Copy path';
			void vscode.window.showInformationMessage(
				`Saved topology layout to ${savedPath}`,
				openFile,
				reveal,
				copyPath,
			).then(async (choice) => {
				if (choice === openFile) {
					await vscode.window.showTextDocument(snapshotUri);
				} else if (choice === reveal) {
					await vscode.commands.executeCommand('revealFileInOS', snapshotUri);
				} else if (choice === copyPath) {
					await vscode.env.clipboard.writeText(savedPath);
				}
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			try {
				await vscode.workspace.fs.delete(temporaryUri);
			} catch {
				// The temporary file may not have been created.
			}
			this.log('layout', `failed to save to ${snapshotUri.fsPath}: ${detail}`);
			void vscode.window.showErrorMessage(
				`Unable to save the topology layout to ${snapshotUri.fsPath}: ${detail}`,
			);
		}
	}

	/**
	 * The backend leaves out heavy fields (signals, RMS result) that are
	 * unchanged since its previous response and lists them in `omittedFields`;
	 * take them from the cached snapshot.
	 */
	private restoreOmittedFields(value: unknown): unknown {
		if (!value || typeof value !== 'object') {
			return value;
		}
		const record = value as Record<string, unknown>;
		if (!Array.isArray(record.omittedFields)) {
			return value;
		}
		const previous = this.isSystemSnapshot(this.currentSnapshot)
			? this.currentSnapshot as Record<string, unknown>
			: undefined;
		const restored: Record<string, unknown> = { ...record };
		delete restored.omittedFields;
		for (const field of record.omittedFields) {
			if (typeof field === 'string' && previous && field in previous) {
				restored[field] = previous[field];
			}
		}
		return restored;
	}

	private unwrapSnapshot(value: unknown): unknown {
		if (!value || typeof value !== 'object') {
			return value;
		}
		const record = value as Record<string, unknown>;
		return record.frontendDescriptor ?? value;
	}

	private isSystemSnapshot(value: unknown): boolean {
		if (!value || typeof value !== 'object') {
			return false;
		}
		const record = value as Record<string, unknown>;
		return Boolean(record.system) &&
			Array.isArray(record.components) &&
			Array.isArray(record.connections) &&
			Array.isArray(record.signals);
	}

	private async openSource(reference: SourceReference | undefined): Promise<void> {
		if (!reference || typeof reference.file !== 'string') {
			return;
		}
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(reference.file));
			const editor = await vscode.window.showTextDocument(document);
			const line = Math.max(0, (reference.line ?? 1) - 1);
			const column = Math.max(0, (reference.column ?? 1) - 1);
			const position = new vscode.Position(line, column);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(
				new vscode.Range(position, position),
				vscode.TextEditorRevealType.InCenter,
			);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Unable to open source file: ${detail}`);
		}
	}
}

class CodeSimViewerProvider implements vscode.WebviewViewProvider {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly host: CodeSimHost,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [distUri],
		};
		view.webview.html = getHtml(this.context, view.webview, 'viewer');
		const unregister = this.host.registerWebview(view.webview, 'viewer');
		const messageSubscription = view.webview.onDidReceiveMessage(
			(message: WebviewMessage) => this.host.handleMessage(message, view.webview),
		);
		view.onDidDispose(() => {
			unregister();
			messageSubscription.dispose();
		});
	}
}

class SignalsPanel {
	private static current: SignalsPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly unregisterWebview: () => void;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		context: vscode.ExtensionContext,
		host: CodeSimHost,
	) {
		this.panel.webview.html = getHtml(context, this.panel.webview, 'signals');
		this.unregisterWebview = host.registerWebview(this.panel.webview, 'signals');
		this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
		this.panel.webview.onDidReceiveMessage(
			(message: WebviewMessage) => host.handleMessage(message, this.panel.webview),
			undefined,
			this.disposables,
		);
	}

	static createOrShow(context: vscode.ExtensionContext, host: CodeSimHost): void {
		if (SignalsPanel.current) {
			SignalsPanel.current.panel.reveal();
			return;
		}
		const distUri = vscode.Uri.joinPath(context.extensionUri, 'dist');
		const panel = vscode.window.createWebviewPanel(
			'CodeSimSignals',
			'CodeSim Signals',
			vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [distUri],
			},
		);
		SignalsPanel.current = new SignalsPanel(panel, context, host);
	}

	private dispose(): void {
		SignalsPanel.current = undefined;
		this.unregisterWebview();
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}
}

function getHtml(
	context: vscode.ExtensionContext,
	webview: vscode.Webview,
	mode: 'viewer' | 'signals',
): string {
	const distUri = vscode.Uri.joinPath(context.extensionUri, 'dist');
	const indexUri = vscode.Uri.joinPath(distUri, 'index.html');
	if (!fs.existsSync(indexUri.fsPath)) {
		return '<!doctype html><html><body><h1>CodeSim</h1><p>The webview has not been built. Run <code>npm run build</code>.</p></body></html>';
	}

	const csp = [
		"default-src 'none'",
		`img-src ${webview.cspSource} data:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`font-src ${webview.cspSource}`,
		`script-src ${webview.cspSource}`,
	].join('; ');

	return fs
		.readFileSync(indexUri.fsPath, 'utf8')
		.replace('<body>', `<body data-view="${mode}">`)
		.replace(
			/(src|href)="\.\/([^"#?]+)([^"]*)"/g,
			(_match, attribute: string, resource: string, suffix: string) => {
				const resourceUri = vscode.Uri.joinPath(distUri, ...resource.split('/'));
				return `${attribute}="${webview.asWebviewUri(resourceUri)}${suffix}"`;
			},
		)
		.replace('</head>', `<meta http-equiv="Content-Security-Policy" content="${csp}"></head>`);
}

export function deactivate(): void {}
