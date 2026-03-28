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
// QPI API definitions — shared by IntelliSense and hover provider
// ---------------------------------------------------------------------------
interface QpiMethod {
    name: string;
    signature: string;
    returns: string;
    description: string;
}

const QPI_METHODS: QpiMethod[] = [
    {
        name: 'invocator',
        signature: 'qpi.invocator()',
        returns: 'id',
        description: 'Returns the identity (`id`) of the **direct caller** of this contract invocation.',
    },
    {
        name: 'originator',
        signature: 'qpi.originator()',
        returns: 'id',
        description: 'Returns the identity (`id`) of the **originator** of the transaction (the entity that signed it).',
    },
    {
        name: 'transfer',
        signature: 'qpi.transfer(dest: id, amount: sint64)',
        returns: 'void',
        description: 'Transfers `amount` QU from this contract to `dest`. Returns `false` if the balance is insufficient.',
    },
    {
        name: 'burn',
        signature: 'qpi.burn(amount: sint64)',
        returns: 'void',
        description: 'Burns `amount` QU permanently — removes them from circulation.',
    },
    {
        name: 'K12',
        signature: 'qpi.K12(data: T)',
        returns: 'id',
        description: 'Computes the **Qubic K12 hash** of `data` and returns the result as an `id`.',
    },
    {
        name: 'issueAsset',
        signature: 'qpi.issueAsset(name: uint64, owner: id, unitOfMeasurement: sint64, numberOfDecimalPlaces: sint8)',
        returns: 'sint64',
        description: 'Issues a new asset on the Qubic network. Returns the number of issued shares, or a negative value on failure.',
    },
    {
        name: 'transferShareOwnershipAndPossession',
        signature: 'qpi.transferShareOwnershipAndPossession(assetName: uint64, issuer: id, owner: id, newOwner: id, numberOfShares: sint64)',
        returns: 'sint64',
        description: 'Transfers ownership and possession of `numberOfShares` asset shares. Returns the number of transferred shares.',
    },
    {
        name: 'tick',
        signature: 'qpi.tick()',
        returns: 'uint32',
        description: 'Returns the **current tick number** of the Qubic network.',
    },
    {
        name: 'epoch',
        signature: 'qpi.epoch()',
        returns: 'uint16',
        description: 'Returns the **current epoch number** of the Qubic network.',
    },
    {
        name: 'year',
        signature: 'qpi.year()',
        returns: 'uint16',
        description: 'Returns the **current UTC year** (e.g. 2025).',
    },
    {
        name: 'month',
        signature: 'qpi.month()',
        returns: 'uint8',
        description: 'Returns the **current UTC month** (1–12).',
    },
    {
        name: 'day',
        signature: 'qpi.day()',
        returns: 'uint8',
        description: 'Returns the **current UTC day of month** (1–31).',
    },
    {
        name: 'hour',
        signature: 'qpi.hour()',
        returns: 'uint8',
        description: 'Returns the **current UTC hour** (0–23).',
    },
    {
        name: 'minute',
        signature: 'qpi.minute()',
        returns: 'uint8',
        description: 'Returns the **current UTC minute** (0–59).',
    },
    {
        name: 'second',
        signature: 'qpi.second()',
        returns: 'uint8',
        description: 'Returns the **current UTC second** (0–59).',
    },
];

// Lookup map for hover provider
const QPI_METHOD_MAP = new Map<string, QpiMethod>(QPI_METHODS.map((m) => [m.name, m]));

