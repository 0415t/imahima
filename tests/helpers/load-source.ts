import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Run native-facing source in Node with explicit substitutes for native APIs.
export function loadSource<T>(path: string, modules: Record<string, unknown>, globals = {}): T {
  const filename = resolve(path);
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    fileName: filename,
  }).outputText;
  const exports = {};
  runInNewContext(source, {
    exports, console,
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
      return modules[name];
    },
    ...globals,
  }, { filename });
  return exports as T;
}
