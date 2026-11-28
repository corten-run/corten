"""The synthetic control boundary's own Git repository and the environment it runs on."""
import subprocess


def fixture_env(environ):
    """`environ` without any GIT_* variable, with no user or system Git config.

    A caller's GIT_DIR, GIT_WORK_TREE and the like choose a repository ahead of `-C`, so inherited
    they would make the setup below, and the controls run on this environment, rewrite and commit to
    the caller's repository. The synthetic host stands in for a fresh droplet, which has no Git
    variables at all, so all of them go, not only those scripts/fixture-git.mjs drops.
    """
    kept = {name: value for name, value in environ.items() if not name.upper().startswith('GIT_')}
    return dict(kept, HOME='/nonexistent', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')


def make_repo(repo, env):
    """Makes `repo` with one tracked sentinel and returns its commit and tree."""
    repo.mkdir()
    (repo / 'sentinel').write_text('synthetic tracked source\n')
    def git(args):
        return subprocess.run(['git', '-C', str(repo)] + args, env=env, check=True, capture_output=True, text=True).stdout.strip()
    git(['init', '--quiet'])
    git(['add', 'sentinel'])
    git(['-c', 'user.name=synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'synthetic'])
    return git(['rev-parse', 'HEAD']), git(['rev-parse', 'HEAD^{tree}'])