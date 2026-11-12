/* eslint-disable no-console */
/**
 * 实时链路 e2e 的**共享装置**：断言记分器 / 桩中继 / 桩模型网关 / webm fixture / 小工具。
 *
 * ── 为什么不并进 e2e-livelink.mjs ────────────────────────────────────────────
 * P1（33 条断言）与 P2（问答流 / op 写回 / outbox 补发）各自都要一份桩中继与记分器，
 * 放一起就是 2000+ 行单文件，改一行要读 2000 行；复制两份则更糟 —— 本仓库的规矩是
 * 「两套并存必然漂移」，而这两份漂移的后果恰好是本项目最不能容忍的那类：**桩与真中继
 * 的帧契约不再一致，于是「桩放行了真中继会丢的帧」这类问题在 e2e 里恒绿**。
 *
 * ── 文件名为什么不叫 e2e-… / test-… ──────────────────────────────────────────
 * `scripts/e2e-all.mjs` 有一道守门员：按 `^(test|e2e|probe|debug|render|motion|scenario)(-|$)`
 * 给磁盘上「看起来像可执行脚本」的文件点名，没登记进 META 的会警告「本次不会被跑到」。
 * 本文件是**被 import 的库**、不是入口 —— 叫 `e2e-livelink-harness.mjs` 会被那道守门员
 * 判成漏登记的脚本（一键跑分里凭空多一条噪音警告）。所以叫 `livelink-e2e-harness.mjs`：
 * 前缀不在名单里，不会被误判；名字里仍然带 livelink-e2e，人能一眼看出它属于哪条线。
 *
 * ── 桩中继与真 DO 的关系 ────────────────────────────────────────────────────
 * 只复刻协议级三件事（按 room 配对 / 异角色原样转发 / host 断开向 guest 广播
 * host-link-down），与真 Worker（cloudflare-worker/live-relay）的
 * `fetch` / `webSocketMessage` / `webSocketClose` 三条路径对应。宽限 60s、配对限速、
 * hibernation 恢复那些都不改变两端交换的帧，所以协议帧在桩与真中继上逐字节一致。
 * 真 DO 归手动验收（设计文档的验收项）。
 */
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WebSocketServer, WebSocket as NodeWs } from 'ws';

// ───────────────────────────── 1. 断言记分器 ─────────────────────────────

/**
 * 一条 e2e 的记分器。**失败只记不抛**：中途抛会让后面的断言一起红，真正的原因被淹掉
 * （e2e-md-editor.mjs 的同款理由）。每个入口自己决定最后怎么汇总退出码。
 */
