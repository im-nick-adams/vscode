/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { FileService } from '../../common/fileService.js';
import { InMemoryFileSystemProvider } from '../../common/inMemoryFilesystemProvider.js';
import { parseWatcherPatterns } from '../../common/watcher.js';
import { getWatcherExcludesFromGitIgnore, getWatcherExcludesFromIgnoredFolders, readGitIgnoreWatcherExcludes } from '../../common/watcherGitIgnore.js';

suite('Watcher .gitignore excludes', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('converts patterns relative to the watched folder', () => {
		assert.deepStrictEqual(getWatcherExcludesFromGitIgnore([
			'# Cargo output',
			'/target/',
			'/build',
			'node_modules',
			'.local/',
			'*.log',
			'src/generated/',
			'/dist/*.o',
			'**/coverage',
			'out/**',
			'/a/',
			'',
		].join('\n')), [
			'target/**/*',
			'build{,/**}',
			'node_modules{,/**}', '*/node_modules{,/**}', '*/*/node_modules{,/**}', '*/*/*/node_modules{,/**}',
			'.local/**/*', '*/.local/**/*', '*/*/.local/**/*', '*/*/*/.local/**/*',
			'*.log{,/**}', '*/*.log{,/**}', '*/*/*.log{,/**}', '*/*/*/*.log{,/**}',
			'src/generated/**/*',
			'dist/*.o{,/**}',
			'coverage{,/**}', '*/coverage{,/**}', '*/*/coverage{,/**}', '*/*/*/coverage{,/**}',
			'out/**/*',
			'a/**/*',
		]);
	});

	test('translates characters that globs treat specially', () => {
		assert.deepStrictEqual(getWatcherExcludesFromGitIgnore([
			'/\\#notes',
			'/{a,b}',
			'/file (1).txt',
			'/ leading',
			'/*.[oa]',
		].join('\n')), [
			'#notes{,/**}',
			'[{]a,b[}]{,/**}',
			'file [(]1[)].txt{,/**}',
			'[ ]leading{,/**}',
			'*.[oa]{,/**}',
		]);
	});

	test('skips patterns that a later negation may re-include', () => {
		assert.deepStrictEqual({
			negations: getWatcherExcludesFromGitIgnore([
				'node_modules',
				'*.log',
				'coverage/',
				'/build/*',
				'Keep',
				'!important.log',
				'!/src/coverage/',
				'!/build/keep/',
				'/out/',
			].join('\n')),
			tooManyNegations: getWatcherExcludesFromGitIgnore(['node_modules', ...Array.from({ length: 51 }, (_, i) => `!keep${i}`)].join('\n')),
		}, {
			negations: ['node_modules{,/**}', '*/node_modules{,/**}', '*/*/node_modules{,/**}', '*/*/*/node_modules{,/**}', 'out/**/*'],
			tooManyNegations: [],
		});
	});

	test('negations that use unsupported bracket expressions still skip the patterns before them', () => {
		assert.deepStrictEqual(getWatcherExcludesFromGitIgnore('*.txt\n![[:digit:]].txt\n/out/\n'), ['out/**/*']);
	});

	test('skips patterns that could exclude paths git does not ignore', () => {
		assert.deepStrictEqual(getWatcherExcludesFromGitIgnore([
			'/target/',
			'\\\\backslash',
			'C:/drive',
			'\\!bang',
			'*',
			'/*',
			'**/*',
			'*/',
			'.*',
			'.gitignore',
			'.git',
			'*[[:space:]]',
			'foo/**/',
			'./foo',
			'foo[',
			'[]a]',
			'/foo]',
			'/*.[!o]',
			'/c[+-0]d',
			'.GITIGNORE',
			'/.Git/',
			'/out',
		].join('\r\n')), ['target/**/*', 'out{,/**}']);
	});

	test('excludes match the expected paths of the watched folder', () => {
		// `tmp/` also matches a parent of the watched folder, which must not matter
		const folder = URI.file('/tmp/repo').fsPath;
		const excludes = parseWatcherPatterns(folder, getWatcherExcludesFromGitIgnore('/target/\nnode_modules/\ntmp/\n*.log\n'), false);
		const isExcluded = (path: string) => excludes.some(exclude => exclude(join(folder, path)));

		const paths = ['target', 'target/debug/build.rs', 'src/target/x', 'target.rs', 'node_modules', 'node_modules/x', 'packages/a/node_modules/x/index.js', 'a/b/c/d/node_modules/x', 'tmp/x', 'a/tmp/x', 'a/b/c/tmp/x', 'a.log', 'logs/b.log', 'a/b/c/d/e.log', 'src/main.rs', '.gitignore'];
		assert.deepStrictEqual(paths.filter(isExcluded), ['target/debug/build.rs', 'node_modules/x', 'packages/a/node_modules/x/index.js', 'tmp/x', 'a/tmp/x', 'a/b/c/tmp/x', 'a.log', 'logs/b.log']);
	});

	test('reads the .gitignore file at the root of the folder', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		const folder = URI.from({ scheme: Schemas.inMemory, path: '/repo' });

		const missing = await readGitIgnoreWatcherExcludes(fileService, folder);
		await fileService.writeFile(joinPath(folder, '.gitignore'), VSBuffer.fromString('/target/\n'));
		const present = await readGitIgnoreWatcherExcludes(fileService, folder);

		assert.deepStrictEqual({ missing, present }, { missing: [], present: ['target/**/*'] });
	});

	test('converts ignored folders into literal excludes, closest to the watched folder first', () => {
		assert.deepStrictEqual({
			literal: getWatcherExcludesFromIgnoredFolders(['crates/a/output/', 'target/', 'out/', 'out'], []),
			alreadyExcluded: getWatcherExcludesFromIgnoredFolders(['node_modules/', 'pkg/node_modules/', 'dist/'], ['node_modules{,/**}', '*/node_modules{,/**}']),
			globLike: getWatcherExcludesFromIgnoredFolders(['we[ir]d/', 'a{b}/', 'x*y/', 'q?/', '!neg/', 'a\\b/', 'c:d/', 'p(q)/'], []),
			gitFolders: getWatcherExcludesFromIgnoredFolders(['.git/', 'sub/.git/', '', '/'], []),
		}, {
			literal: ['target', 'out', 'crates/a/output'],
			alreadyExcluded: ['dist'],
			globLike: [],
			gitFolders: [],
		});
	});

	test('limits the excludes for ignored folders, keeping the folders closest to the watched folder', () => {
		const excludes = getWatcherExcludesFromIgnoredFolders([...Array.from({ length: 1000 }, (_, index) => `a/b/c${index}/`), 'top/'], []);

		assert.deepStrictEqual({ length: excludes.length, first: excludes[0], last: excludes.at(-1) }, { length: 1000, first: 'top', last: 'a/b/c998' });
	});
});
