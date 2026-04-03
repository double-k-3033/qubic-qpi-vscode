import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Smart contract detection — a .h file is a QPI contract if it inherits from
// ContractBase (e.g.  struct MyContract : public ContractBase).
// This naturally excludes qpi.h (which *defines* ContractBase) and plain
// C++ headers.
// ---------------------------------------------------------------------------
const QPI_CONTRACT_REGEX = /\bContractBase\b/;

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
        const workspaceFolders = vscode.workspace.workspaceFolders;

        let name: string | undefined;
        while (true) {
            name = await vscode.window.showInputBox({
                prompt: 'Enter contract name (e.g. MyContract)',
                validateInput: (v) =>
                    /^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? null : 'Use only letters, digits, and underscores',
            });

            if (!name) {
                return;
            }

            const candidateUri = workspaceFolders
                ? vscode.Uri.joinPath(workspaceFolders[0].uri, `${name}.h`)
                : vscode.Uri.file(path.join(os.homedir(), `${name}.h`));

            let exists = false;
            try {
                await vscode.workspace.fs.stat(candidateUri);
                exists = true;
            } catch {
                exists = false;
            }

            if (exists) {
                await vscode.window.showErrorMessage(
                    'A smart contract with the same name already exists, so please specify a different name',
                );
            } else {
                break;
            }
        }

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
    return document.fileName.endsWith('.h') && QPI_CONTRACT_REGEX.test(document.getText());
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

    // Skip files that do not inherit from ContractBase — not a smart contract
    if (!QPI_CONTRACT_REGEX.test(text)) {
        diagnosticCollection.delete(document.uri);
        return;
    }

    const diagnostics: vscode.Diagnostic[] = [];

    // Strip all comments from the full text for document-level rules.
    // Positions are preserved (content replaced with spaces, newlines kept).
    const strippedText = stripAllComments(text);

    // Collect struct/enum/class/namespace names for scope-operator check
    const definedNames = new Set<string>();
    const defRegex = /\b(?:struct|enum|class|namespace)\s+(\w+)/g;
    let defMatch: RegExpExecArray | null;
    while ((defMatch = defRegex.exec(strippedText)) !== null) {
        definedNames.add(defMatch[1]);
    }

    let inBlockComment = false;

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
        const lineText = document.lineAt(lineIndex).text;

        // Phase 1: strip comments (preserving string/char literals)
        const { result: commentFree, inBlockComment: nextState } =
            stripComments(lineText, inBlockComment);
        inBlockComment = nextState;

        // ----------------------------------------------------------------
        // QPI001: Preprocessor directives
        // ----------------------------------------------------------------
        if (/^\s*#/.test(commentFree)) {
            const col = commentFree.indexOf('#');
            const range = new vscode.Range(lineIndex, col, lineIndex, lineText.length);
            const diagnostic = new vscode.Diagnostic(
                range,
                'Preprocessor directives (#include, #define, etc.) are not allowed in QPI Smart Contracts.',
                vscode.DiagnosticSeverity.Warning,
            );
            diagnostic.source = 'qubic-qpi';
            diagnostic.code = 'QPI001';
            diagnostics.push(diagnostic);
            continue; // no further checks on this line
        }

        // ----------------------------------------------------------------
        // QPI004 / QPI005: string and char literals
        // Checked on comment-free text before strings are stripped.
        // ----------------------------------------------------------------
        checkStringLiteral(commentFree, lineIndex, diagnostics);
        checkCharLiteral(commentFree, lineIndex, diagnostics);

        // Phase 2: strip strings for operator / keyword checks
        const stripped = stripStrings(commentFree);

        // ----------------------------------------------------------------
        // Per-line operator and pattern checks
        // ----------------------------------------------------------------
        checkRawDivision(stripped, lineIndex, diagnostics);
        checkRawModulo(stripped, lineIndex, diagnostics);
        checkArraySubscript(stripped, lineIndex, diagnostics);
        checkEllipsis(stripped, lineIndex, diagnostics);
        checkScopeOperator(stripped, lineIndex, diagnostics, definedNames);
        checkPointerStar(stripped, lineIndex, diagnostics);
        checkDoubleUnderscore(stripped, lineIndex, diagnostics);
        checkProhibitedKeywords(stripped, lineIndex, diagnostics);
    }

    // ----------------------------------------------------------------
    // Contract-level validation (whole-document rules).
    // Uses strippedText so keywords inside comments are ignored.
    // ----------------------------------------------------------------
    validateContract(document, strippedText, diagnostics);

    diagnosticCollection.set(document.uri, diagnostics);
}

