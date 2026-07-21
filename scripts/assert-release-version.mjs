import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const tag = process.argv[2];
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (tag !== `v${pkg.version}`) {
  throw new Error(`Release tag ${tag ?? '<missing>'} does not match package version v${pkg.version}`);
}
