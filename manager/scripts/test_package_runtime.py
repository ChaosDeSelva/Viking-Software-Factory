"""Checks what package-runtime.py puts in a bundle, without building or packaging anything.

Run: python3 -m unittest discover -s manager/scripts
"""
import contextlib
import importlib.util
import io
import json
import subprocess
import re
import tempfile
import tomllib
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
spec = importlib.util.spec_from_file_location('package_runtime', HERE / 'package-runtime.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class LocalFactoryFiles(unittest.TestCase):
    def test_every_relative_import_of_factory_mjs_is_packaged(self):
        directory = REPO / 'outputs/local-factory'
        packaged = set(packager.local_factory_files(directory))
        source = (directory / 'factory.mjs').read_text()
        imports = re.findall(r'''from\s*['"](\./[^'"]+)['"]''', source)
        self.assertIn('./launcher.mjs', imports)
        for name in imports:
            self.assertIn((directory / name).resolve(), packaged, name)

    def test_follows_nested_and_dynamic_imports_but_not_out_of_the_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            directory = root / 'local-factory'
            (directory / 'lib').mkdir(parents=True)
            (directory / 'factory.mjs').write_text(
                "import { a } from './a.mjs';\nconst b = await import('./lib/b.mjs');\n"
                "const h = await import('../heimdall/main.mjs');\n"
            )
            (directory / 'a.mjs').write_text("import './lib/c.mjs';\nexport const a = 1;\n")
            (directory / 'lib/b.mjs').write_text("export * from '../a.mjs';\n")
            (directory / 'lib/c.mjs').write_text('')
            (directory / 'unused.mjs').write_text('')
            names = [p.relative_to(directory.resolve()).as_posix() for p in packager.local_factory_files(directory)]
            self.assertEqual(names, ['a.mjs', 'factory.mjs', 'lib/b.mjs', 'lib/c.mjs'])

    def test_a_missing_import_fails_packaging(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / 'factory.mjs').write_text("import { x } from './gone.mjs';\n")
            with self.assertRaises(FileNotFoundError):
                packager.local_factory_files(directory)


class SkidbladnirItems(unittest.TestCase):
    def test_local_file_dependencies_are_packaged_for_npm_ci(self):
        package = json.loads((REPO / 'outputs/skidbladnir/package.json').read_text())
        local = [v[len('file:'):] for v in package.get('dependencies', {}).values() if v.startswith('file:')]
        self.assertTrue(local)
        for path in local:
            self.assertIn(Path(path).parts[0], packager.SKIDBLADNIR_ITEMS, path)


class Arguments(unittest.TestCase):
    def test_version_is_required(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            packager.arguments(['--source', '.', '--output', '/nonexistent'])
        self.assertEqual(packager.arguments(['--source', '.', '--output', 'o', '--version', '0.3.0']).version, '0.3.0')


class CompanionVersion(unittest.TestCase):
    def test_info_plist_reports_the_cargo_package_version(self):
        script = (HERE / 'build-app.sh').read_text()
        self.assertIn('<key>CFBundleShortVersionString</key><string>$version</string>', script)
        self.assertNotIn("<<'PLIST'", script, 'a quoted heredoc would not expand $version')
        line = next(l for l in script.splitlines() if l.startswith('version='))
        result = subprocess.run(['bash', '-c', f'set -eu; root="$1"; {line}; printf %s "$version"', '-', str(HERE.parent)],
                                capture_output=True, text=True, check=True)
        cargo = tomllib.loads((HERE.parent / 'Cargo.toml').read_text())['package']['version']
        self.assertEqual(result.stdout, cargo)

    def test_build_number_follows_the_version_so_a_newer_companion_reads_as_newer(self):
        script = (HERE / 'build-app.sh').read_text()
        self.assertIn('<key>CFBundleVersion</key><string>$build_number</string>', script)
        lines = [l for l in script.splitlines() if l.startswith(('version=', 'build_number='))]
        self.assertEqual(len(lines), 2, 'build-app.sh derives build_number from version')

        def build_number(cargo_version):
            with tempfile.TemporaryDirectory() as root:
                Path(root, 'Cargo.toml').write_text(f'[package]\nname = "viking"\nversion = "{cargo_version}"\n')
                body = '; '.join(lines)
                return subprocess.run(['bash', '-c', f'set -eu; root="$1"; {body}; printf %s "$build_number"', '-', root],
                                      capture_output=True, text=True, check=True).stdout

        # CFBundleVersion takes at most three dot-separated integers.
        self.assertEqual(build_number('0.2.0'), '0.2.0')
        self.assertEqual(build_number('1.10.3'), '1.10.3')
        self.assertEqual(build_number('1.4.0-rc.1'), '1.4.0')
        self.assertEqual(build_number('1.4.0+build.7'), '1.4.0')


if __name__ == '__main__':
    unittest.main()