// ---------------------------------------------------------------------------
// validateContract — whole-document structural checks
// ---------------------------------------------------------------------------
function validateContract(
    document: vscode.TextDocument,
    text: string,
    diagnostics: vscode.Diagnostic[],
): void {
    // ----------------------------------------------------------------
    // Rule 4 (Error): BEGIN_EPOCH without END_EPOCH
    // Rule 5 (Error): BEGIN_TICK without END_TICK
    // ----------------------------------------------------------------
    checkBlockBalance(document, text, 'BEGIN_EPOCH', 'END_EPOCH', 'QPI010', diagnostics);
    checkBlockBalance(document, text, 'BEGIN_TICK', 'END_TICK', 'QPI011', diagnostics);

    // ----------------------------------------------------------------
    // Rule 6 (Warning): PUBLIC_PROCEDURE / PUBLIC_FUNCTION declared but
    // not registered in REGISTER_USER_FUNCTIONS_AND_PROCEDURES
    // ----------------------------------------------------------------
    checkUnregisteredEntrypoints(document, text, diagnostics);
}

// ---------------------------------------------------------------------------
// stripAllComments — removes // and /* */ comments from full document text.
// Preserves string/char literals so they are not misinterpreted as comments.
// Content is replaced with spaces; newlines are kept for positional accuracy.
// ---------------------------------------------------------------------------
function stripAllComments(text: string): string {
    let result = '';
    let i = 0;
    let inBlock = false;

    while (i < text.length) {
        if (inBlock) {
            if (text[i] === '*' && text[i + 1] === '/') {
                result += '  ';
                i += 2;
                inBlock = false;
            } else {
                result += text[i] === '\n' ? '\n' : ' ';
                i++;
            }
            continue;
        }

        // Block comment start
        if (text[i] === '/' && text[i + 1] === '*') {
            result += '  ';
            i += 2;
            inBlock = true;
            continue;
        }

        // Line comment — blank to end of line
        if (text[i] === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') {
                result += ' ';
                i++;
            }
            continue;
        }

        // Skip over string literals (preserve them)
        if (text[i] === '"') {
            result += text[i];
            i++;
            while (i < text.length && text[i] !== '"' && text[i] !== '\n') {
                if (text[i] === '\\') {
                    result += text[i];
                    i++;
                }
                result += text[i];
                i++;
            }
            if (i < text.length && text[i] === '"') {
                result += text[i];
                i++;
            }
            continue;
        }

        // Skip over char literals (preserve them)
        if (text[i] === "'") {
            result += text[i];
            i++;
            while (i < text.length && text[i] !== "'" && text[i] !== '\n') {
                if (text[i] === '\\') {
                    result += text[i];
                    i++;
                }
                result += text[i];
                i++;
            }
            if (i < text.length && text[i] === "'") {
                result += text[i];
                i++;
            }
            continue;
        }

        result += text[i];
        i++;
    }

    return result;
}

