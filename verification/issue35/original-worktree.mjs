import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fromEnvironment,repo} from './configuration.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function snapshotOriginal(directory,execute=execFileSync){assert.ok(directory&&path.isAbsolute(directory),'Explicit absolute ISSUE35_ORIGINAL_WORKTREE is required');const cwd=fs.realpathSync(directory);const git=args=>execute('git',['-c','safe.directory='+cwd,...args],{cwd,encoding:'utf8',env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_'))),GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});
 const top=fs.realpathSync(git(['rev-parse','--show-toplevel']).trim());assert.equal(top,cwd,'Choose the original worktree root');
 const entries=[];function fingerprint(relative){const file=path.join(cwd,relative);assert.ok(!path.relative(cwd,file).startsWith('..'),'Path escaped original worktree');const s=fs.lstatSync(file);if(s.isSymbolicLink())entries.push([relative,'symlink',sha(fs.readlinkSync(file))]);else if(s.isDirectory()){for(const n of fs.readdirSync(file).sort())if(n!=='.git')fingerprint(path.join(relative,n));}else if(s.isFile())entries.push([relative,'file',sha(fs.readFileSync(file))]);}
 const paths=git(['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean);for(const name of [...new Set(paths)].sort())if(fs.existsSync(path.join(cwd,name)))fingerprint(name);
 return{directory:cwd,head:git(['rev-parse','HEAD']).trim(),status:git(['status','--porcelain=v1','-z','--untracked-files=all']),index:sha(git(['diff','--no-ext-diff','--no-textconv','--cached','--binary'])),tracked:sha(git(['diff','--no-ext-diff','--no-textconv','--binary'])),entries};
}
export function readOriginalBaseline(plan){const data=JSON.parse(fs.readFileSync(path.join(plan.runtime,'original-worktree.private.json'),'utf8'));assert.ok(data.directory,'Original worktree baseline is required');return data;}
export function assertOriginalUnchanged(plan){const before=readOriginalBaseline(plan);assert.deepEqual(snapshotOriginal(before.directory),before,'Original worktree changed');return before;}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){assert.equal(process.argv[2],'capture');const plan=fromEnvironment();const data=snapshotOriginal(process.env.ISSUE35_ORIGINAL_WORKTREE);const common=directory=>path.resolve(directory,execFileSync('git',['-c','safe.directory='+directory,'rev-parse','--git-common-dir'],{cwd:directory,encoding:'utf8'}).trim());assert.equal(fs.realpathSync(common(data.directory)),fs.realpathSync(common(repo)),'Original baseline must belong to the same repository');fs.mkdirSync(plan.runtime,{recursive:true});fs.writeFileSync(path.join(plan.runtime,'original-worktree.private.json'),JSON.stringify(data),{flag:'wx'});console.log('Original worktree baseline captured (contents omitted)');}
