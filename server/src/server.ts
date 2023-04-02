/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	HoverParams,
	Definition,
	HandlerResult,
} from 'vscode-languageserver/node';

import {
	Position,
} from "vscode-languageserver-protocol";

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import fs = require("fs");
import tmp = require("tmp");
import path = require("path");

import util = require("node:util");
import { TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const exec = util.promisify(require("node:child_process").exec);

const tmpFile = tmp.fileSync();

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true
			},
			hoverProvider: true,
			definitionProvider: true,
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ExampleSettings>(
			(change.settings.nushellLanguageServer || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'nushellLanguageServer'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	// In this simple example we get the settings for every validate run.
	const settings = await getDocumentSettings(textDocument.uri);

	// The validator creates diagnostics for all uppercase words length 2 and more
	const text = textDocument.getText();
	const pattern = /\b[A-Z]{2,}\b/g;
	let m: RegExpExecArray | null;

	let problems = 0;
	const diagnostics: Diagnostic[] = [];
	while ((m = pattern.exec(text)) && problems < settings.maxNumberOfProblems) {
		problems++;
		const diagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Warning,
			range: {
				start: textDocument.positionAt(m.index),
				end: textDocument.positionAt(m.index + m[0].length)
			},
			message: `${m[0]} is all uppercase.`,
			source: 'ex'
		};
		if (hasDiagnosticRelatedInformationCapability) {
			diagnostic.relatedInformation = [
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range)
					},
					message: 'Spelling matters'
				},
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range)
					},
					message: 'Particularly for names'
				}
			];
		}
		diagnostics.push(diagnostic);
	}

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

function lowerBoundBinarySearch(arr: number[], num: number): number {
	let low = 0;
	let mid = 0;
	let high = arr.length - 1;

	if (num >= arr[high]) return high;

	while (low < high) {
		// Bitshift to avoid floating point division
		mid = (low + high) >> 1;

		if (arr[mid] < num) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}

	return low - 1;
}

function convertSpan(utf8_offset: number, lineBreaks: Array<number>): Position {
	const lineBreakIndex = lowerBoundBinarySearch(lineBreaks, utf8_offset);

	const start_of_line_offset =
		lineBreakIndex == -1 ? 0 : lineBreaks[lineBreakIndex] + 1;
	const character = Math.max(0, utf8_offset - start_of_line_offset);

	return { line: lineBreakIndex + 1, character };
}

function convertPosition(position: Position, text: string): number {
	let line = 0;
	let character = 0;
	const buffer = new TextEncoder().encode(text);

	let i = 0;
	while (i < text.length) {
		if (line == position.line && character == position.character) {
			return i;
		}

		if (buffer.at(i) == 0x0a) {
			line++;
			character = 0;
		} else {
			character++;
		}

		i++;
	}

	return i;
}

async function runCompiler(
	text: string,
	flags: string,
	settings: ExampleSettings,
	options: { allowErrors?: boolean } = {}
): Promise<string> {
	const allowErrors = options.allowErrors === undefined ? true : options.allowErrors;

	try {
		fs.writeFileSync(tmpFile.name, text);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} catch (e: any) {
		// connection.console.log(e);
	}

	let stdout = "";
	try {
		const output = await exec(
			`/Users/jt/Source/nushell/target/debug/nu ${flags} ${tmpFile.name}`,
			{
				timeout: 10000000,
			}
		);
		stdout = output.stdout;
		// console.log("stdout: " + stdout);
		// connection.console.log("stdout: " + stdout);
		// process.stdout.write("stdout: " + stdout);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} catch (e: any) {
		stdout = e.stdout;
		if (!allowErrors) {
			if (e.signal != null) {
				connection.console.log("compile failed: ");
				connection.console.log(e);
			} else {
				connection.console.log("Error:" + e);
			}
			throw e;
		}
	}

	return stdout;
}