export function createReporter() {
  const state = { failed: 0, passed: 0 };
  const ok = (msg) => {
    state.passed++;
    console.log(`   ✓ ${msg}`);
  };
  const fail = (msg) => {
    state.failed++;
    console.error(`   ❌ ${msg}`);
  };
  const skip = (msg) => console.log(`   ⚠ 跳过：${msg}`);
  /**
   * 跑一条断言。失败消息带断言名；「哪一步 / 期望什么 / 实际什么」由调用点写进
   * assert 的 message —— 这里的 catch 只负责把「抛在哪」接住，不做翻译。
   */
  const check = async (name, fn) => {
    try {
      await fn();
      ok(name);
    } catch (e) {
      fail(`${name}\n      ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return { ok, fail, skip, check, failedCount: () => state.failed, passedCount: () => state.passed };
}

// ───────────────────────────── 2. 桩中继 ─────────────────────────────

/** 帧日志的上限：到量就停并计数（别让一条跑上万帧的 e2e 把内存吃光）。 */
const FRAME_LOG_MAX = 4000;

/**
 * 进程内桩中继。
 *
 * `stats` 是每条 e2e 的**观测面**：range 帧数 / 载荷字节 / 每个 range 请求的 {start,len} /
 * host-link-down 次数（P1 的断言依据），外加 `frames` —— 逐连接的**文本帧流水**
 * （P2 的断言依据：ack 定向到谁、问答流有没有串台，见 `framesOf`）。
 *
 * ## 掐断与恢复：`cut(role)` / `heal()`
 * P2 要验的「断链 → outbox 暂存 → 重连补发」必须能在**链路活着的时候**把它掐断，
 * 所以这里给桩开了两个口子：
 *
 *   · `cut(role)`：**terminate** 掉该角色现有的全部连接，并让它随后连进来的连接一律
 *     立刻 terminate。用 terminate 而不是 `close()` 是为了走**没有 close 握手的断开**
 *     —— 浏览器看到的是 1006（异常关闭），正是「iPad 走进电梯」那形态；带正常关闭码的
 *     `close()` 像一次有序下线，而那不是要测的场景。更要紧的是**不能是致命码**：
 *     来宾页把 4000/4001/4403/4400 当成「重连救不了」（LiveGuest.tsx 的
 *     FATAL_CLOSE_CODES），用它们掐断就变成「页面摆出错误文案、从此不重连」，
 *     恰好测不到重连补发那条路。
 *   · `heal()`：解除掐断，**不动已建立的连接**（掐断时它们已经断了；来宾自己在退避
 *     重连，下一拍自己连回来）。不主动替它重连：那条重连策略（退避、世代作废旧回调）
 *     正是这条 e2e 要走的东西，桩替它连就把被测行为替掉了。
 *
 * 掐断语义与真中继的一个差别：真中继在 host 断开时会给 guest 补 host-link-up，而这里
 * 掐的是 guest、host 照常在席 —— 正是「主机好好的，是这台设备掉线了」这一形态，
 * 也就是要验 outbox 的那种形态。
 */
export function createStubRelay({ port, label = '中继' } = {}) {
  const stats = {
    rangeFrames: 0,
    /** 视频 range 的载荷字节（**只算低半区 rid**；高半区是单元分片，另计 unitBytes） */
    rangeBytes: 0,
    /** host 单元分片的载荷字节（gzip 后的索引 / 字幕 / 封面），不是视频文件字节 */
    unitBytes: 0,
    /** 每个 video.range 请求的 {start,len}（视频面协议级断言的原始记录） */
    rangeRequests: [],
    /** 二进制帧（含 12 字节头）的 rid 清单，用于确认 rid 不与单元分片撞车 */
    binaryRids: [],
    /** host 实际发出的 range 帧 {rid, seq, bytes, sha}（反推服务区间用；只含视频 range） */
    rangeResponses: [],
    /** rid → video.range 请求 {start, len, videoId, at}（完整性断言的请求侧） */
    rangeRequested: new Map(),
    /** rid → 已收到的应答帧数（完整性断言的应答侧） */
    rangeServed: new Map(),
    hostLinkDown: 0,
    hostLinkDownPayloads: [],
    /** 转发的文本帧路由（诊断用：确认 index/unit 真的过了中继） */
    textTypes: [],
    /** 文本帧流水（P2 的断言依据） */
    frames: [],
    /** frames 被截断的条数（不为 0 时别拿它下「一条都没有」的结论） */
    framesDropped: 0,
  };

  const rooms = new Map(); // code → { host, guests:Set }
  const severed = new Set(); // 被掐断的角色
  /** socket → connId。ws 对象自己不带 id，靠它把「这条帧到了对端」记到对端那条流水上 */
  const socketIds = new WeakMap();
  let connSeq = 0;

  const wss = new WebSocketServer({ port });
  const relayUrl = `ws://127.0.0.1:${port}`;

  const recordFrame = (entry) => {
    if (stats.frames.length >= FRAME_LOG_MAX) {
      stats.framesDropped++;
      return;
    }
    stats.frames.push({ at: Date.now(), ...entry });
  };

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const room = url.searchParams.get('room')?.trim();
    const role = url.searchParams.get('role');
    if (!room || (role !== 'host' && role !== 'guest')) {
      ws.close(4000, 'bad params');
      return;
    }
    // 掐断期间进来的连接：立刻 terminate（见文件头 cut 的理由）。不进房表 ——
    // 真中继在配对失败时也不会把它算成在席。
    if (severed.has(role)) {
      console.log(`   [${label}] ${role} 在掐断期间进房 ${room} → 立刻踢掉`);
      ws.terminate();
      return;
    }
    if (!rooms.has(room)) rooms.set(room, { host: null, guests: new Set() });
    const r = rooms.get(room);
    if (role === 'host') r.host = ws;
    else r.guests.add(ws);
    const connId = ++connSeq;
    socketIds.set(ws, connId);
    console.log(`   [${label}] ${role} 进房 ${room}（host=${r.host ? 1 : 0}, guests=${r.guests.size}，conn=${connId}）`);

    ws.on('message', (data, isBinary) => {
      // 视频面的 range 响应是二进制帧（12 字节头 rid u32 + seq f64 + 载荷）。
      // Node 侧 data 是 Buffer；ws 的 isBinary 标记必须原样带给 send，否则对端会把
      // 二进制帧当文本收 —— protocol.ts 的 decodeBinaryFrame 对非 ArrayBuffer 一律返 null，
      // 链路像死了一样但没有任何报错（mse.ts 文件头钉过这条）。
      if (isBinary && data.length >= 12) {
        const rid = data.readUInt32LE(0);
        const seq = data.readDoubleLE(4);
        const bytes = data.length - 12;
        stats.binaryRids.push(rid);
        if (rid < 0x80000000) {
          // 低半区 = guest 的 mse.ts 生成的 range rid，即**视频文件字节**
          stats.rangeFrames++;
          stats.rangeBytes += bytes;
          // 记下「host 实际发出来的区间」：一个 rid 可能被切成多帧（host 的
          // handleVideoRange 按 RANGE_CHUNK 循环发），首帧的 seq 就是请求的 start，
          // 后续帧的 seq 递增。拿到 {rid, seq, len} 三元组才能反推 host 有没有按请求的
          // 区间回数据（而不是回了一段别的）。载荷指纹用来与 host 文件同区间逐字节比对：
          // 只存摘要不存字节，11MB 的文件随便几帧就把内存吃光。
          stats.rangeResponses.push({
            rid,
            seq,
            bytes,
            sha: createHash('sha1').update(data.subarray(12)).digest('hex').slice(0, 16),
          });
          stats.rangeServed.set(rid, (stats.rangeServed.get(rid) ?? 0) + 1);
        } else {
          // 高半区 = host 的单元分片（rid 从 0x80000000 起）。它的载荷是 gzip 后的
          // 索引 / 字幕 / 封面，**不是视频文件字节** —— 并进 rangeBytes 计数会把
          // 「转发载荷不超过文件 size」顶成假红（假红比漏红更糟）。
          stats.unitBytes += bytes;
        }
      }
      let frame = null;
      if (!isBinary) {
        try {
          frame = JSON.parse(data.toString());
        } catch {
          /* 坏帧：桩与真中继一样不解析、照样转发（中继只搬运） */
        }
        if (frame) {
          stats.textTypes.push(frame.t);
          recordFrame({ conn: connId, room, role, dir: 'in', t: frame.t, frame });
          if (frame.t === 'video.range' || frame.t === 'video.open') {
            stats.rangeRequests.push({
              t: frame.t,
              id: frame.id,
              start: frame.start,
              len: frame.len,
              videoId: frame.videoId,
            });
            if (frame.t === 'video.range') {
              stats.rangeRequested.set(Number(frame.id), {
                start: frame.start,
                len: frame.len,
                videoId: frame.videoId,
                at: Date.now(),
              });
            }
          }
        }
      }
      // 异角色转发，同角色互不可见（真 DO 的 webSocketMessage 同款）
      const targets = role === 'host' ? [...r.guests] : r.host ? [r.host] : [];
      for (const t of targets) {
        if (t.readyState === NodeWs.OPEN) {
          t.send(data, { binary: isBinary });
          // 记「这条帧到了对端没有」：P2 的多来宾隔离断言（ack 只能到 A）就靠它 ——
          // 只看发送侧的话，「发给了所有 guest」与「只发给了 A」在桩里长得一样。
          if (frame) {
            const back = socketIds.get(t);
            if (back) recordFrame({ conn: back, room, role: back === connId ? role : rolePeer(role), dir: 'out', t: frame.t, frame });
          }
        }
      }
    });

    ws.on('close', () => {
      if (role === 'host') {
        r.host = null;
        // host 断开：向全体 guest 广播 host-link-down（真 DO 的 webSocketClose）。
        // 帧内容与 live-relay/src/index.ts 的 HOST_LINK_DOWN 常量逐字节一致。
        // ctl: 1 写死：控制帧不跟 app 协议版本走，桩里要是顺手写成
        // `{ v: PROTOCOL_VERSION, ... }`，guest 的 decodeControlFrame 就解不出它（它不看
        // 版本），「主机已离线」的提示静默失效，而下面那条帧字节断言还照样绿。
        const payload = JSON.stringify({ ctl: 1, t: 'host-link-down', id: 'relay' });
        for (const g of r.guests) {
          if (g.readyState === NodeWs.OPEN) {
            g.send(payload);
            stats.hostLinkDown++;
            stats.hostLinkDownPayloads.push(payload);
            const back = socketIds.get(g);
            if (back) recordFrame({ conn: back, room, role: 'guest', dir: 'out', t: 'host-link-down', frame: JSON.parse(payload) });
          }
        }
        console.log(`   [${label}] host 断开，向 ${r.guests.size} 台 guest 广播 host-link-down`);
      } else {
        r.guests.delete(ws);
        console.log(`   [${label}] guest 断开（剩 ${r.guests.size} 台，conn=${connId}）`);
      }
    });
  });

  wss.on('error', (e) => {
    console.error(`桩中继监听失败（端口 ${port}）：${e.message}`);
    process.exit(1);
  });

  return {
    wss,
    stats,
    rooms,
    relayUrl,
    port,
    /** 该房间此刻在中继侧在席的 guest 连接数（不含还在退避重连的） */
    guestCount: (room) => rooms.get(room)?.guests.size ?? 0,
    /** 掐断某角色：terminate 现有连接 + 拒绝它随后连进来的连接 */
    cut(role) {
      severed.add(role);
      let n = 0;
      for (const r of rooms.values()) {
        const socks = role === 'host' ? [r.host] : [...r.guests];
        for (const s of socks) {
          if (s && s.readyState === NodeWs.OPEN) {
            s.terminate();
            n++;
          }
        }
      }
      console.log(`   [${label}] 掐断 ${role}（terminate ${n} 条连接；此后的新连接也一律踢掉）`);
      return n;
    },
    /** 恢复放行。不碰已建立的连接 —— 那些已经断了，来宾自己在退避重连。 */
    heal() {
      severed.clear();
      console.log(`   [${label}] 恢复放行`);
    },
    severed: () => [...severed],
    /**
     * 帧流水查询（按 room / role / dir / t / conn 或自定义 pred 过滤，返回副本）。
     * `dir:'in'` = 这一侧发出去的，`dir:'out'` = 这一侧收到的 —— 断言「ack 只到 A」时
     * 要看的是 A 那条连接的 `out`。
     */
    framesOf(filter = {}) {
      return stats.frames
        .filter((f) => {
          if (filter.conn !== undefined && f.conn !== filter.conn) return false;
          if (filter.room !== undefined && f.room !== filter.room) return false;
          if (filter.role !== undefined && f.role !== filter.role) return false;
          if (filter.dir !== undefined && f.dir !== filter.dir) return false;
          if (filter.t !== undefined && f.t !== filter.t) return false;
          if (typeof filter.pred === 'function' && !filter.pred(f)) return false;
          return true;
        })
        .map((f) => ({ ...f }));
    },
    /** 某条连接（按 room+role 的先后顺序拿 connId）的流水，P2 用来分辨 A / B 两台设备 */
    connIdsOf(room) {
      const ids = stats.frames.filter((f) => f.room === room).map((f) => f.conn);
      return [...new Set(ids)].map((id) => {
        const first = stats.frames.find((f) => f.conn === id);
        return { conn: id, role: first?.role ?? '?' };
      });
    },
    close() {
      wss.close();
    },
  };
}

/** 对端角色（host 的对端是 guest，guest 的对端是 host）。帧流水里标出来才分得清谁发的。 */
function rolePeer(role) {
  return role === 'host' ? 'guest' : 'host';
}

// ───────────────────────────── 3. 桩模型网关 ─────────────────────────────

/**
 * 一轮 assistant 的 SSE（形状照 scripts/test-livelink-host-wiring.mjs 的那份）：
 * 正文 / 思考 / 工具调用 / finish_reason。
 *
 * ⚠️ **这里只能整轮 fulfil，不能逐块流**：Playwright 的 `route.fulfill` 一次性给全部
 * 响应体，没有「流着写」的接口。所以「逐字流出来」在 e2e 里验不到（单测
 * test-qa-runner.mjs 与宿主面板的 e2e 覆盖它），本条守的是**跨进程的帧与落库**。
 * 唯一需要「流还没结束」的用例（停止生成）用另一种桩法：把请求**挂在桩里不答**
 * （见 createModelGateway 的 `hang` 脚本项），页面 abort 之后桩侧能看到
 * `net::ERR_ABORTED` —— 那正是「桩模型收到了 abort」在测试进程里唯一拿得到的证据
 * （fetch 的 reject 发生在页面内，外面看不见）。
 */
export function sseRound({ content = '', reasoning = '', toolCalls = [], finish = 'stop' } = {}) {
  const chunks = [];
  const base = { id: 'c', object: 'chat.completion.chunk', model: 'e2e-stub', choices: [{ index: 0, delta: {} }] };
  if (reasoning) chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning_content: reasoning } }] });
  if (content) chunks.push({ ...base, choices: [{ index: 0, delta: { content } }] });
  toolCalls.forEach((tc, index) => {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }],
          },
        },
      ],
    });
  });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
}

