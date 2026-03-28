# Qubic QPI Language Support

VS Code extension providing language support for **Qubic Smart Contracts** written with the Qubic Public Interface (QPI).

---

## Features

### Syntax Highlighting
- QPI control macros highlighted as keywords (`PUBLIC_PROCEDURE`, `BEGIN_EPOCH`, etc.)
- QPI built-in types styled as storage types (`id`, `sint64`, `uint64`, `Array`, etc.)
- QPI API calls styled as support functions (`qpi.transfer`, `qpi.K12`, etc.)
- Raw `#include` directives flagged visually as deprecated/invalid
- Raw `/` division operator flagged visually as illegal

### Snippets
| Prefix | Description |
|---|---|
| `qpi-contract` | Full contract skeleton with state, I/O structs, epoch/tick hooks, and registration |
| `qpi-procedure` | `PUBLIC_PROCEDURE` block |
| `qpi-function` | `PUBLIC_FUNCTION` block |
| `qpi-procedure-locals` | `PUBLIC_PROCEDURE_WITH_LOCALS` block |
| `qpi-function-locals` | `PUBLIC_FUNCTION_WITH_LOCALS` block |
| `qpi-epoch` | `BEGIN_EPOCH` / `END_EPOCH` block |
| `qpi-tick` | `BEGIN_TICK` / `END_TICK` block |

Snippets are available in both `qpi` and `cpp` language modes.

### Linter (Diagnostics)
The extension analyses `.h` files that contain QPI keywords and reports:

| Code | Severity | Rule |
|---|---|---|
| `QPI001` | Warning | `#include` directive found — not allowed in QPI contracts |
| `QPI002` | Warning | Raw `/` division operator — use `div(a, b)` instead |
| `QPI003` | Error | Raw `%` modulo operator — use `mod(a, b)` instead |

The linter runs on file open, save, and every keystroke.

### Command: New Smart Contract
**Command palette:** `Qubic: New Smart Contract`

Prompts for a contract name, generates a `.h` file with a complete QPI skeleton, and opens it in the editor.

---

## QPI-Specific Rules

### No `#include`
QPI contracts run inside the Qubic node sandbox. Standard library headers are unavailable and forbidden. Use QPI built-in types and the `qpi` API object exclusively.

### Integer Division and Modulo
The C++ `/` and `%` operators produce undefined behaviour for certain operands inside the Qubic execution environment. Always use:
- `div(dividend, divisor)` instead of `a / b`
- `mod(dividend, divisor)` instead of `a % b`

### `div()` and `mod()` are safe and valid
The linter flags raw `/` but does **not** flag `div()` or `mod()` — they are the recommended QPI idioms.

### Supported QPI API (`qpi.*`)
| Method | Description |
|---|---|
| `qpi.invocator()` | Identity of the direct caller |
| `qpi.originator()` | Identity of the transaction originator |
| `qpi.transfer(dest, amount)` | Transfer QU from contract to address |
| `qpi.burn(amount)` | Burn QU permanently |
| `qpi.K12(data)` | Qubic K12 hash function |
| `qpi.issueAsset(...)` | Issue a new asset |
| `qpi.transferShareOwnershipAndPossession(...)` | Transfer asset shares |
| `qpi.tick()` | Current tick number |
| `qpi.epoch()` | Current epoch number |
| `qpi.year() / month() / day()` | Current UTC date parts |
| `qpi.hour() / minute() / second()` | Current UTC time parts |

---

## Screenshot

![Qubic QPI Language Support](images/screenshot.png)

---

## Requirements

- VS Code `^1.85.0`
- No runtime dependencies

## Building from Source

```bash
npm install
npm run compile
npm run package   # produces .vsix
```

Install the `.vsix` via *Extensions: Install from VSIX* in VS Code.

---

## Feature-Roadmap

### Phase 1 - MVP (this release)
- [x] Syntax Highlighting (QPI keywords, macros, types)
- [x] Code Snippets (PUBLIC_PROCEDURE, PUBLIC_FUNCTION, contract skeleton)
- [x] Linter: Warning on `#include` and raw `/` division
- [x] "New Qubic SC" template command

### Phase 2 - Comfort
- [x] IntelliSense for all `qpi.*` functions
- [x] Hover documentation
- [x] Error squiggles (red underline for harder violations)

### Phase 3 - Power
- [ ] Dev Kit integration (deploy to testnet)
- [ ] Contract validator

## Marketplace

[Qubic QPI Language Support – VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AndyQus.qubic-org-qpi)

---

## Sources
- [QPI Documentation](https://docs.qubic.org/developers/qpi/)
- [Unofficial SC Guide](https://medium.com/@qsilver97/an-unofficial-guide-to-writing-qubic-smart-contracts-sc-774541a88610)
- [vscode-solidity as reference](https://github.com/juanfranblanco/vscode-solidity)
