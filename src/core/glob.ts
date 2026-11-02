// Minimal glob matcher for repository-relative POSIX paths (supports **, *, ?, {a,b}).
// VS Code 1.99 runs on Node 20, which lacks a stable path.matchesGlob.

const cache = new Map<string, RegExp>();

function toRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        const options = glob.slice(i + 1, end).split(',').map((o) => o.replace(/[.+^$()|[\]\\]/g, '\\$&'));
        re += `(?:${options.join('|')})`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

export function matchesGlob(path: string, glob: string): boolean {
  let regex = cache.get(glob);
  if (!regex) {
    regex = toRegExp(glob);
    cache.set(glob, regex);
  }
  return regex.test(path);
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob));
}