/**
 * 桩模型网关：用 `page.route()` 拦下模型网关域名，按脚本回可控的两轮流式响应。
 *
 * 拦的是**页面里真正发出的那一次 fetch**（`api/siliconflow.ts` 的 request() 直接调全局
 * fetch），所以断言面是「主机真的把什么送出去了」：系统提示词、工具白名单、历史消息 ——
 * 都是链路上最容易静默走偏、又最不可能在界面上看出来的东西。
 *
 * ## 脚本（setScript）
 * 每项对应一次请求，按到达顺序取用：
 *   · `{ content / toolCalls / finish }` —— 回这一轮（内部走 sseRound）；
 *   · `{ hang: true }` —— **不答**：请求挂在桩里，直到页面 abort（停止生成那条用例）。
 * 取完最后一项后重复最后一项（与 host-wiring 的 serve 同款：脚本条数算错时要表现为
 * 「脚本用尽」的显眼症状，而不是静默卡住）。
 *
 * ## 观测（calls）
 * 每次请求记一条：`system`（第一条 system 消息）、`tools`（工具名数组）、`messages`、
 * `userText`（本轮用户消息，便于按提问内容找那一轮）、`answered` / `aborted` / `hanging`。
 * P2 的「材料课问答走材料工具」就是拿 `system` 与 `tools` 断言的 —— Task 8 修的正是那个
 * 静默错误：来宾问材料课而主机跑的是视频课的提示词与工具集，界面上不报错、模型照答，
 * 只是答的根本不是这节课的东西。
 *
 * ## 为什么钉一个「漏网即红」的兜底
 * URL 不含 `/chat/completions` 的请求（列模型等）一律 abort 并记一条：桩认不出来就意味着
 * 这一轮会真的出网（拿假 key 去打真网关），症状是超时或 401，而真正的原因是「桩没覆盖到
 * 这条路径」—— 那正是「桩不够就说清楚」的场合。
 */
