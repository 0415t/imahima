import { execFileSync } from 'node:child_process';
import { ESLint } from 'eslint';

// Include tracked source and new source that Git does not ignore.
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
}).split('\0').filter(file => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file));

if (files.length === 0) throw new Error('No source files selected for lint');
const eslint = new ESLint({ errorOnUnmatchedPattern: true });
const results = await eslint.lintFiles([...new Set(files)]);
const formatter = await eslint.loadFormatter('stylish');
const output = await formatter.format(results);
if (output) console.log(output);
if (results.some(result => result.errorCount > 0)) process.exitCode = 1;
