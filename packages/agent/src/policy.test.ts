import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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

const context = join(home, 'context');
mkdirSync(join(context, 'projects'), { recursive: true });
writeFileSync(join(context, 'inbox.md'), '# Inbox\n- 2026-10-01 — old note\n');
writeFileSync(join(context, 'me.md'), '# Me\n');
const cctx = { home, jobDir, contextDir: context };
const tool = (name: string, input: object) => checkToolUse(name, input, cctx);
const sh = (command: string) => checkToolUse('Bash', { command }, cctx);

test('appending to the context inbox needs no approval', () => {
  expect(
    tool('Edit', {
      file_path: join(context, 'inbox.md'),
      old_string: '- 2026-10-01 — old note',
      new_string: '- 2026-10-01 — old note\n- 2026-10-20 — new note',
    }),
  ).toEqual({ allow: true });
  expect(sh(`echo "- 2026-10-20 — x" >> ${context}/inbox.md`)).toEqual({ allow: true });
  expect(sh('printf "x" >> ~/context/decisions.md')).toEqual({ allow: true });
  expect(sh(`cat ${context}/people.md; grep -r stockwatch ~/context`)).toEqual({ allow: true });
});

test.each([
  ['Write over the inbox', 'Write', { file_path: join(context, 'inbox.md'), content: 'x' }],
  [
    'Edit that rewrites an old line',
    'Edit',
    { file_path: join(context, 'inbox.md'), old_string: '# Inbox', new_string: '# Inbox\n- x' },
  ],
  [
    'Edit of a hot file',
    'Edit',
    { file_path: join(context, 'me.md'), old_string: '# Me', new_string: '# Me\n- x' },
  ],
  [
    'Write a new project file',
    'Write',
    { file_path: join(context, 'projects', 'x.md'), content: 'x' },
  ],
])('needs approval: %s', (_, name, input) => {
  expect(tool(name, input)).toMatchObject({ allow: false, ruleId: 'context-write' });
});

test.each([
  `echo x > ${context}/inbox.md`,
  'echo x > ~/context/now.md',
  'echo x >> ~/context/me.md',
  `sed -i '' 's/a/b/' ${context}/projects.md`,
  `cp notes.md ${context}/projects/`,
  'mv draft.md "$HOME/context/work.md"',
  'cd ~/context && git commit -am wip',
  'tee ~/context/inbox.md < x',
])('shell change needs approval: %s', (command) => {
  expect(sh(command)).toMatchObject({ allow: false, ruleId: 'context-write' });
});

test('with memory off the context folder is just part of ~', () => {
  const plain = checkToolUse(
    'Write',
    { file_path: join(context, 'me.md'), content: 'x' },
    { home },
  );
  expect(plain).toEqual({ allow: true });
});

test('the braced HOME variable spelling is caught too', () => {
  expect(sh(`echo x > "\${HOME}/context/now.md"`)).toMatchObject({ allow: false });
});

test('reading context notes never needs approval', () => {
  for (const [name, input] of [
    ['Read', { file_path: join(context, 'me.md') }],
    ['Grep', { pattern: 'stockwatch', path: context }],
    ['Glob', { pattern: '*.md', path: context }],
  ] as const) {
    expect(tool(name, input)).toEqual({ allow: true });
  }
});

test('the approval card shows what a notes change would write', () => {
  const d = tool('Edit', {
    file_path: join(context, 'me.md'),
    old_string: '# Me',
    new_string: '# Me\n- likes green tea',
  });
  expect(d).toMatchObject({ allow: false });
  expect(d.allow === false && d.command).toBe(
    `Edit ${join(context, 'me.md')}\n- # Me\n+ # Me\n+ - likes green tea`,
  );
});

const mcp = (name: string, input: object = {}) => checkToolUse(`mcp__${name}`, input, cctx);

test.each([
  'claude_ai_Gmail__search_threads',
  'claude_ai_Gmail__get_message',
  'claude_ai_Slack__slack_read_channel',
  'claude_ai_Slack__slack_search_public_and_private',
  'claude_ai_Atlassian__getJiraIssue',
  'claude_ai_Atlassian__searchJiraIssuesUsingJql',
  'claude_ai_Atlassian__atlassianUserInfo',
  'claude_ai_Google_Drive__read_file_content',
  'claude_ai_Claude_Docs__query',
  'playwright__browser_snapshot',
])('connector read is free: %s', (name) => {
  expect(mcp(name)).toEqual({ allow: true });
});

test.each([
  'claude_ai_Gmail__send_message',
  'claude_ai_Gmail__reply',
  'claude_ai_Gmail__create_draft',
  'claude_ai_Gmail__trash_thread',
  'claude_ai_Gmail__label_thread',
  'claude_ai_Slack__slack_send_message',
  'claude_ai_Slack__slack_add_reaction',
  'claude_ai_Atlassian__editJiraIssue',
  'claude_ai_Atlassian__transitionJiraIssue',
  'claude_ai_Atlassian__addCommentToJiraIssue',
  'claude_ai_Google_Drive__share_file',
  'claude_ai_Claude_Docs__delete',
  'claude_ai_Gmail__authenticate',
])('connector write asks: %s', (name) => {
  expect(mcp(name, { to: 'boss@example.com' })).toMatchObject({
    allow: false,
    ruleId: 'connector-write',
  });
});

test('tools from other MCP servers ask, and the card names the action', () => {
  expect(mcp('repo_tools__run_migration', { env: 'prod' })).toMatchObject({
    allow: false,
    ruleId: 'mcp-other',
  });
  expect(mcp('claude_ai_Gmail__send_message', { to: 'a@b.c' })).toMatchObject({
    command: 'Gmail send_message: {"to":"a@b.c"}',
  });
});
