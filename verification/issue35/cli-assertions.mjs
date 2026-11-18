import assert from 'node:assert/strict';
export function assertUpToDate(output){assert.doesNotMatch(output,/no migrations found/i);assert.match(output,/^(?:Local|Remote) database is up to date\.\s*$/im);}
export function assertListing(output,versions){const pairs=[...output.replaceAll('`','').matchAll(/^\s*(\d{14})\s*\|\s*(\d{14})\s*\|/gm)].map(m=>[m[1],m[2]]);assert.deepEqual(pairs,versions.map(v=>[v,v]),'CLI must discover and match every local/remote migration');}
export function assertEnabled(config){assert.match(config,/\[db.migrations\]\s+enabled = true/,'Forward CLI test must enable migrations explicitly');}
