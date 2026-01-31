// Mock for VS Code API
export const window = {
  showInformationMessage: jest.fn(),
  showWarningMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  createOutputChannel: jest.fn(() => ({
    appendLine: jest.fn(),
    append: jest.fn(),
    clear: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn()
  })),
  createTerminal: jest.fn(),
  showQuickPick: jest.fn(),
  showInputBox: jest.fn(),
  activeTextEditor: undefined,
  onDidCloseTerminal: jest.fn()
};

export const workspace = {
  getConfiguration: jest.fn(() => ({
    get: jest.fn((key: string, defaultValue?: any) => defaultValue),
    has: jest.fn(() => true),
    inspect: jest.fn(),
    update: jest.fn()
  })),
  workspaceFolders: [],
  onDidChangeConfiguration: jest.fn()
};

export const commands = {
  registerCommand: jest.fn(),
  executeCommand: jest.fn()
};

export const Uri = {
  file: jest.fn((path: string) => ({ fsPath: path, path })),
  parse: jest.fn((uri: string) => ({ fsPath: uri, path: uri }))
};

export const ViewColumn = {
  One: 1,
  Two: 2,
  Three: 3
};

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2
};

export class EventEmitter {
  fire = jest.fn();
  event = jest.fn();
  dispose = jest.fn();
}

export class TreeItem {
  constructor(
    public label: string,
    public collapsibleState?: number
  ) {}
}

export class Disposable {
  static from(...disposables: any[]) {
    return new Disposable();
  }
  dispose = jest.fn();
}