// Documentation for QPI control keywords
const QPI_KEYWORD_DOCS: Record<string, string> = {
    PUBLIC_PROCEDURE:
        '**PUBLIC_PROCEDURE(Name)**\n\nDeclares a public procedure that can be called by external users. Procedures may modify contract state.\n\nUsage:\n```cpp\nPUBLIC_PROCEDURE(MyProc)\n{\n    // body\n}\n```',
    PUBLIC_FUNCTION:
        '**PUBLIC_FUNCTION(Name)**\n\nDeclares a read-only public function. Functions may NOT modify contract state.\n\nUsage:\n```cpp\nPUBLIC_FUNCTION(MyFunc)\n{\n    // body\n}\n```',
    PUBLIC_PROCEDURE_WITH_LOCALS:
        '**PUBLIC_PROCEDURE_WITH_LOCALS(Name)**\n\nSame as `PUBLIC_PROCEDURE` but allows declaring local variables in a `locals` block.',
    PUBLIC_FUNCTION_WITH_LOCALS:
        '**PUBLIC_FUNCTION_WITH_LOCALS(Name)**\n\nSame as `PUBLIC_FUNCTION` but allows declaring local variables in a `locals` block.',
    BEGIN_EPOCH:
        '**BEGIN_EPOCH**\n\nHook executed once at the **start of each epoch**. Use for epoch-level initialisation or settlement logic.',
    END_EPOCH:
        '**END_EPOCH**\n\nMarks the end of the `BEGIN_EPOCH` block. Must always follow `BEGIN_EPOCH`.',
    BEGIN_TICK:
        '**BEGIN_TICK**\n\nHook executed once **every tick**. Use for recurring per-tick logic.',
    END_TICK:
        '**END_TICK**\n\nMarks the end of the `BEGIN_TICK` block. Must always follow `BEGIN_TICK`.',
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES:
        '**REGISTER_USER_FUNCTIONS_AND_PROCEDURES**\n\nRegistration block where all public procedures and functions must be registered using `REGISTER_USER_PROCEDURE` and `REGISTER_USER_FUNCTION` macros.',
};

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

    // --- Phase 2: IntelliSense — qpi.* completion ---
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        [{ language: 'qpi' }, { language: 'cpp' }],
        {
            provideCompletionItems(
                document: vscode.TextDocument,
                position: vscode.Position,
            ): vscode.CompletionItem[] {
                if (!isQpiDocument(document)) {
                    return [];
                }

                const linePrefix = document.lineAt(position).text.slice(0, position.character);
                if (!linePrefix.endsWith('qpi.')) {
                    return [];
                }

                return QPI_METHODS.map((method) => {
                    const item = new vscode.CompletionItem(
                        method.name,
                        vscode.CompletionItemKind.Method,
                    );
                    item.detail = `${method.returns} ${method.signature}`;
                    item.documentation = new vscode.MarkdownString(method.description);
                    item.insertText = buildSnippet(method);
                    return item;
                });
            },
        },
        '.', // trigger on '.'
    );

    context.subscriptions.push(completionProvider);

    // --- Phase 2: Hover documentation ---
    const hoverProvider = vscode.languages.registerHoverProvider(
        [{ language: 'qpi' }, { language: 'cpp' }],
        {
            provideHover(
                document: vscode.TextDocument,
                position: vscode.Position,
            ): vscode.Hover | undefined {
                if (!isQpiDocument(document)) {
                    return undefined;
                }

                const range = document.getWordRangeAtPosition(position, /qpi\.\w+|\w+/);
                if (!range) {
                    return undefined;
                }

                const word = document.getText(range);

                // qpi.methodName hover
                const qpiMatch = word.match(/^qpi\.(\w+)$/);
                if (qpiMatch) {
                    const method = QPI_METHOD_MAP.get(qpiMatch[1]);
                    if (method) {
                        return buildMethodHover(method);
                    }
                }

                // QPI keyword hover (bare word like PUBLIC_PROCEDURE)
                const keywordDoc = QPI_KEYWORD_DOCS[word];
                if (keywordDoc) {
                    return new vscode.Hover(new vscode.MarkdownString(keywordDoc));
                }

                return undefined;
            },
        },
    );

    context.subscriptions.push(hoverProvider);
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
// isQpiDocument — true when the document looks like a QPI contract
// ---------------------------------------------------------------------------
function isQpiDocument(document: vscode.TextDocument): boolean {
    return document.fileName.endsWith('.h') && QPI_KEYWORD_REGEX.test(document.getText());
}

// ---------------------------------------------------------------------------
// buildSnippet — creates a SnippetString with tab-stops for method arguments
// ---------------------------------------------------------------------------
function buildSnippet(method: QpiMethod): vscode.SnippetString {
    // Extract parameter names from signature (everything inside the outer parens)
    const parenMatch = method.signature.match(/\(([^)]*)\)/);
    const paramStr = parenMatch ? parenMatch[1].trim() : '';

    if (!paramStr) {
        return new vscode.SnippetString(`${method.name}()`);
    }

    const params = paramStr.split(',').map((p) => p.trim().split(':')[0].trim());
    const tabStops = params.map((p, i) => `\${${i + 1}:${p}}`).join(', ');
    return new vscode.SnippetString(`${method.name}(${tabStops})`);
}

// ---------------------------------------------------------------------------
// buildMethodHover — creates a Hover card for a qpi.* method
// ---------------------------------------------------------------------------
function buildMethodHover(method: QpiMethod): vscode.Hover {
    const md = new vscode.MarkdownString();
    md.appendCodeblock(`${method.returns} ${method.signature}`, 'cpp');
    md.appendMarkdown('\n\n' + method.description);
    return new vscode.Hover(md);
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
        // Strip line comments and string literals before checking operators
        // ----------------------------------------------------------------
        const stripped = stripStringsAndComments(lineText);

        // ----------------------------------------------------------------
        // Rule 2: Warn on raw '/' division operator (use div() instead)
        // ----------------------------------------------------------------
        checkRawDivision(stripped, lineIndex, diagnostics);

        // ----------------------------------------------------------------
        // Rule 3 (Error): Raw '%' modulo operator — use mod() instead
        // ----------------------------------------------------------------
        checkRawModulo(stripped, lineIndex, diagnostics);
    }

    diagnosticCollection.set(document.uri, diagnostics);
}

// ---------------------------------------------------------------------------
// stripStringsAndComments
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
// checkRawDivision — QPI002 Warning
// ---------------------------------------------------------------------------
function checkRawDivision(
    stripped: string,
    lineIndex: number,
    diagnostics: vscode.Diagnostic[],
): void {
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
// checkRawModulo — QPI003 Error
// Raw '%' modulo produces undefined behaviour in the Qubic execution
// environment. Use mod(a, b) instead.
// ---------------------------------------------------------------------------
function checkRawModulo(
    stripped: string,
    lineIndex: number,
    diagnostics: vscode.Diagnostic[],
): void {
    // Match '%' that is not part of '%=' assignment
    const moduloRegex = /(?<!=)%(?!=)/g;
    let match: RegExpExecArray | null;

    while ((match = moduloRegex.exec(stripped)) !== null) {
        const col = match.index;
        const range = new vscode.Range(lineIndex, col, lineIndex, col + 1);
        const diagnostic = new vscode.Diagnostic(
            range,
            "Raw '%' modulo operator is forbidden in QPI contracts. Use mod(a, b) instead to avoid undefined behaviour.",
            vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = 'qubic-qpi';
        diagnostic.code = 'QPI003';
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
