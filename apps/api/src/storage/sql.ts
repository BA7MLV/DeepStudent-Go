/**
 * 动态 SQL 的静态安全边界。
 *
 * 问题:原先用 `db.prepare(`…${fragment}…`)` 拼接表名、列名、排序片段,
 * 编译器无法证明这些片段不是用户输入。这里把「可以进入 SQL 文本的部分」
 * 收窄成只接受字面量联合/白名单的类型,数据一律用 `?` 参数绑定。
 *
 * 分三层:
 * - `SqlFragment`(`SqlKeyword` 固定子句 / `SqlIdentifier` 标识符 / `SqlList` 标识符列表)
 *   与 `SqlText`(`sql` 模板产出的带 `?` 语句):
 *   `sql` 模板标签只接受这几类插值并在运行期再次校验形态,在 `${}` 位置放普通
 *   `string`/`number` 会直接编译失败 —— 那种值本该走参数绑定。
 *   产物自带 `bindings`(即文本里 `?` 的个数),`prepare(sql…)` 处再把
 *   「语句 + 参数数组」交给 `bindSql` 对账。
 * - `sqlFixed()` + `SqlVariant`:拼接带受控变体(可选 WHERE/排序片段)的语句,
 *   文本与绑定值个数显式对齐。
 * - `SqlPredicate` / `sqlAnd` / `sqlAny` / `placeholders`:固定谓词 + 任意条数
 *   绑定值的组合,替代「用字符串拼 `WHERE … IN (?,?)`」的写法。
 */

/** 只包含固定子句的片段(如 `IS NULL`、`DESC`,或一段不含插值的条件)。 */
export type SqlKeyword = { readonly sql: string };
/** 标识符(表名/列名),必要时已按 SQLite 规则加双引号。 */
export type SqlIdentifier = { readonly sql: string };
/** 已按顺序用逗号连接、括号由调用方写出的标识符列表。 */
export type SqlList = { readonly sql: string };
/** 可以安全嵌入 SQL 文本的全部片段种类。 */
export type SqlFragment = SqlKeyword | SqlIdentifier | SqlList;

/** 一段带 `?` 的语句(由 `sql` 生成):绑定值个数由 `?` 的个数唯一决定。 */
export type SqlText = { readonly sql: string; readonly bindings: number };
/** 模板里允许的插值:标识符/固定关键字,或不承载值的带 `?` 语句(如列别名表达式)。 */
export type SqlPart = SqlFragment | SqlText;

const plainIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const sqlKeyword = (keyword: string): SqlKeyword => {
  // 分号、引号、注释符出现在固定子句里一定是拼接失误,而不是合法关键字。
  if (!keyword || /[;'"`]|\/\*|--/.test(keyword)) throw new Error('invalid_sql_keyword');
  return { sql: keyword };
};

/** 纯字母数字下划线的标识符原样使用(与既有 SQL 文本一致,不改变查询计划);其余一律加双引号转义。 */
export const sqlIdentifier = (name: string): SqlIdentifier => {
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('invalid_sql_identifier');
  return { sql: plainIdentifier.test(name) ? name : `"${name.replaceAll('"', '""')}"` };
};

export const sqlList = (fragments: readonly (SqlIdentifier | SqlKeyword)[]): SqlList => {
  if (!fragments.length || fragments.some(fragment => fragment.sql.includes(','))) throw new Error('invalid_sql_list');
  return { sql: fragments.map(fragment => fragment.sql).join(',') };
};

/** 运行期兜底:挡住经跨模块伪造或非字面量退化传入的任意文本。 */
export const assertSqlFragment = (fragment: { readonly sql: string }): { readonly sql: string } => {
  if (!fragment || typeof fragment.sql !== 'string' || !fragment.sql || fragment.sql.length > 40000) throw new Error('invalid_sql_fragment');
  if (/[;`]|\/\*|--/.test(fragment.sql)) throw new Error('invalid_sql_fragment');
  // 双引号只能来自 sqlIdentifier 的转义;单引号必须是成对字面量,不能是未闭合的引号。
  if ((fragment.sql.match(/"/g)?.length ?? 0) % 2 !== 0) throw new Error('invalid_sql_fragment');
  if ((fragment.sql.match(/'/g)?.length ?? 0) % 2 !== 0) throw new Error('invalid_sql_fragment');
  return fragment;
};

/** 断言固定语句里的 `?` 个数与调用方的绑定值个数一致。 */
export const assertBindings = (statement: string, bindings: number) => {
  if (!Number.isSafeInteger(bindings) || bindings < 0) throw new Error('invalid_sql_arity');
  if (countPlaceholders(statement) !== bindings) throw new Error('sql_binding_count_mismatch');
  return statement;
};

/**
 * 只数「真正的参数位」:单引号字符串、双引号标识符与行注释/块注释里的
 * `?` 都不是绑定值。不做这层区分,含字面量 `?` 的合法 SQL 会被误判成参数个数不符。
 */
export const countPlaceholders = (statement: string) => {
  let placeholders = 0, quote: "'" | '"' | null = null, comment: 'line' | 'block' | null = null;
  for (let index = 0; index < statement.length; index++) {
    const character = statement[index], next = statement[index + 1];
    if (comment === 'line') { if (character === '\n') comment = null; continue; }
    if (comment === 'block') { if (character === '*' && next === '/') { comment = null; index++; } continue; }
    if (quote) {
      if (character === quote) {
        // SQLite 用重复引号转义引号本身(`''`/`""`),成对跳过。
        if (next === quote) { index++; continue; }
        quote = null;
      }
      continue;
    }
    if (character === '-' && next === '-') { comment = 'line'; index++; continue; }
    if (character === '/' && next === '*') { comment = 'block'; index++; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '?') placeholders++;
  }
  return placeholders;
};

/**
 * 模板标签:插值只接受标识符/固定关键字或其他不带绑定值的 `sql` 语句;
 * 占位符只写在模板自身的文本里。返回 `SqlText`,其 `bindings` 即真正参数位的个数,
 * 调用方用 `bindSql` 与参数数组对账,不必再手写条数。
 */
export const sql = (strings: TemplateStringsArray, ...parts: readonly SqlPart[]): SqlText => {
  let text = strings[0];
  let bindings = countPlaceholders(strings[0]);
  parts.forEach((part, index) => {
    assertSqlFragment(part);
    if ('bindings' in part && part.bindings !== 0) throw new Error('sql_nested_bindings');
    // 两段都不能少:片段本身,以及它后面跟着的字面量文本 —— 少了后者,
    // `SELECT ${cols} FROM …` 会变成只有列清单的残句,countPlaceholders 也数错了对象。
    text += part.sql + strings[index + 1];
    bindings += countPlaceholders(strings[index + 1]);
  });
  return Object.freeze({ sql: text, bindings });
};

/** 受控变体:完整语句里允许按条件增减的片段,自带它贡献的绑定值个数。 */
export type SqlVariant = SqlFragment & { readonly bindings: number };

/** 由固定骨架生成的同种类片段(空的 WHERE/排序文本不能用 `sqlKeyword`,它拒绝空串)。 */
export const sqlVariant = (keyword: string, bindings = 0): SqlVariant => {
  assertBindings(keyword, bindings);
  return { sql: keyword, bindings };
};

/**
 * 受限拼接:骨架 + 受控变体。骨架自身绑定值个数必须显式给出;变体之间以单个空格分隔。
 * 文本与绑定个数的对应关系在这里一次性对齐,调用方只需按同一顺序传值。
 */
export const sqlFixed = (skeleton: string, bindings: number, variants: readonly SqlVariant[] = []): SqlText => {
  assertBindings(skeleton, bindings);
  let text = skeleton.trimEnd();
  let total = bindings;
  for (const variant of variants) {
    assertSqlFragment(variant);
    assertBindings(variant.sql, variant.bindings);
    if (text) text += ' ';
    text += variant.sql;
    total += variant.bindings;
  }
  return Object.freeze({ sql: text, bindings: total });
};

/** 一段完整的 WHERE 条件:文本只由固定片段与 `?` 组成,不承载任何值。 */
export type SqlPredicate = { readonly text: string; readonly bindings: number };
export type SqlParameters = ReadonlyArray<string | number | bigint | null | Uint8Array>;

export const sqlPredicate = (text: string, bindings: number): SqlPredicate => {
  assertSqlFragment({ sql: text });
  assertBindings(text, bindings);
  return { text, bindings };
};

/** `?` 占位符文本:不含任何值,个数即绑定值个数。 */
export const placeholders = (count: number): string => {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('invalid_sql_placeholders');
  return Array.from({ length: count }, () => '?').join(',');
};

/** 按条件拼接谓词;`undefined`/`''` 表示该条件不参与,避免调用方再手写 `1=1` 或字符串判空。 */
export const sqlAnd = (...parts: ReadonlyArray<SqlPredicate | undefined | null | ''>): SqlPredicate => {
  const kept = parts.filter((part): part is SqlPredicate => Boolean(part));
  return sqlPredicate(kept.length ? kept.map(part => part.text).join(' AND ') : '1=1', kept.reduce((total, part) => total + part.bindings, 0));
};

/** `(a OR b)`:空集合得到恒假 `0`。 */
export const sqlAny = (...parts: ReadonlyArray<SqlPredicate | undefined | null | ''>): SqlPredicate => {
  const kept = parts.filter((part): part is SqlPredicate => Boolean(part));
  return kept.length ? sqlPredicate(`(${kept.map(part => part.text).join(' OR ')})`, kept.reduce((total, part) => total + part.bindings, 0)) : sqlPredicate('0', 0);
};

/**
 * 语句与参数对账:`prepare(...)` 之后按 `bindings` 检查参数条数。
 * 参数顺序仍由调用点决定,但条数不符会在执行前立刻暴露,而不是把值绑到别的列上。
 */
export const bindSql = (text: SqlText, parameters: SqlParameters): { text: string; parameters: SqlParameters } => {
  assertBindings(text.sql, text.bindings);
  if (parameters.length !== text.bindings) throw new Error('sql_binding_count_mismatch');
  return { text: text.sql, parameters };
};