export function createModelGateway(page, { origin = 'https://api.siliconflow.cn', path = '/chat/completions' } = {}) {
  const calls = [];
  let script = [];
  let i = 0;
  const gw = {
    calls,
    label: '',
    /** 换脚本并把游标归零；同时清空 calls（断言只盯当前脚本产生的那几条） */
    setScript(next, label = '') {
      script = next;
      i = 0;
      calls.length = 0;
      gw.label = label;
    },
    /** 当前脚本被取了几次（脚本条数算错时一眼看得出来） */
    used: () => i,
    /** 找某一轮的记录（按提问内容挑，省得依赖调用次序） */
    byUserText(text) {
      return calls.filter((c) => typeof c.userText === 'string' && c.userText.includes(text));
    },
    /** 页面关掉时解除拦截，免得留下悬空的 route 句柄 */
    async dispose() {
      await page.unroute(`${origin}/**`, handler).catch(() => {});
    },
  };

  const handler = (route, request) => {
    void (async () => {
      const url = request.url();
      if (!url.startsWith(origin) || !url.endsWith(path)) {
        calls.push({ at: Date.now(), url, answered: false, skipped: true, note: '不是对话请求（桩不接，已 abort）' });
        await route.abort('failed');
        return;
      }
      let body = null;
      try {
        body = request.postDataJSON();
      } catch {
        body = null;
      }
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const rec = {
        at: Date.now(),
        n: calls.length + 1,
        url,
        system: typeof messages[0]?.content === 'string' ? messages[0].content : '',
        tools: Array.isArray(body?.tools) ? body.tools.map((t) => t?.function?.name).filter(Boolean) : [],
        messages,
        model: typeof body?.model === 'string' ? body.model : '',
        userText: messages
          .filter((m) => m?.role === 'user')
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n'),
        answered: false,
        aborted: null,
      };
      calls.push(rec);
      const step = script[Math.min(i, script.length - 1)];
      i++;
      if (!step) {
        rec.note = '脚本用尽且没有兜底项（多半是用例没配脚本）';
        await route.abort('failed');
        return;
      }
      if (step.hang) {
        rec.hanging = true;
        // 故意不答：等页面 abort。桩侧用 request.failure() 观测「请求被取消」——
        // 这是「桩模型收到了 abort」在测试进程里唯一能拿到的证据。
        const t0 = Date.now();
        const timer = setInterval(() => {
          const f = request.failure();
          if (f !== null) {
            clearInterval(timer);
            rec.aborted = f.errorText ?? String(f);
            rec.abortedAfterMs = Date.now() - t0;
          } else if (Date.now() - t0 > 120000) {
            clearInterval(timer);
            rec.note = '挂了 120s 都没等到 abort（多半是这条用例没点停止）';
          }
        }, 40);
        timer.unref?.();
        return;
      }
      rec.answered = true;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-cache' },
        body: step.sse ?? sseRound(step),
      });
    })();
  };

  page.route(`${origin}/**`, handler);
  return gw;
}

