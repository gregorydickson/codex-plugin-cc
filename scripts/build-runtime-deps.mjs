import { build } from 'esbuild';
import fs from 'node:fs';
await build({ stdin: { contents: 'export { default as Ajv } from "ajv"; export { default as Ajv2020 } from "ajv/dist/2020.js"; export { parse as parseToml } from "smol-toml";', resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', target: 'node18', minify: true, legalComments: 'eof', outfile: 'plugins/codex/scripts/vendor/runtime-deps.mjs' });
fs.writeFileSync('plugins/codex/scripts/vendor/LICENSES.txt', ['ajv/LICENSE', 'smol-toml/LICENSE', 'fast-deep-equal/LICENSE', 'fast-uri/LICENSE', 'json-schema-traverse/LICENSE', 'require-from-string/license'].map(file => `${file}\n${fs.readFileSync(`node_modules/${file}`, 'utf8')}`).join('\n\n'));
