// Minimal loader that lets standalone Node test scripts require TypeScript
// source files directly (transpiled on the fly with the already-installed
// `typescript` devDependency). Only works for modules that do not import the
// Joplin `api` virtual module or native addons.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

require.extensions['.ts'] = function (module, filename) {
	const source = fs.readFileSync(filename, 'utf8');
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2018,
			esModuleInterop: true,
			strict: false,
		},
		fileName: filename,
	}).outputText;
	module._compile(output, filename);
};

module.exports = {
	srcRoot: path.resolve(__dirname, '..', '..', 'src'),
	load: (relative) => require(path.resolve(__dirname, '..', '..', 'src', relative)),
};