// ───────────────────────────── 4. webm fixture ─────────────────────────────

/**
 * ffmpeg 可执行文件路径；找不到返回 null（依赖真解码的用例据此跳过）。
 *
 * 支持 `E2E_FFMPEG` 覆盖：这是**给自己留的测试口** —— 「ffmpeg 缺失就跳过」那条降级路径
 * 必须真的能跑一遍才算验证过。把它指向一个不存在的路径就能触发降级。
 */
export function findFfmpeg() {
  if (process.env.E2E_FFMPEG !== undefined) {
    return process.env.E2E_FFMPEG === '' ? null : process.env.E2E_FFMPEG;
  }
  const candidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg'];
  for (const c of candidates) {
    try {
      if (c === 'ffmpeg' || existsSync(c)) return c;
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}

/**
 * 用 ffmpeg 造 video-only webm/vp9 fixture（45s / 640x360 / >8MB）。
 *
 * `-an`（无音频轨）不是顺手加的：本机 Chrome 实测带音频轨的容器 MSE 全灭（vp9+opus →
 * video error 3），video-only 才能真播 —— 而 P1 的「buffered 无洞 / 窗口滑动」与 P2 的
 * 「点字幕真能 seek」要的都是一个**真的播得动**的播放器。
 *
 * ⚠️ **码率与噪声滤镜是 P1 的硬要求，动它们之前先读 P1 的文件头**：8MB 正是 guest 的
 * WINDOW_BYTES，纯 `testsrc` 只有 318kbps（45s 才 1.8MB），一轮就拉完，窗口滑动、
 * 并发排队、多 chunk 一条路径都撞不到。所以这里保留原样的 `noise` + `2000k`（≈11MB）。
 * P2 用同一份 fixture，多花的那几秒 ffmpeg 时间换「两条 e2e 的造物一致」，值。
 */
export async function makeWebmFixture(dir) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    return { path: null, reason: '找不到 ffmpeg（试过 /opt/homebrew/bin、/usr/local/bin、/usr/bin、PATH）' };
  }
  const out = join(dir, 'webm-vp9.webm');
  const args = [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=45:size=640x360:rate=15',
    '-vf', 'noise=alls=25:allf=t',
    '-c:v', 'libvpx', '-b:v', '2000k', '-an', out,
  ];
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
  });
  return {
    path: existsSync(out) ? out : null,
    reason: existsSync(out) ? '' : 'ffmpeg 报告成功但产物不存在',
    size: existsSync(out) ? statSync(out).size : 0,
  };
}

