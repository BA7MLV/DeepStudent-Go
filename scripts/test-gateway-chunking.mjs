import assert from 'node:assert/strict';
import { splitGatewayMarkdown } from '../apps/api/src/gateway/chunk.ts';

const count = text => Array.from(text).length;

{
  const parts = splitGatewayMarkdown('第一段内容。\n\n第二段内容。\n\n第三段内容。', 12);
  assert.deepEqual(parts, ['第一段内容。', '第二段内容。', '第三段内容。']);
}

{
  const source = `说明文字。\n\n\`\`\`ts\n${'const value = "长代码";\n'.repeat(20)}\`\`\``;
  const parts = splitGatewayMarkdown(source, 80);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => count(part) <= 80), JSON.stringify(parts.map(count)));
  assert.ok(parts.every(part => part.startsWith('说明') || part.startsWith('```ts')));
  assert.ok(parts.every(part => part.includes('```')));
}

{
  const emoji = '👨‍👩‍👧‍👦'.repeat(100);
  const parts = splitGatewayMarkdown(emoji, 25);
  assert.ok(parts.every(part => !part.includes('\u200d') || part.includes('👨‍👩‍👧‍👦')));
  assert.equal(parts.join(''), emoji);
}

{
  const formula = `${'说明 '.repeat(30)}$a+b=c$${' 继续'.repeat(30)}`;
  const parts = splitGatewayMarkdown(formula, 120);
  assert.equal(parts.filter(part => part.includes('$a+b=c$')).length, 1);
}

{
  // Production regression: the last two job rows used to arrive without a header.
  const header = '| 地区 | 单位/职位 | 职位代码 |\n|---|---|---:|\n';
  const rows = Array.from({ length: 32 }, (_, i) => `| 地区${i} | 某单位内设机构办公室综合业务一级科员${i} | ${11901982757001 + i} |`);
  const tail = '\n\n另外还有一批公安岗位需要额外核查：\n\n- 年龄要求；\n- 体能测评和体检。\n\n这属于**专业和基本条件初筛**。';
  const parts = splitGatewayMarkdown(`初筛结果如下。\n\n${header}${rows.join('\n')}${tail}`, 1500);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => count(part) <= 1500));
  const actualRows = [];
  for (const part of parts) {
    if (part.includes('| 地区')) assert.ok(part.includes(header.trimEnd()), 'each table part repeats its header and delimiter');
    actualRows.push(...part.split('\n').filter(line => /^\| 地区\d+ /.test(line)));
  }
  assert.deepEqual(actualRows, rows, 'every data row survives exactly once in order');
  assert.ok(parts.join('\n\n').includes(tail.trim()));
}

{
  const table = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
  const parts = splitGatewayMarkdown(`说明文字。\n\n${table}\n\n${'后续说明。'.repeat(10)}`, 42);
  assert.equal(parts[0], '说明文字。', 'a fitting table starts in a new message even below the low watermark');
  assert.equal(parts[1], table);
}

{
  const header = '地区 | 说明\n:--- | ---:\n';
  const rows = Array.from({ length: 10 }, (_, i) => `地区${i} | 带有\\|符号和\`a|b\`的内容${i}`);
  const parts = splitGatewayMarkdown(`${header}${rows.join('\n')}\n\n结束。`, 110);
  assert.ok(parts.every(part => count(part) <= 110));
  const tableParts = parts.filter(part => part.includes('地区 | 说明'));
  assert.ok(tableParts.length > 1);
  assert.ok(tableParts.every(part => part.startsWith(header)));
  assert.deepEqual(tableParts.flatMap(part => part.split('\n').filter(line => /^地区\d+ \|/.test(line))), rows);
}

{
  const value = `| 姓名 | 说明 |\n|---|---|\n| 小明 | ${'很长的描述'.repeat(30)} |\n\n结尾文字。`;
  const parts = splitGatewayMarkdown(value, 60);
  assert.ok(parts.every(part => count(part) <= 60));
  assert.ok(parts.join('').includes('姓名：小明'));
  assert.ok(parts.join('').includes('说明：'));
  assert.equal(parts.join('').match(/很长的描述/g).length, 30);
  assert.ok(parts.at(-1).endsWith('结尾文字。'));
}

{
  const source = `\`\`\`md\n| A | B |\n|---|---|\n${'| 1 | 2 |\n'.repeat(12)}\`\`\``;
  const parts = splitGatewayMarkdown(source, 70);
  assert.ok(parts.every(part => count(part) <= 70));
  assert.equal(parts.join('\n').match(/\|---\|---\|/g).length, 1, 'literal code tables must not gain repeated headers');
}

for (const limit of [48, 60, 99, 120, 1500]) {
  const header = '| 地区 | 说明 |\r\n|:---|---:|\r\n';
  const rows = Array.from({ length: 20 }, (_, i) => `| 地区${i} | 😀内容${i} |`);
  const parts = splitGatewayMarkdown(`标题。\r\n\r\n${header}${rows.join('\r\n')}\r\n\r\n结束。`, limit);
  assert.ok(parts.every(part => count(part) <= limit), `final payload limit ${limit} includes repeated headers`);
  assert.deepEqual(parts.flatMap(part => part.split(/\r?\n/).filter(line => /^\| 地区\d+ /.test(line))), rows);
  for (const part of parts) if (/^\| 地区\d+ /m.test(part)) assert.match(part, /\| 地区 \| 说明 \|\r?\n\|:---\|---:\|/);
}

for (const limit of [0, -1, 1.5, NaN]) assert.throws(() => splitGatewayMarkdown('hello', limit), /invalid_message_limit/);

console.log('gateway chunking tests passed');
