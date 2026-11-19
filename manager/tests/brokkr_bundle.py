"""Compare the managed Brokkr deployment with a built source checkout."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from zipfile import ZipFile

MANAGER = Path(__file__).resolve().parents[1]
SOURCE = MANAGER.parent / 'work/ecosystem/brokkr'
spec = importlib.util.spec_from_file_location('packager', MANAGER / 'scripts/package-runtime.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


def builtins(project, workspace):
    result = subprocess.run(
        ['node', str(project / 'apps/cli/dist/bin.js'), 'harness', 'list', '--json'],
        cwd=workspace, env={'PATH': os.environ['PATH'], 'BROKKR_HOME': str(workspace)},
        check=True, capture_output=True, text=True,
    )
    harnesses = json.loads(result.stdout)['harnesses']
    return {(h['name'], h['version'], h['digest']) for h in harnesses if h['source'] == 'builtin'}


class BrokkrBundle(unittest.TestCase):
    def test_extracted_cli_lists_the_same_builtin_harnesses_as_source(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp)
            core = workspace / 'staging/core'
            project = Path('work/ecosystem/brokkr')
            archive = workspace / 'core.zip'
            packager.deploy_brokkr(SOURCE, core / project)
            packager.archive_component(core, archive)
            with ZipFile(archive) as packed:
                self.assertEqual(packed.read(str(project / 'apps/cli/package.json')),
                                 (SOURCE / 'apps/cli/package.json').read_bytes())
                for item in packed.namelist():
                    self.assertNotIn('@file+', item)
                    self.assertNotIn('.turbo', Path(item).parts)
                    self.assertNotIn(Path(item).name, ('.modules.yaml', '.pnpm-workspace-state-v1.json'))
            shutil.rmtree(core)
            restored = workspace / 'releases/test/core'
            restored.mkdir(parents=True)
            subprocess.run(['unzip', '-q', str(archive), '-d', str(restored)], check=True)
            expected = builtins(SOURCE, workspace)
            self.assertTrue(expected, 'The source CLI should discover its built-in harnesses')
            self.assertEqual(builtins(restored / project, workspace), expected)


if __name__ == '__main__':
    unittest.main()