// ───────────────────────────── 5. 小工具 ─────────────────────────────

/**
 * 读配对码。mdui-text-field 的真值有三种可能的落点（React 受控 value 属性、
 * shadow DOM 里的 input.value、宿主属性），逐个试 —— 只试一种的话，mdui 版本一升级就会
 * 让这条读成空串，而空串会让后面所有断言以「配对码格式不对」的面貌红掉，把真正的原因
 * （取值方式变了）盖住。
 */
export async function readPairCode(page) {
  return (
    await page
      .locator('[data-testid="live-code"]')
      .evaluate((el) => {
        const inner = el.shadowRoot?.querySelector('input,textarea');
        return el.value ?? el.getAttribute('value') ?? inner?.value ?? '';
      })
      .catch(() => '')
  ).trim();
}

/** 构造 guest 链接（断言 host 展示的码与 URL 里的 pair 是同一个）。 */
export function liveUrlFor(base, code, relay) {
  return `${base}/#/live?relay=${encodeURIComponent(relay)}&pair=${encodeURIComponent(code)}`;
}

/**
 * guest 页面的 live-* 节点快照。**只在断言失败时打**。
 * 「课程项不出现」有两种完全不同的成因 —— 没连上（URL / 端口 / 中继没起）与连上了但拉不到
 * 索引（host 读库失败）；两者的修法没有交集，而症状在日志里都只是「waitForSelector 超时」。
 */
