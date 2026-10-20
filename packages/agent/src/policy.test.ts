import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { checkToolUse } from './policy';

const home = mkdtempSync(join(tmpdir(), 'mai-home-'));
const jobDir = join(home, 'mai', 'jobs', 'j1');
mkdirSync(join(jobDir, 'build'), { recursive: true });
mkdirSync(join(home, 'Documents'));
symlinkSync(join(home, 'Documents'), join(jobDir, 'docs'));
const ctx = { home, jobDir };
const bash = (command: string) => checkToolUse('Bash', { command }, ctx);

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

test('deletes with absolute paths inside the job folder need no approval', () => {
  expect(bash(`rm -rf ${jobDir}/build`)).toEqual({ allow: true });
  expect(bash(`rm ${jobDir}/a.txt ${jobDir}/b.txt && ls`)).toEqual({ allow: true });
  expect(bash('rm -rf ~/mai/jobs/j1/build')).toEqual({ allow: true });
});

test.each([
  ['relative path (Bash cwd is not visible to the hook)', 'rm -rf build'],
  ['the job folder itself', `rm -rf ${jobDir}`],
  ['escape with ..', `rm -rf ${jobDir}/../j2`],
  ['symlink pointing outside', `rm -rf ${jobDir}/docs/`],
  ['brace expansion', `rm -rf ${jobDir}/{a,../../x}`],
  ['glob', `rm -rf ${jobDir}/*`],
  ['variable', 'rm -rf $HOME/x'],
  ['command substitution', `rm -rf $(echo ${jobDir})`],
  ['quoted path', `rm -rf "${jobDir}/a b"`],
  ['one target outside', `rm ${jobDir}/a ${home}/b`],
  ['xargs', `ls ${jobDir} | xargs rm`],
  ['delete plus another risky command', `rm ${jobDir}/a && git push`],
  ['other user home', 'rm -rf ~root/x'],
])('deletes need approval: %s', (_, command) => {
  expect(bash(command)).toMatchObject({ allow: false, command });
});

test('without a job folder every delete needs approval', () => {
  expect(checkToolUse('Bash', { command: `rm ${jobDir}/a` }, { home }).allow).toBe(false);
});

test('reports which rule fired', () => {
  expect(bash('git push')).toMatchObject({ ruleId: 'git-push', reason: 'pushes to a remote' });
});

test('non-Bash tools are allowed', () => {
  expect(checkToolUse('Write', { file_path: '/tmp/x', content: 'rm -rf /' }, ctx)).toEqual({
    allow: true,
  });
});

const browser = (name: string, input: object) =>
  checkToolUse(`mcp__playwright__browser_${name}`, input, ctx);

test.each([
  ['click', { element: 'Buy now button', target: 'e12' }],
  ['click', { element: 'Place order', target: 'e3' }],
  ['click', { element: 'tlačítko Koupit', target: 'e3' }],
  ['click', { element: 'Odeslat objednávku', target: 'e9' }],
  ['type', { element: 'Message body', target: 'e4', text: 'hi', submit: true }],
  ['type', { element: 'Send message box', target: 'e4', text: 'hi' }],
  [
    'fill_form',
    {
      fields: [
        { name: 'Card number', type: 'textbox' },
        { name: 'Pay', type: 'button' },
      ],
    },
  ],
  ['evaluate', { function: '() => document.forms[0].submit()' }],
  ['run_code_unsafe', { code: 'await page.click("x")' }],
  ['file_upload', { paths: ['/Users/me/secret.pdf'] }],
])('web action needs approval: %s %j', (name, input) => {
  expect(browser(name, input).allow).toBe(false);
});

test.each([
  ['navigate', { url: 'https://www.alza.cz' }],
  ['snapshot', {}],
  ['click', { element: 'Sort by price, cheapest first', target: 'e5' }],
  ['click', { element: 'Next page link', target: 'e7' }],
  ['type', { element: 'Search box', target: 'e2', text: '1TB NVMe', submit: true }],
  ['press_key', { key: 'Enter' }],
])('web action allowed: %s %j', (name, input) => {
  expect(browser(name, input)).toEqual({ allow: true });
});

test('the card shows what the web action targets', () => {
  expect(browser('click', { element: 'Buy now button', target: 'e12' })).toMatchObject({
    ruleId: 'web-action',
    command: 'browser click: Buy now button',
  });
});
