#!/usr/bin/env node
'use strict';

/*
 * Verify that every translatable UI string is present in every po/<lang>/*.po
 * catalogue shipped by the applications in this repository.
 *
 * The check covers:
 *   - literal _(), t() and label() message ids in JavaScript views;
 *   - menu.d titles and rpcd ACL descriptions;
 *   - the dynamic labels and operator/region tables that are passed to _()
 *     at runtime and therefore cannot be found by a literal-only scanner.
 *
 * Chinese msgids are skipped for zh_Hans catalogues: those strings are already
 * Chinese and do not need a separate entry.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const APPS = [
	{
		dir: 'Luci-app/luci-app-avahi-publisher',
		extras: []
	},
	{
		dir: 'Luci-app/luci-app-fan',
		extras: []
	},
	{
		dir: 'Luci-app/luci-app-modemband',
		extras: [
			'China Mobile', 'China Unicom', 'China Telecom', 'China Broadnet',
			'China Mainland', 'Hong Kong', 'Macao', 'Taiwan'
		]
	},
	{
		dir: 'Luci-app/luci-app-sfp-status',
		extras: []
	},
	{
		dir: 'Luci-app/luci-app-traffic',
		extras: [
			'Since start', 'Last hour', 'Last 12 hours', 'Last 24 hours', 'Last 7 days'
		]
	},
	{
		dir: 'Luci-app/luci-app-turboacc-mtk',
		extras: []
	},
	{
		dir: 'Luci-app/luci-app-netpulse',
		extras: []
	}
];

function decodeJs(value) {
	return value.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (match, code) => {
		switch (code[0]) {
		case 'n': return '\n';
		case 'r': return '\r';
		case 't': return '\t';
		case 'b': return '\b';
		case 'f': return '\f';
		case 'v': return '\v';
		case '0': return '\0';
		case 'x':
		case 'u':
			return String.fromCodePoint(parseInt(code.slice(1), 16));
		default:
			return code;
		}
	});
}

function jsMessageIds(dir) {
	const ids = new Set();
	const pattern = /(?<![\w$.])(?:_|t|label)\(\s*(['"])((?:\\.|(?!\1).)*)\1/gs;

	function walk(current) {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);

			if (entry.isDirectory()) {
				walk(full);
			}
			else if (entry.isFile() && entry.name.endsWith('.js')) {
				const source = fs.readFileSync(full, 'utf8');

				for (const match of source.matchAll(pattern))
					ids.add(decodeJs(match[2]));
			}
		}
	}

	walk(path.join(dir, 'htdocs'));
	return ids;
}

function decodePo(value) {
	return value.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (match, code) => {
		switch (code[0]) {
		case 'n': return '\n';
		case 'r': return '\r';
		case 't': return '\t';
		case 'b': return '\b';
		case 'f': return '\f';
		case 'v': return '\v';
		case '0': return '\0';
		case 'x':
		case 'u':
			return String.fromCodePoint(parseInt(code.slice(1), 16));
		default:
			return code;
		}
	});
}

function poMessageIds(file) {
	const source = fs.readFileSync(file, 'utf8');
	const ids = new Set();
	const pattern = /^msgid ((?:"(?:[^"\\]|\\.)*"\n?)+)/gm;

	for (const match of source.matchAll(pattern)) {
		const parts = [ ...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g) ].map(part => part[1]);
		const id = decodePo(parts.join(''));

		if (id)
			ids.add(id);
	}

	return ids;
}

function menuAndAclIds(dir) {
	const ids = new Set();
	const menuDir = path.join(dir, 'root/usr/share/luci/menu.d');
	const aclDir = path.join(dir, 'root/usr/share/rpcd/acl.d');

	if (fs.existsSync(menuDir)) {
		for (const file of fs.readdirSync(menuDir)) {
			if (!file.endsWith('.json'))
				continue;

			const data = JSON.parse(fs.readFileSync(path.join(menuDir, file), 'utf8'));

			for (const entry of Object.values(data))
				if (entry && typeof entry === 'object' && typeof entry.title === 'string' && entry.title)
					ids.add(entry.title);
		}
	}

	if (fs.existsSync(aclDir)) {
		for (const file of fs.readdirSync(aclDir)) {
			if (!file.endsWith('.json'))
				continue;

			const data = JSON.parse(fs.readFileSync(path.join(aclDir, file), 'utf8'));

			for (const entry of Object.values(data))
				if (entry && typeof entry === 'object' && typeof entry.description === 'string' && entry.description)
					ids.add(entry.description);
		}
	}

	return ids;
}

function hasCjk(value) {
	return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

let failures = 0;

for (const app of APPS) {
	const dir = path.join(ROOT, app.dir);
	const wanted = new Set([
		...jsMessageIds(dir),
		...menuAndAclIds(dir),
		...app.extras
	]);

	const poRoot = path.join(dir, 'po');

	if (!fs.existsSync(poRoot)) {
		console.error(`${app.dir}: po/ directory is missing`);
		failures++;
		continue;
	}

	for (const lang of fs.readdirSync(poRoot).sort()) {
		if (lang === 'templates')
			continue;

		const langDir = path.join(poRoot, lang);

		if (!fs.statSync(langDir).isDirectory())
			continue;

		const poFiles = fs.readdirSync(langDir).filter(file => file.endsWith('.po')).sort();

		if (!poFiles.length) {
			console.error(`${app.dir}: po/${lang}/ has no .po files`);
			failures++;
			continue;
		}

		const translated = new Set();

		for (const file of poFiles)
			for (const id of poMessageIds(path.join(langDir, file)))
				translated.add(id);

		const missing = [ ...wanted ].filter(id => !translated.has(id) && !(lang === 'zh_Hans' && hasCjk(id))).sort();

		if (missing.length) {
			console.error(`${app.dir} [${lang}]: ${missing.length} missing message id(s)`);

			for (const id of missing)
				console.error(`  ${JSON.stringify(id)}`);

			failures += missing.length;
		}
		else {
			console.log(`${app.dir} [${lang}]: ${wanted.size} message ids covered`);
		}
	}
}

if (failures) {
	console.error(`\n${failures} missing translation message id(s).`);
	process.exit(1);
}

console.log('\nAll translatable message ids are present in every catalogue.');