export async function guestSnapshot(page) {
  return page
    .evaluate(() => ({
      url: location.href,
      nodes: [...document.querySelectorAll('[data-testid^="live-"]')].map((el) => ({
        id: el.getAttribute('data-testid'),
        txt: (el.textContent || '').slice(0, 100),
      })),
      body: (document.body.innerText || '').slice(0, 200),
    }))
    .catch((e) => ({ err: String(e).slice(0, 200) }));
}

/** 断言失败时调：把 guest 快照附在失败信息后面，省得回头再跑一遍看现场。 */
export async function dumpGuest(page, label) {
  const snap = await guestSnapshot(page);
  console.log(`   [诊断·${label}] ${JSON.stringify(snap)}`);
}

/**
 * 预检：dev 服务在不在。
 *
 * 不在就**明确报错并退出**，而不是让第一个 page.goto 抛一个裸的 ERR_EMPTY_RESPONSE ——
 * 那条栈指向脚本内部，看不出来「其实是没起服务」。端口被别的项目占着时，编排器
 * （e2e-all.mjs）会复用端口上已有的服务，症状同样是这个错。先探一次能一次说清。
 */
export async function preflight(base) {
  try {
    const res = await fetch(base, { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\n❌ 连不上 dev 服务 ${base}（${e.message}）`);
    console.error('   先起服务：npm run dev（或设 BASE_URL 指向已起的那份）');
    console.error('   端口被别的项目占用时会复用到别家页面，症状也是这个错。\n');
    process.exit(1);
  }
}

/**
 * 等一个条件成立（轮询 + 超时），返回它成立那一刻的值。
 * e2e 里的时序一律用它，**不用 sleep 猜** —— 猜出来的等待在慢机器上会变成假红。
 */
export async function waitUntil(fn, { timeout = 15000, every = 100, what = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() >= deadline) {
      throw new Error(`${what}：${timeout}ms 内没成立（最后一次读到 ${JSON.stringify(last)}）`);
    }
    await delay(every);
  }
}

export { delay };
