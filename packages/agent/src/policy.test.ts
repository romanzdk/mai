import { expect, test } from 'vitest';
import { checkToolUse } from './policy';

const bash = (command: string) => checkToolUse('Bash', { command });

test.each([
  'rm -rf ~/Documents',
  'cd /tmp && rm file.txt',
  'ls; rmdir old',
  'find . -name "*.log" -delete',
  'sudo apt install x',
  'echo hi | sudo tee /etc/hosts',
  'git push origin main',
  'git clean -fdx',
  'git reset --hard HEAD~1',
  'git rm README.md',
  '(rm a)',
])('needs approval: %s', (command) => {
  expect(bash(command).allow).toBe(false);
});

test.each([
  'mkdir -p ~/Desktop/notes',
  'ls -la',
  'npm run format',
  'echo "confirm" > a.txt',
  'git status && git commit -m "x"',
  'grep -r firmware .',
])('allowed: %s', (command) => {
  expect(bash(command)).toEqual({ allow: true });
});

test('non-Bash tools are allowed', () => {
  expect(checkToolUse('Write', { file_path: '/tmp/x', content: 'rm -rf /' })).toEqual({
    allow: true,
  });
});
