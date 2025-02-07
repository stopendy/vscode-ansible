import * as cp from 'child_process';
import { StringDecoder } from 'string_decoder';

import * as vscode from 'vscode';

import { ThrottledDelayer } from './utils/async';

import * as nls from 'vscode-nls';
let localize = nls.loadMessageBundle();

const enum Setting {
	run = 'ansible.validate.run',
	checkedExecutablePath = 'ansible.validate.checkedExecutablePath',
	enable = 'ansible.validate.enable',
	executablePath = 'ansible.validate.executablePath',
}

export class LineDecoder {
	private stringDecoder: StringDecoder;
	private remaining: string | null;

	constructor(encoding: string = 'utf8') {
		this.stringDecoder = new StringDecoder(encoding);
		this.remaining = null;
	}

	public write(buffer: Buffer): string[] {
		let result: string[] = [];
		let value = this.remaining
			? this.remaining + this.stringDecoder.write(buffer)
			: this.stringDecoder.write(buffer);

		if (value.length < 1) {
			return result;
		}
		let start = 0;
		let ch: number;
		while (start < value.length && ((ch = value.charCodeAt(start)) === 13 || ch === 10)) {
			start++;
		}
		let idx = start;
		while (idx < value.length) {
			ch = value.charCodeAt(idx);
			if (ch === 13 || ch === 10) {
				result.push(value.substring(start, idx));
				idx++;
				while (idx < value.length && ((ch = value.charCodeAt(idx)) === 13 || ch === 10)) {
					idx++;
				}
				start = idx;
			} else {
				idx++;
			}
		}
		this.remaining = start < value.length ? value.substr(start) : null;
		return result;
	}

	public end(): string | null {
		return this.remaining;
	}
}

enum RunTrigger {
	onSave,
	onType
}

namespace RunTrigger {
	export let strings = {
		onSave: 'onSave',
		onType: 'onType'
	};
	export let from = function (value: string): RunTrigger {
		if (value === 'onType') {
			return RunTrigger.onType;
		} else {
			return RunTrigger.onSave;
		}
	};
}

export default class AnsibleValidationProvider {

	private static matchExpression: RegExp = /^(?<file>[^:]+):(?<line>\d+):(?<column>:(\d):)? (?<id>[\w-]+) (?<message>.*)/;
	///(?:(?:Parse|Fatal) error): (.*)(?: in )(.*?)(?: on line )(\d+)/;
	private static bufferArgs: string[] = ['--nocolor', '-p', '-'];
	//['-l', '-n', '-d', 'display_errors=On', '-d', 'log_errors=Off'];
	private static fileArgs: string[] = ['--nocolor', '-p'];
	//['-l', '-n', '-d', 'display_errors=On', '-d', 'log_errors=Off', '-f'];

	private validationEnabled: boolean;
	private executableIsUserDefined: boolean | undefined;
	private executable: string | undefined;
	private trigger: RunTrigger;
	private pauseValidation: boolean;

	private documentListener: vscode.Disposable | null = null;
	private diagnosticCollection?: vscode.DiagnosticCollection;
	private delayers?: { [key: string]: ThrottledDelayer<void> };

	constructor(private workspaceStore: vscode.Memento, private output: vscode.OutputChannel) {
		this.executable = undefined;
		this.validationEnabled = true;
		this.trigger = RunTrigger.onSave;
		this.pauseValidation = false;
		this.output = output;
		this.output.appendLine("init!");
	}

	public activate(subscriptions: vscode.Disposable[]) {
		this.diagnosticCollection = vscode.languages.createDiagnosticCollection();
		subscriptions.push(this);
		vscode.workspace.onDidChangeConfiguration(this.loadConfiguration, this, subscriptions);
		this.loadConfiguration();

		vscode.workspace.onDidOpenTextDocument(this.triggerValidate, this, subscriptions);
		vscode.workspace.onDidCloseTextDocument((textDocument) => {
			this.diagnosticCollection!.delete(textDocument.uri);
			delete this.delayers![textDocument.uri.toString()];
		}, null, subscriptions);
		subscriptions.push(vscode.commands.registerCommand('ansible.untrustValidationExecutable', this.untrustValidationExecutable, this));
	}

	public dispose(): void {
		if (this.diagnosticCollection) {
			this.diagnosticCollection.clear();
			this.diagnosticCollection.dispose();
		}
		if (this.documentListener) {
			this.documentListener.dispose();
			this.documentListener = null;
		}
	}

	private loadConfiguration(): void {
		let section = vscode.workspace.getConfiguration();
		let oldExecutable = this.executable;
		if (section) {
			this.validationEnabled = section.get<boolean>(Setting.enable, true);
			let inspect = section.inspect<string>(Setting.executablePath);
			if (inspect && inspect.workspaceValue) {
				this.executable = inspect.workspaceValue;
				this.executableIsUserDefined = false;
			} else if (inspect && inspect.globalValue) {
				this.executable = inspect.globalValue;
				this.executableIsUserDefined = true;
			} else {
				this.executable = undefined;
				this.executableIsUserDefined = undefined;
			}
			this.trigger = RunTrigger.from(section.get<string>(Setting.run, RunTrigger.strings.onSave));
		}
		if (this.executableIsUserDefined !== true && this.workspaceStore.get<string | undefined>(Setting.checkedExecutablePath, undefined) !== undefined) {
			vscode.commands.executeCommand('setContext', 'ansible.untrustValidationExecutableContext', true);
		}
		this.delayers = Object.create(null);
		if (this.pauseValidation) {
			this.pauseValidation = oldExecutable === this.executable;
		}
		if (this.documentListener) {
			this.documentListener.dispose();
			this.documentListener = null;
		}
		this.diagnosticCollection!.clear();
		if (this.validationEnabled) {
			if (this.trigger === RunTrigger.onType) {
				this.documentListener = vscode.workspace.onDidChangeTextDocument((e) => {
					this.triggerValidate(e.document);
				});
			} else {
				this.documentListener = vscode.workspace.onDidSaveTextDocument(this.triggerValidate, this);
			}
			// Configuration has changed. Reevaluate all documents.
			vscode.workspace.textDocuments.forEach(this.triggerValidate, this);
		}
	}