connection.onHover(async (request: HoverParams) => {
	const document = documents.get(request.textDocument.uri);
	const settings = await getDocumentSettings(request.textDocument.uri);

	const text = document?.getText();

	if (!(typeof text == "string")) return null;

	// connection.console.log("request: ");
	// connection.console.log(request.textDocument.uri);
	// connection.console.log("index: " + convertPosition(request.position, text));
	const stdout = await runCompiler(
		text,
		"--ide-hover " +
		convertPosition(request.position, text),
		settings
	);

	const lines = stdout.split("\n").filter((l) => l.length > 0);
	for (const line of lines) {
		const obj = JSON.parse(line);
		// connection.console.log("hovering");
		// connection.console.log(obj);

		// FIXME: Figure out how to import `vscode` package in server.ts without
		// getting runtime import errors to remove this deprecation warning.
		const contents = {
			value: obj.hover,
			language: "nushell",
		};

		if (obj.hover != "") {
			return { contents };
		}
	}
});

// This handler provides the initial list of the completion items.
connection.onCompletion(async (request: TextDocumentPositionParams): Promise<CompletionItem[]> => {
	// The pass parameter contains the position of the text document in
	// which code complete got requested. For the example we ignore this
	// info and always provide the same completion items.

	const document = documents.get(request.textDocument.uri);
	const settings = await getDocumentSettings(request.textDocument.uri);

	const text = document?.getText();

	if (typeof text == "string") {
		// connection.console.log("completion request: ");
		// connection.console.log(request.textDocument.uri);
		const index = convertPosition(request.position, text);
		// connection.console.log("index: " + index);
		const stdout = await runCompiler(
			text,
			"--ide-complete " + index, //+ includeFlagForPath(request.textDocument.uri),
			settings
		);
		// connection.console.log("got: " + stdout);

		const lines = stdout.split("\n").filter((l) => l.length > 0);
		for (const line of lines) {
			const obj = JSON.parse(line);
			// connection.console.log("completions");
			// connection.console.log(obj);

			const output = [];
			let index = 1;
			for (const completion of obj.completions) {
				output.push({
					label: completion,
					kind: completion.includes("(")
						? CompletionItemKind.Function
						: CompletionItemKind.Field,
					data: index,
				});
				index++;
			}
			return output;
		}
	}

	return [];
});

connection.onDefinition(async (request) => {
	const document = documents.get(request.textDocument.uri);
	if (!document) return;
	const settings = await getDocumentSettings(request.textDocument.uri);

	const text = document.getText();

	// connection.console.log("request: ");
	// connection.console.log(request.textDocument.uri);
	// connection.console.log("index: " + convertPosition(request.position, text));
	const stdout = await runCompiler(
		text,
		"--ide-goto-def " +
		convertPosition(request.position, text),
		settings
	);
	return goToDefinition(document, stdout);
});

async function goToDefinition(
	document: TextDocument,
	nushellOutput: string
): Promise<HandlerResult<Definition, void> | undefined> {

	const lines = nushellOutput.split("\n").filter((l) => l.length > 0);
	for (const line of lines) {
		const obj = JSON.parse(line);
		// connection.console.log("going to type definition");
		// connection.console.log(obj);
		if (obj.file === "" || obj.file === "__prelude__") return;

		const lineBreaks = findLineBreaks(
			obj.file
				? (await fs.promises.readFile(obj.file)).toString()
				: document.getText() ?? ""
		);
		// const uri = obj.file ? "file://" + obj.file : document.uri;

		let uri = "";
		if (obj.file == tmpFile.name) {
			uri = document.uri;
		} else {
			uri = obj.file ? "file://" + obj.file : document.uri;
		}

		// connection.console.log(uri);

		return {
			uri: uri,
			range: {
				start: convertSpan(obj.start, lineBreaks),
				end: convertSpan(obj.end, lineBreaks),
			},
		};
	}
}


// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		if (item.data === 1) {
			item.detail = 'TypeScript details';
			item.documentation = 'TypeScript documentation';
		} else if (item.data === 2) {
			item.detail = 'JavaScript details';
			item.documentation = 'JavaScript documentation';
		}
		return item;
	}
);

function findLineBreaks(utf16_text: string): Array<number> {
	const utf8_text = new TextEncoder().encode(utf16_text);
	const lineBreaks: Array<number> = [];

	for (let i = 0; i < utf8_text.length; ++i) {
		if (utf8_text[i] == 0x0a) {
			lineBreaks.push(i);
		}
	}

	return lineBreaks;
}


// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
