import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// QPI keyword set — used to decide whether a .h file is a QPI contract
// ---------------------------------------------------------------------------
const QPI_KEYWORDS = [
    'PUBLIC_PROCEDURE',
    'PUBLIC_FUNCTION',
    'PUBLIC_PROCEDURE_WITH_LOCALS',
    'PUBLIC_FUNCTION_WITH_LOCALS',
    'BEGIN_EPOCH',
    'END_EPOCH',
    'BEGIN_TICK',
    'END_TICK',
    'REGISTER_USER_FUNCTIONS_AND_PROCEDURES',
];

const QPI_KEYWORD_REGEX = new RegExp(QPI_KEYWORDS.join('|'));

// ---------------------------------------------------------------------------
// Diagnostic collection (reused across all document updates)
// ---------------------------------------------------------------------------
let diagnosticCollection: vscode.DiagnosticCollection;

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
    diagnosticCollection = vscode.languages.createDiagnosticCollection('qubic-qpi');
    context.subscriptions.push(diagnosticCollection);

    // --- Command: create a new empty QPI contract file ---
    const newContractCmd = vscode.commands.registerCommand('qubic.newContract', async () => {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter contract name (e.g. MyContract)',
            validateInput: (v) =>
                /^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? null : 'Use only letters, digits, and underscores',
        });

        if (!name) {
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        const targetUri = workspaceFolders
            ? vscode.Uri.joinPath(workspaceFolders[0].uri, `${name}.h`)
            : vscode.Uri.file(path.join(os.homedir(), `${name}.h`));

        const contractTemplate = buildContractTemplate(name);

        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(contractTemplate, 'utf8'));
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc);
    });

    context.subscriptions.push(newContractCmd);

    // --- Lint on open, save, and change ---
    const lintOnOpen = vscode.workspace.onDidOpenTextDocument(lintDocument);
    const lintOnSave = vscode.workspace.onDidSaveTextDocument(lintDocument);
    const lintOnChange = vscode.workspace.onDidChangeTextDocument((e) => lintDocument(e.document));

    context.subscriptions.push(lintOnOpen, lintOnSave, lintOnChange);

    // Lint all already-open documents at activation time
    vscode.workspace.textDocuments.forEach(lintDocument);
}

// ---------------------------------------------------------------------------
// deactivate
// ---------------------------------------------------------------------------
export function deactivate(): void {
    if (diagnosticCollection) {
        diagnosticCollection.clear();
        diagnosticCollection.dispose();
    }
}

// ---------------------------------------------------------------------------
// lintDocument — produce diagnostics for a single document
// ---------------------------------------------------------------------------
function lintDocument(document: vscode.TextDocument): void {
    // Only process .h files that appear to contain QPI content
    if (!document.fileName.endsWith('.h')) {
        return;
    }

    const text = document.getText();

    // Skip files with no QPI keywords — likely plain C++ headers
    if (!QPI_KEYWORD_REGEX.test(text)) {
        diagnosticCollection.delete(document.uri);
        return;
    }

    const diagnostics: vscode.Diagnostic[] = [];

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
        const line = document.lineAt(lineIndex);
        const lineText = line.text;

        // ----------------------------------------------------------------
        // Rule 1: Warn on #include directives in QPI contracts
        // ----------------------------------------------------------------
        if (/^\s*#include\s*[<"]/.test(lineText)) {
            const startChar = lineText.indexOf('#include');
            const range = new vscode.Range(lineIndex, startChar, lineIndex, lineText.length);
            const diagnostic = new vscode.Diagnostic(
                range,
                '#include is not recommended in QPI Smart Contracts. Use QPI built-in types and functions instead.',
                vscode.DiagnosticSeverity.Warning,
            );
            diagnostic.source = 'qubic-qpi';
            diagnostic.code = 'QPI001';
            diagnostics.push(diagnostic);
            continue; // no further checks on this line
        }

        // ----------------------------------------------------------------
        // Rule 2: Warn on raw '/' division operator (use div() instead)
        // Strip line comments and string literals before checking.
        // ----------------------------------------------------------------
        const stripped = stripStringsAndComments(lineText);
        checkRawDivision(stripped, lineIndex, diagnostics);
    }

    diagnosticCollection.set(document.uri, diagnostics);
}