// ---------------------------------------------------------------------------
// stripComments — strips // and /* */ comments from a single line.
// Preserves string/char literals so they can be detected separately.
// Returns the cleaned line and the updated block-comment state.
// ---------------------------------------------------------------------------
function stripComments(
    line: string,
    inBlockComment: boolean,
): { result: string; inBlockComment: boolean } {
    let result = '';
    let i = 0;
    let inBlock = inBlockComment;

    while (i < line.length) {
        // Inside a block comment — scan for closing */
        if (inBlock) {
            if (line[i] === '*' && line[i + 1] === '/') {
                result += '  ';
                i += 2;
                inBlock = false;
            } else {
                result += ' ';
                i++;
            }
            continue;
        }

        // Line comment — blank out the rest of the line
        if (line[i] === '/' && line[i + 1] === '/') {
            result += ' '.repeat(line.length - i);
            break;
        }

        // Block comment start
        if (line[i] === '/' && line[i + 1] === '*') {
            result += '  ';
            i += 2;
            inBlock = true;
            continue;
        }

        // Skip over string literals (preserve them)
        if (line[i] === '"') {
            result += line[i];
            i++;
            while (i < line.length && line[i] !== '"') {
                if (line[i] === '\\') {
                    result += line[i];
                    i++;
                }
                result += line[i];
                i++;
            }
            if (i < line.length) {
                result += line[i]; // closing "
                i++;
            }
            continue;
        }

        // Skip over char literals (preserve them)
        if (line[i] === "'") {
            result += line[i];
            i++;
            while (i < line.length && line[i] !== "'") {
                if (line[i] === '\\') {
                    result += line[i];
                    i++;
                }
                result += line[i];
                i++;
            }
            if (i < line.length) {
                result += line[i]; // closing '
                i++;
            }
            continue;
        }

        result += line[i];
        i++;
    }

    return { result, inBlockComment: inBlock };
}