	private untrustValidationExecutable() {
		this.workspaceStore.update(Setting.checkedExecutablePath, undefined);
		vscode.commands.executeCommand('setContext', 'ansible.untrustValidationExecutableContext', false);
	}

	private triggerValidate(textDocument: vscode.TextDocument): void {

		if (textDocument.languageId !== 'yaml' || this.pauseValidation || !this.validationEnabled) {
			return;
		}
		this.output.appendLine(`Validating ${textDocument.fileName}`);

		interface MessageItem extends vscode.MessageItem {
			id: string;
		}

		let trigger = () => {
			let key = textDocument.uri.toString();
			let delayer = this.delayers![key];
			if (!delayer) {
				delayer = new ThrottledDelayer<void>(this.trigger === RunTrigger.onType ? 250 : 0);
				this.delayers![key] = delayer;
			}
			delayer.trigger(() => this.doValidate(textDocument));
		};

		if (this.executableIsUserDefined !== undefined && !this.executableIsUserDefined) {
			let checkedExecutablePath = this.workspaceStore.get<string | undefined>(Setting.checkedExecutablePath, undefined);
			if (!checkedExecutablePath || checkedExecutablePath !== this.executable) {
				vscode.window.showInformationMessage<MessageItem>(
					localize('ansible.useExecutablePath', 'Do you allow {0} (defined as a workspace setting) to be executed to lint Ansible files?', this.executable),
					{
						title: localize('ansible.yes', 'Allow'),
						id: 'yes'
					},
					{
						title: localize('ansible.no', 'Disallow'),
						isCloseAffordance: true,
						id: 'no'
					}
				).then(selected => {
					if (!selected || selected.id === 'no') {
						this.pauseValidation = true;
					} else if (selected.id === 'yes') {
						this.workspaceStore.update(Setting.checkedExecutablePath, this.executable);
						vscode.commands.executeCommand('setContext', 'ansible.untrustValidationExecutableContext', true);
						trigger();
					}
				});
				this.output.appendLine("Skipping");
				return;
			}
		}
		trigger();
	}

	private doValidate(textDocument: vscode.TextDocument): Promise<void> {
		return new Promise<void>((resolve) => {
			let executable = this.executable || 'ansible-lint';
			let decoder = new LineDecoder();
			let diagnostics: vscode.Diagnostic[] = [];
			let processLine = (line: string) => {
				let matches = line.match(AnsibleValidationProvider.matchExpression);
				this.output.appendLine(`Found:\n${matches}`);
				if (matches) {
					let message = matches.groups?.message ?? "unknown";
					let line = parseInt(matches.groups?.line ?? "1") - 1;
					let diagnostic: vscode.Diagnostic = new vscode.Diagnostic(
						new vscode.Range(line, 0, line, Number.MAX_VALUE),
						message
					);
					diagnostics.push(diagnostic);
				}
			};

			let options = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) ? { cwd: vscode.workspace.workspaceFolders[0].uri.fsPath } : undefined;
			let args: string[];
			if (this.trigger === RunTrigger.onSave) {
				args = AnsibleValidationProvider.fileArgs.slice(0);
				args.push(textDocument.fileName);
			} else {
				args = AnsibleValidationProvider.bufferArgs;
			}
			try {
				let childProcess = cp.spawn(executable, args, options);
				childProcess.on('error', (error: Error) => {
					this.output.appendLine(`Child process got ${error}`);
					if (this.pauseValidation) {
						resolve();
						return;
					}
					this.showError(error, executable);
					this.pauseValidation = true;
					resolve();
				});
				if (childProcess.pid) {
					if (this.trigger === RunTrigger.onType) {
						childProcess.stdin.write(textDocument.getText());
						childProcess.stdin.end();
					}
					childProcess.stdout.on('data', (data: Buffer) => {
						decoder.write(data).forEach(processLine);
					});
					childProcess.stdout.on('end', () => {
						let line = decoder.end();
						if (line) {
							processLine(line);
						}
						this.diagnosticCollection!.set(textDocument.uri, diagnostics);
						resolve();
					});
				} else {
					resolve();
				}
			} catch (error) {
				this.output.appendLine(`Catch error ${error}`);
				this.showError(error, executable);
			}
		});
	}

	private async showError(error: any, executable: string): Promise<void> {
		let message: string | null = null;
		if (error.code === 'ENOENT') {
			if (this.executable) {
				message = localize('wrongExecutable', 'Cannot validate since {0} is not a valid ansible-lint executable. Use the setting \'ansible.validate.executablePath\' to configure the ansible-lint executable.', executable);
			} else {
				message = localize('noExecutable', 'Cannot validate since no ansible-lint executable is set. Use the setting \'ansible.validate.executablePath\' to configure the ansible-lint executable.');
			}
		} else {
			message = error.message ? error.message : localize('unknownReason', 'Failed to run ansible-lint using path: {0}. Reason is unknown.', executable);
		}
		if (!message) {
			return;
		}

		const openSettings = localize('goToSetting', 'Open Settings');
		if (await vscode.window.showInformationMessage(message, openSettings) === openSettings) {
			vscode.commands.executeCommand('workbench.action.openSettings', Setting.executablePath);
		}
	}
}