// ---------------------------------------------------------------------------
// stripStringsAndComments
// Replaces string literals and // comments with whitespace so that '/'
// characters inside strings or comments are not flagged as division.
// ---------------------------------------------------------------------------
function stripStringsAndComments(line: string): string {
    let result = '';
    let i = 0;

    while (i < line.length) {
        // Line comment — treat the rest of the line as whitespace
        if (line[i] === '/' && line[i + 1] === '/') {
            result += ' '.repeat(line.length - i);
            break;
        }

        // Double-quoted string literal
        if (line[i] === '"') {
            const start = i;
            i++;
            while (i < line.length && line[i] !== '"') {
                if (line[i] === '\\') {
                    i++; // skip escaped character
                }
                i++;
            }
            i++; // consume closing "
            result += ' '.repeat(i - start);
            continue;
        }

        // Single-quoted character literal
        if (line[i] === "'") {
            const start = i;
            i++;
            while (i < line.length && line[i] !== "'") {
                if (line[i] === '\\') {
                    i++;
                }
                i++;
            }
            i++; // consume closing '
            result += ' '.repeat(i - start);
            continue;
        }

        result += line[i];
        i++;
    }

    return result;
}

// ---------------------------------------------------------------------------
// checkRawDivision
// Looks for '/' that is NOT part of '//', '/*', '*/', or '/='.
// Each occurrence is reported as a warning recommending div().
// ---------------------------------------------------------------------------
function checkRawDivision(
    stripped: string,
    lineIndex: number,
    diagnostics: vscode.Diagnostic[],
): void {
    // Match a bare '/' not preceded or followed by '/', '*', or '='
    const divisionRegex = /(?<![/*=])\/(?![/*=])/g;
    let match: RegExpExecArray | null;

    while ((match = divisionRegex.exec(stripped)) !== null) {
        const col = match.index;
        const range = new vscode.Range(lineIndex, col, lineIndex, col + 1);
        const diagnostic = new vscode.Diagnostic(
            range,
            "Raw '/' division operator detected. Use div(a, b) instead to avoid undefined behaviour in QPI contracts.",
            vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'qubic-qpi';
        diagnostic.code = 'QPI002';
        diagnostics.push(diagnostic);
    }
}

// ---------------------------------------------------------------------------
// buildContractTemplate — generates a minimal QPI contract file
// ---------------------------------------------------------------------------
function buildContractTemplate(name: string): string {
    const today = new Date().toISOString().slice(0, 10);
    const separator = '    // ---------------------------------------------------------------';

    const lines: string[] = [
        `// Qubic Smart Contract: ${name}`,
        `// Created: ${today}`,
        `//`,
        `// This file uses the Qubic Public Interface (QPI).`,
        `// Do NOT use #include, raw division (/), or modulo (%) operators.`,
        `// Use div() and mod() for integer arithmetic instead.`,
        ``,
        `struct ${name}`,
        `{`,
        separator,
        `    // State variables`,
        separator,
        `    uint64 totalInvocations;`,
        ``,
        separator,
        `    // Input / Output structs`,
        separator,
        `    struct Invoke_input`,
        `    {`,
        `        uint64 amount;`,
        `    };`,
        ``,
        `    struct Invoke_output`,
        `    {`,
        `        uint64 result;`,
        `    };`,
        ``,
        separator,
        `    // Epoch hook`,
        separator,
        `    BEGIN_EPOCH`,
        `    {`,
        `    }`,
        `    END_EPOCH`,
        ``,
        separator,
        `    // Tick hook`,
        separator,
        `    BEGIN_TICK`,
        `    {`,
        `    }`,
        `    END_TICK`,
        ``,
        separator,
        `    // Procedure: Invoke`,
        separator,
        `    PUBLIC_PROCEDURE(Invoke)`,
        `    {`,
        `        totalInvocations = totalInvocations + 1;`,
        `        output.result = input.amount;`,
        `    }`,
        ``,
        separator,
        `    // Registration`,
        separator,
        `    REGISTER_USER_FUNCTIONS_AND_PROCEDURES`,
        `    {`,
        `        REGISTER_USER_PROCEDURE(Invoke, 1);`,
        `    }`,
        `};`,
        ``,
    ];

    return lines.join('\n');
}