// ---------------------------------------------------------------------------
// stripStrings — strips "..." and '...' literals from (already comment-free)
// text.  Content is replaced with spaces to preserve column positions.
// ---------------------------------------------------------------------------
function stripStrings(line: string): string {
    let result = '';
    let i = 0;

    while (i < line.length) {
        if (line[i] === '"') {
            const start = i;
            i++;
            while (i < line.length && line[i] !== '"') {
                if (line[i] === '\\') {
                    i++;
                }
                i++;
            }
            i++; // consume closing "
            result += ' '.repeat(i - start);
            continue;
        }

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
// checkStringLiteral — QPI004 Error
// String literals ("...") are not supported in QPI contracts.
// ---------------------------------------------------------------------------
function checkStringLiteral(
    commentFree: string,
    lineIndex: number,
    diagnostics: vscode.Diagnostic[],
): void {
    for (let i = 0; i < commentFree.length; i++) {
        if (commentFree[i] !== '"') {
            continue;
        }
        const start = i;
        i++;
        while (i < commentFree.length && commentFree[i] !== '"') {
            if (commentFree[i] === '\\') {
                i++;
            }
            i++;
        }
        i++; // past closing "
        const range = new vscode.Range(lineIndex, start, lineIndex, Math.min(i, commentFree.length));
        const diagnostic = new vscode.Diagnostic(
            range,
            'String literals ("...") are not allowed in QPI contracts.',
            vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = 'qubic-qpi';
        diagnostic.code = 'QPI004';
        diagnostics.push(diagnostic);
    }
}

// ---------------------------------------------------------------------------
// checkCharLiteral — QPI005 Error
// Character literals ('...') are not supported in QPI contracts.
// ---------------------------------------------------------------------------
function checkCharLiteral(
    commentFree: string,
    lineIndex: number,
    diagnostics: vscode.Diagnostic[],
): void {
    for (let i = 0; i < commentFree.length; i++) {
        if (commentFree[i] !== "'") {
            continue;
        }
        const start = i;
        i++;
        while (i < commentFree.length && commentFree[i] !== "'") {
            if (commentFree[i] === '\\') {
                i++;
            }
            i++;
        }
        i++; // past closing '
        const range = new vscode.Range(lineIndex, start, lineIndex, Math.min(i, commentFree.length));
        const diagnostic = new vscode.Diagnostic(
            range,
            "Character literals ('...') are not allowed in QPI contracts.",
            vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = 'qubic-qpi';
        diagnostic.code = 'QPI005';
        diagnostics.push(diagnostic);
    }
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
// checkArraySubscript — QPI006 Error
// Array subscripts ([ ]) are not supported; use the QPI Array type.
// ---------------------------------------------------------------------------
function checkArraySubscript(
    stripped: string,
    lineIndex: number,
    diagnostics: vscode.Diagnostic[],
): void {
    for (let i = 0; i < stripped.length; i++) {
        if (stripped[i] === '[' || stripped[i] === ']') {
            const range = new vscode.Range(lineIndex, i, lineIndex, i + 1);
            const diagnostic = new vscode.Diagnostic(
                range,
                `Array subscript '${stripped[i]}' is not allowed in QPI contracts. Use the QPI Array type instead.`,
                vscode.DiagnosticSeverity.Error,
            );
            diagnostic.source = 'qubic-qpi';
            diagnostic.code = 'QPI006';
            diagnostics.push(diagnostic);
        }
    }
}

// ---------------------------------------------------------------------------
// checkEllipsis — QPI007 Error
// Variadic / ellipsis (...) is not supported in QPI contracts.
// ---------------------------------------------------------------------------
function checkEllipsis(
    stripped: string,
    lineIndex: number,
    diagnostics: vscode.Diagnostic[],
): void {
    let idx = stripped.indexOf('...');
    while (idx !== -1) {
        const range = new vscode.Range(lineIndex, idx, lineIndex, idx + 3);
        const diagnostic = new vscode.Diagnostic(
            range,
            "Variadic/ellipsis '...' is not allowed in QPI contracts.",
            vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = 'qubic-qpi';
        diagnostic.code = 'QPI007';
        diagnostics.push(diagnostic);
        idx = stripped.indexOf('...', idx + 3);
    }
}

// ---------------------------------------------------------------------------
// checkScopeOperator — QPI008 Warning
// '::' is only allowed for types defined in the same contract or qpi.h.
// ---------------------------------------------------------------------------
function checkScopeOperator(
    stripped: string,
    lineIndex: number,
    diagnostics: vscode.Diagnostic[],
    definedNames: Set<string>,
): void {
    const regex = /(?:(\w+)\s*)?::/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(stripped)) !== null) {
        const name = match[1];
        if (name && definedNames.has(name)) {
            continue; // OK — type defined in this contract
        }
        const col = match.index;
        const len = match[0].length;
        const range = new vscode.Range(lineIndex, col, lineIndex, col + len);
        const msg = name
            ? `'${name}::' refers to a type not defined in this contract. Scope operator '::' is only allowed for types defined in the contract or qpi.h.`
            : "Global scope operator '::' is not allowed in QPI contracts.";
        const diagnostic = new vscode.Diagnostic(
            range,
            msg,
            vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'qubic-qpi';
        diagnostic.code = 'QPI008';
        diagnostics.push(diagnostic);
    }
}

// Keywords that do not produce expression values — when followed by '*',
// the '*' is a pointer operator, not multiplication.
const NON_EXPR_KEYWORDS = new Set([
    'return', 'throw', 'case', 'goto', 'new', 'delete',
    'sizeof', 'alignof', 'typeof',
    'const', 'volatile', 'static', 'extern', 'register',
    'signed', 'unsigned', 'short', 'long',
    'void', 'int', 'char', 'bool',
    'sint8', 'sint16', 'sint32', 'sint64',
    'uint8', 'uint16', 'uint32', 'uint64',
    'id', 'bit',
]);

// ---------------------------------------------------------------------------
// checkPointerStar — QPI009 Error
// Pointer operators (* for dereference / declaration) are not allowed.
// Multiplication is permitted — distinguished by checking whether '*' has
// an expression-producing left operand.
// ---------------------------------------------------------------------------
function checkPointerStar(
    stripped: string,
    lineIndex: number,
    diagnostics: vscode.Diagnostic[],
): void {
    for (let i = 0; i < stripped.length; i++) {
        if (stripped[i] !== '*') {
            continue;
        }

        // Look left, skipping spaces, for an expression-end token
        let left = i - 1;
        while (left >= 0 && stripped[left] === ' ') {
            left--;
        }

        let isMultiplication = left >= 0 && /[\w)]/.test(stripped[left]);

        // If the preceding word is a keyword/type, it is a pointer decl
        if (isMultiplication && left >= 0 && /\w/.test(stripped[left])) {
            let wordStart = left;
            while (wordStart > 0 && /\w/.test(stripped[wordStart - 1])) {
                wordStart--;
            }
            const word = stripped.substring(wordStart, left + 1);
            if (NON_EXPR_KEYWORDS.has(word)) {
                isMultiplication = false;
            }
        }

        if (isMultiplication) {
            continue;
        }

        const range = new vscode.Range(lineIndex, i, lineIndex, i + 1);
        const diagnostic = new vscode.Diagnostic(
            range,
            "Pointer operator '*' is not allowed in QPI contracts. (Multiplication with '*' is OK.)",
            vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = 'qubic-qpi';
        diagnostic.code = 'QPI009';
        diagnostics.push(diagnostic);
    }
}

// ---------------------------------------------------------------------------
// checkDoubleUnderscore — QPI013 Error
// Double-underscore identifiers are reserved and not permitted.
// ---------------------------------------------------------------------------
function checkDoubleUnderscore(
    stripped: string,
    lineIndex: number,
    diagnostics: vscode.Diagnostic[],
): void {
    const regex = /__/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(stripped)) !== null) {
        const col = match.index;
        const range = new vscode.Range(lineIndex, col, lineIndex, col + 2);
        const diagnostic = new vscode.Diagnostic(
            range,
            "Double underscore '__' identifiers are reserved and not allowed in QPI contracts.",
            vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = 'qubic-qpi';
        diagnostic.code = 'QPI013';
        diagnostics.push(diagnostic);
    }
}

// ---------------------------------------------------------------------------
// checkProhibitedKeywords — QPI014 Error
// Certain C++ keywords and identifiers are forbidden in QPI contracts.
// ---------------------------------------------------------------------------
const PROHIBITED_KEYWORDS = ['double', 'float', 'typedef', 'union', 'const_cast', 'QpiContext'];

function checkProhibitedKeywords(
    stripped: string,
    lineIndex: number,
    diagnostics: vscode.Diagnostic[],
): void {
    for (const kw of PROHIBITED_KEYWORDS) {
        const regex = new RegExp(`\\b${kw}\\b`, 'g');
        let match: RegExpExecArray | null;

        while ((match = regex.exec(stripped)) !== null) {
            const col = match.index;
            const range = new vscode.Range(lineIndex, col, lineIndex, col + kw.length);
            const diagnostic = new vscode.Diagnostic(
                range,
                `'${kw}' is not allowed in QPI contracts.`,
                vscode.DiagnosticSeverity.Error,
            );
            diagnostic.source = 'qubic-qpi';
            diagnostic.code = 'QPI014';
            diagnostics.push(diagnostic);
        }
    }
}

// ---------------------------------------------------------------------------
// checkBlockBalance — ensures an opening macro has a matching closing macro
// e.g. BEGIN_EPOCH must be paired with END_EPOCH (QPI010)
//      BEGIN_TICK  must be paired with END_TICK  (QPI011)
// ---------------------------------------------------------------------------
function checkBlockBalance(
    document: vscode.TextDocument,
    text: string,
    openKeyword: string,
    closeKeyword: string,
    code: string,
    diagnostics: vscode.Diagnostic[],
): void {
    const openRegex = new RegExp(`\\b${openKeyword}\\b`, 'g');
    const closeRegex = new RegExp(`\\b${closeKeyword}\\b`, 'g');

    const openCount = (text.match(openRegex) ?? []).length;
    const closeCount = (text.match(closeRegex) ?? []).length;

    if (openCount === closeCount) {
        return;
    }

    // Find the line of the first unmatched opening keyword to anchor the diagnostic
    for (let i = 0; i < document.lineCount; i++) {
        const lineText = document.lineAt(i).text;
        if (new RegExp(`\\b${openKeyword}\\b`).test(lineText)) {
            const col = lineText.indexOf(openKeyword);
            const range = new vscode.Range(i, col, i, col + openKeyword.length);
            const diagnostic = new vscode.Diagnostic(
                range,
                openCount > closeCount
                    ? `'${openKeyword}' block is missing its closing '${closeKeyword}'.`
                    : `'${closeKeyword}' found without a matching '${openKeyword}'.`,
                vscode.DiagnosticSeverity.Error,
            );
            diagnostic.source = 'qubic-qpi';
            diagnostic.code = code;
            diagnostics.push(diagnostic);
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// checkUnregisteredEntrypoints — QPI012
// Every PUBLIC_PROCEDURE(Name) and PUBLIC_FUNCTION(Name) must appear in
// REGISTER_USER_PROCEDURE(Name, ...) or REGISTER_USER_FUNCTION(Name, ...)
// ---------------------------------------------------------------------------
function checkUnregisteredEntrypoints(
    document: vscode.TextDocument,
    text: string,
    diagnostics: vscode.Diagnostic[],
): void {
    // Collect all declared entrypoint names with their line positions
    const declaredRegex = /\bPUBLIC_(?:PROCEDURE|FUNCTION)(?:_WITH_LOCALS)?\s*\(\s*(\w+)\s*\)/g;
    const declared = new Map<string, number>(); // name → lineIndex
    let match: RegExpExecArray | null;

    while ((match = declaredRegex.exec(text)) !== null) {
        const name = match[1];
        if (!declared.has(name)) {
            const lineIndex = document.positionAt(match.index).line;
            declared.set(name, lineIndex);
        }
    }

    if (declared.size === 0) {
        return;
    }

    // Collect all registered names
    const registeredRegex = /\bREGISTER_USER_(?:PROCEDURE|FUNCTION)\s*\(\s*(\w+)\s*,/g;
    const registered = new Set<string>();

    while ((match = registeredRegex.exec(text)) !== null) {
        registered.add(match[1]);
    }

    // Flag each declared name that is not registered
    for (const [name, lineIndex] of declared) {
        if (registered.has(name)) {
            continue;
        }

        const lineText = document.lineAt(lineIndex).text;
        const col = lineText.indexOf(name);
        const range = new vscode.Range(
            lineIndex,
            col >= 0 ? col : 0,
            lineIndex,
            col >= 0 ? col + name.length : lineText.length,
        );
        const diagnostic = new vscode.Diagnostic(
            range,
            `'${name}' is declared but never registered. Add REGISTER_USER_PROCEDURE(${name}, <index>) or REGISTER_USER_FUNCTION(${name}, <index>) inside REGISTER_USER_FUNCTIONS_AND_PROCEDURES.`,
            vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'qubic-qpi';
        diagnostic.code = 'QPI012';
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
        `using namespace QPI;`,
        ``,
        `struct ${name} : public ContractBase`,
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
        `    // Procedure: Invoke`,
        separator,
        `    PUBLIC_PROCEDURE(Invoke)`,
        `    {`,
        `        state.mut().totalInvocations = state.get().totalInvocations + 1;`,
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
        ``,
        separator,
        `    // Initialization`,
        separator,
        `    INITIALIZE()`,
        `    {`,
        `    }`,
        `};`,
        ``,
    ];

    return lines.join('\n');
}
