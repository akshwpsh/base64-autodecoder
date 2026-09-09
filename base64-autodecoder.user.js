// ==UserScript==
// @name            Base64 Auto Decoder
// @name:ko         Base64 자동 디코더
// @namespace       https://github.com/akshwpsh/base64-autodecoder
// @version         1.0.1
// @homepageURL     https://github.com/akshwpsh/base64-autodecoder
// @supportURL      https://github.com/akshwpsh/base64-autodecoder/issues
// @description     Finds base64 encoded text on any page and shows the decoded result under the paragraph, keeping the original intact.
// @description:ko  어느 사이트에서든 base64로 인코딩된 내용을 찾아, 원문은 그대로 둔 채 해당 문단 아래에 디코딩 결과를 보여줍니다.
// @author          akshw
// @match           *://*/*
// @run-at          document-idle
// @grant           GM_getValue
// @grant           GM_setValue
// @grant           GM_registerMenuCommand
// @license         MIT
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 상수
   * ------------------------------------------------------------------ */

  const CONFIG = {
    // 후보로 볼 최소 길이. 이보다 짧으면 우연히 base64 모양이 될 확률이 너무 높다.
    MIN_TOKEN_LENGTH: 16,
    // 앵커 경로가 중첩을 쫓아갈 최대 깊이.
    MAX_NESTING_DEPTH: 3,
    // 결과가 이보다 길면 접는다.
    COLLAPSE_LENGTH: 500,
    // 한 페이지에서 처리할 최대 발견 수. 무한 스크롤 방어선.
    MAX_FINDINGS_PER_PAGE: 200,
    // 「추정 결과도 바로 펼치기」가 켜져 있을 때 자동으로 펼칠 최대 개수.
    // 넘치는 것은 버리지 않고 배지로 접어 둔다.
    MAX_AUTO_HEURISTIC: 20,
    MUTATION_DEBOUNCE_MS: 200,
    // 유휴 시간 한 조각에서 처리할 세그먼트 수.
    CHUNK_SIZE: 30,
    // 디코딩 결과에서 인쇄 가능한 문자가 차지해야 하는 최소 비율.
    PRINTABLE_RATIO: 0.95,
    // 앵커 경로가 찾는 평문. 이것이 결과에 있으면 확정으로 본다.
    URL_SCHEMES: ['http://', 'https://', 'magnet:?'],
  };

  const OURS = 'data-b64ad';
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const NUMERALS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  // 세그먼트 안에서 텍스트 노드 사이에 끼우는 경계 표식. <br> 이나 블록 요소를
  // 사이에 둔 두 토큰이 하나로 합쳐지는 것을 막는다. 공백이 아니므로 compactOf 도
  // 지우지 않는다.
  const HARD_BREAK = '\u0000';

  // 내용을 건드리면 안 되는 곳. 실행 대상이거나 사용자가 편집 중인 영역.
  const SKIP_TAGS = new Set([
    'script', 'style', 'textarea', 'noscript', 'template', 'iframe',
    'canvas', 'select', 'option', 'head', 'title', 'input',
  ]);

  // 디코딩 블록의 기준점이 될 수 있는 요소. code/pre 는 일부러 포함한다.
  const BLOCK_TAGS = new Set([
    'p', 'div', 'li', 'td', 'th', 'blockquote', 'pre', 'section', 'article',
    'aside', 'main', 'header', 'footer', 'nav', 'figure', 'figcaption',
    'dd', 'dt', 'dl', 'ul', 'ol', 'table', 'tr', 'form', 'fieldset',
    'address', 'caption', 'summary', 'details', 'center', 'body',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  ]);

  // 텍스트 흐름을 끊는 요소. 이 앞뒤의 텍스트는 이어붙이지 않는다.
  const BREAK_TAGS = new Set(['br', 'hr']);

  // 기준점 뒤에 붙일 수 없어 안에 넣어야 하는 요소.
  const INSERT_INSIDE = new Set(['td', 'th', 'li', 'dd', 'dt', 'caption', 'details']);
  // 이 요소의 자식 사이에는 아무거나 끼울 수 없다. 자식 안쪽에 넣는다.
  const STRICT_PARENTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'dl']);

  /* ------------------------------------------------------------------ *
   * 설정 저장소
   * ------------------------------------------------------------------ */

  const STORE_KEY = 'b64ad.settings';
  const DEFAULTS = { heuristicEnabled: true, autoExpandHeuristic: false, blacklist: [] };

  const store = {
    read() {
      let raw = null;
      try {
        raw = typeof GM_getValue === 'function'
          ? GM_getValue(STORE_KEY, null)
          : localStorage.getItem(STORE_KEY);
      } catch (e) { /* 저장소 접근 불가 - 기본값으로 간다 */ }
      let parsed = {};
      if (raw) {
        try { parsed = JSON.parse(raw) || {}; } catch (e) { parsed = {}; }
      }
      const s = Object.assign({}, DEFAULTS, parsed);
      if (!Array.isArray(s.blacklist)) s.blacklist = [];
      s.heuristicEnabled = s.heuristicEnabled !== false;
      s.autoExpandHeuristic = s.autoExpandHeuristic === true;
      return s;
    },
    write(value) {
      const raw = JSON.stringify(value);
      try {
        if (typeof GM_setValue === 'function') GM_setValue(STORE_KEY, raw);
        else localStorage.setItem(STORE_KEY, raw);
      } catch (e) { /* 저장 실패는 조용히 넘긴다 */ }
    },
  };

  const settings = store.read();

  /* ------------------------------------------------------------------ *
   * base64 해석
   * ------------------------------------------------------------------ */

  const B64_ONLY = /^[A-Za-z0-9+/]+$/;
  const B64_LOOSE = /^[A-Za-z0-9+/=_-]+$/;
  // 패딩 '=' 에서 후보를 끊는다. 패딩 뒤에 바로 이어지는 글자는 다른 토큰이다.
  const CANDIDATE_RE = new RegExp('[A-Za-z0-9+/_-]{' + CONFIG.MIN_TOKEN_LENGTH + ',}={0,2}', 'g');
  const URL_RE = /(https?:\/\/[^\s<>"'`)\]]+|magnet:\?[^\s<>"'`)\]]+)/g;

  // URL-safe 변종과 누락된 패딩을 표준형으로 되돌린다.
  function normalize(raw) {
    let s = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const eq = s.indexOf('=');
    if (eq !== -1) {
      // '=' 는 끝에만, 최대 두 개까지 올 수 있다.
      if (!/^={1,2}$/.test(s.slice(eq))) return null;
      s = s.slice(0, eq);
    }
    if (!B64_ONLY.test(s)) return null;
    const rem = s.length % 4;
    if (rem === 1) return null; // 4n+1 은 base64 로 만들어질 수 없는 길이다
    if (rem) s += '='.repeat(4 - rem);
    return s;
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });

  function decodeOnce(raw) {
    const s = normalize(raw);
    if (!s) return null;
    let bin;
    try { bin = atob(s); } catch (e) { return null; }
    if (!bin.length) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try {
      return decoder.decode(bytes); // 유효하지 않은 UTF-8 이면 던진다
    } catch (e) {
      return null;
    }
  }

  function printableRatio(text) {
    const chars = Array.from(text);
    if (!chars.length) return 0;
    let ok = 0;
    for (const ch of chars) {
      const c = ch.codePointAt(0);
      if (c === 9 || c === 10 || c === 13) { ok++; continue; }   // 탭, 개행
      if (c < 32 || c === 127) continue;                         // 제어 문자
      if (c >= 0x80 && c <= 0x9f) continue;                      // C1 제어 문자
      ok++;
    }
    return ok / chars.length;
  }

  function readable(text) {
    return text !== null
      && /\S/.test(text) // 공백만으로 된 결과는 보여줄 것이 없다
      && printableRatio(text) >= CONFIG.PRINTABLE_RATIO;
  }

  function containsUrl(text) {
    return CONFIG.URL_SCHEMES.some(function (scheme) { return text.indexOf(scheme) !== -1; });
  }

  function looksLikeBase64(text) {
    const t = text.trim();
    return t.length >= CONFIG.MIN_TOKEN_LENGTH && B64_LOOSE.test(t);
  }

  /**
   * 후보 문자열 하나를 해석한다.
   *
   * 앵커 경로: 결과에 URL 이 나올 때까지 중첩을 쫓아간다. URL 이 나왔다는 것은
   *            그 자체로 검증이므로 오탐이 아니다. 자동으로 펼친다.
   * 휴리스틱 경로: 1층만 본다. 반복할수록 우연히 통과할 확률이 누적되기 때문이다.
   */
  function analyze(raw, opts) {
    const allowHeuristic = !opts || opts.heuristic !== false;
    const first = decodeOnce(raw);
    if (first === null) return null;

    let current = first;
    for (let depth = 1; depth <= CONFIG.MAX_NESTING_DEPTH; depth++) {
      if (containsUrl(current) && readable(current)) {
        return { kind: 'anchored', text: current, depth: depth };
      }
      if (depth === CONFIG.MAX_NESTING_DEPTH || !looksLikeBase64(current)) break;
      const next = decodeOnce(current);
      if (next === null) break;
      current = next;
    }

    if (allowHeuristic && readable(first)) {
      return { kind: 'heuristic', text: first, depth: 1 };
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 문서 순회 - 세그먼트 만들기
   * ------------------------------------------------------------------ */

  const visited = new WeakSet();

  function isSkippable(el) {
    if (el.isContentEditable) return true; // 상속되므로 조상까지 한 번에 걸린다
    for (let n = el; n; n = n.parentElement) {
      // SVG/MathML 안에 HTML span 을 끼우면 그려지지 않는다. 통째로 건너뛴다.
      if (n.namespaceURI !== XHTML) return true;
      if (SKIP_TAGS.has(n.localName)) return true;
      if (n.hasAttribute(OURS)) return true; // 우리가 만든 것은 다시 훑지 않는다
    }
    return false;
  }

  function blockOwner(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && !BLOCK_TAGS.has(el.localName)) el = el.parentElement;
    return el || document.body;
  }

  /**
   * 인접한 텍스트 노드를 하나의 문자열로 잇는다.
   *
   * <wbr>, <mark>, 문법 강조용 <span> 때문에 하나의 토큰이 여러 노드로
   * 쪼개져 있는 일이 흔하다. 노드 단위로만 보면 이런 토큰은 절반만 잡히거나
   * 아예 안 잡힌다. 반대로 <br> 이나 블록 요소를 사이에 둔 텍스트는 서로
   * 다른 줄이므로 경계 표식을 끼워 합쳐지지 않게 한다.
   */
  function collectSegments(root) {
    const scope = root.nodeType === 1 ? root : root.parentElement;
    if (!scope) return [];

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (node.nodeType === 1) {
          // 요소는 경계 판단에만 쓴다. 안쪽은 계속 내려간다.
          return BREAK_TAGS.has(node.localName) || BLOCK_TAGS.has(node.localName)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        }
        if (visited.has(node)) return NodeFilter.FILTER_REJECT;
        if (!node.data.length) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || isSkippable(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const segments = [];
    let current = null;
    let breakPending = false;
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 1) { breakPending = true; continue; }
      visited.add(node);
      const owner = blockOwner(node);
      if (!current || current.owner !== owner) {
        current = { owner: owner, nodes: [], text: '' };
        segments.push(current);
        breakPending = false;
      } else if (breakPending) {
        current.text += HARD_BREAK;
        breakPending = false;
      }
      current.nodes.push({ node: node, start: current.text.length, length: node.data.length });
      current.text += node.data;
    }
    return segments;
  }

  // 수집 이후 페이지가 텍스트를 바꿨다면 좌표를 믿을 수 없다.
  function isStale(seg) {
    return seg.nodes.some(function (entry) {
      return !entry.node.isConnected || entry.node.data.length !== entry.length;
    });
  }

  function isSpace(ch) {
    return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t'
      || ch === '\f' || ch === '\v' || ch === '\u00a0';
  }

  // 공백을 제거한 사본과, 그 인덱스를 원본 인덱스로 되돌리는 표를 만든다.
  function compactOf(text) {
    let compact = '';
    const map = [];
    for (let i = 0; i < text.length; i++) {
      if (isSpace(text[i])) continue;
      map.push(i);
      compact += text[i];
    }
    return { compact: compact, map: map };
  }

  /* ------------------------------------------------------------------ *
   * 탐지
   * ------------------------------------------------------------------ */

  let findingCount = 0;
  let autoHeuristicCount = 0;
  let autoCapNotified = false;
  let halted = false;

  function scanSegment(seg) {
    const found = [];
    const seen = new Set();

    function consider(start, end, crossesSpace) {
      const key = start + ':' + end;
      if (seen.has(key)) return;
      seen.add(key);

      const raw = seg.text.slice(start, end);
      // 공백을 넘어 이어붙인 매칭은 우연히 만들어졌을 수 있다. 결과를 검증할 수
      // 있는 앵커 경로만 허용한다.
      const result = analyze(raw, { heuristic: !crossesSpace && settings.heuristicEnabled });
      if (!result) return;
      found.push({
        start: start, end: end, raw: raw,
        kind: result.kind, text: result.text, depth: result.depth,
      });
    }

    let m;
    CANDIDATE_RE.lastIndex = 0;
    while ((m = CANDIDATE_RE.exec(seg.text)) !== null) {
      consider(m.index, m.index + m[0].length, false);
    }

    const compacted = compactOf(seg.text);
    if (compacted.compact.length !== seg.text.length) {
      CANDIDATE_RE.lastIndex = 0;
      while ((m = CANDIDATE_RE.exec(compacted.compact)) !== null) {
        const start = compacted.map[m.index];
        const end = compacted.map[m.index + m[0].length - 1] + 1;
        consider(start, end, end - start !== m[0].length);
      }
    }

    if (!found.length) return [];

    // 겹치는 후보는 긴 쪽을 남긴다.
    found.sort(function (a, b) { return (b.end - b.start) - (a.end - a.start); });
    const kept = [];
    for (const f of found) {
      const overlaps = kept.some(function (k) { return f.start < k.end && k.start < f.end; });
      if (!overlaps) kept.push(f);
    }
    kept.sort(function (a, b) { return a.start - b.start; });
    return kept;
  }

  // 세그먼트 좌표를 실제 텍스트 노드 조각들로 되돌린다.
  function piecesFor(seg, finding) {
    const pieces = [];
    for (let i = 0; i < seg.nodes.length; i++) {
      const entry = seg.nodes[i];
      const nodeStart = entry.start;
      const nodeEnd = entry.start + entry.length;
      if (nodeEnd <= finding.start || nodeStart >= finding.end) continue;
      pieces.push({
        index: i,
        node: entry.node,
        from: Math.max(finding.start, nodeStart) - nodeStart,
        to: Math.min(finding.end, nodeEnd) - nodeStart,
      });
    }
    return pieces;
  }

  /* ------------------------------------------------------------------ *
   * 표시
   * ------------------------------------------------------------------ */

  let observer = null;

  // 우리가 만든 변화는 감시 대상이 아니다. 콜백은 마이크로태스크로 나중에
  // 오므로 플래그로는 막을 수 없고, 쌓인 기록을 비워야 한다.
  function withoutObserving(fn) {
    try { return fn(); } finally {
      if (observer) observer.takeRecords();
    }
  }

  function wrapPiece(piece) {
    let target = piece.node;
    if (!target.parentNode) return null;
    if (piece.from > 0) target = target.splitText(piece.from);
    if (piece.to - piece.from < target.data.length) {
      visited.add(target.splitText(piece.to - piece.from));
    }
    const span = document.createElement('span');
    span.setAttribute(OURS, 'src');
    const parent = target.parentNode;
    if (!parent) return null;
    parent.insertBefore(span, target);
    span.appendChild(target);
    visited.add(target);
    return span;
  }

  // 페이지 전체 상한을 넘기지 않는 범위에서 받아들일 것만 고른다.
  function admit(findings) {
    const accepted = [];
    for (const finding of findings) {
      if (findingCount >= CONFIG.MAX_FINDINGS_PER_PAGE) break;
      findingCount++;
      accepted.push(finding);
    }
    return accepted;
  }

  // 휴리스틱 결과를 바로 펼칠지 결정한다. 상한을 넘으면 배지로 접는다.
  function shouldAutoExpand(finding) {
    if (finding.kind === 'anchored') return true;
    if (!settings.autoExpandHeuristic) return false;
    if (autoHeuristicCount >= CONFIG.MAX_AUTO_HEURISTIC) {
      notifyAutoCap();
      return false;
    }
    autoHeuristicCount++;
    return true;
  }

  function processSegment(seg) {
    if (halted || !seg.owner.isConnected) return;
    if (isStale(seg)) {
      // 바뀐 노드를 다시 볼 수 있게 풀어주고, 다음 변화 감시 주기에 맡긴다.
      seg.nodes.forEach(function (entry) { visited.delete(entry.node); });
      markDirty(seg.owner);
      return;
    }

    const findings = admit(scanSegment(seg));
    if (!findings.length) return;

    withoutObserving(function () {
      // 원문 표시는 DOM 을 쪼개므로, 뒤에서부터 적용해야 앞쪽 좌표가 살아남는다.
      const work = [];
      findings.forEach(function (finding, order) {
        piecesFor(seg, finding).forEach(function (piece) {
          work.push({ piece: piece, order: order });
        });
      });
      work.sort(function (a, b) {
        if (a.piece.index !== b.piece.index) return b.piece.index - a.piece.index;
        return b.piece.from - a.piece.from;
      });

      const spansByFinding = findings.map(function () { return []; });
      for (const item of work) {
        const span = wrapPiece(item.piece);
        if (span) spansByFinding[item.order].unshift(span);
      }

      // 앵커 경로는 항상 바로 펼친다. 휴리스틱 경로는 기본적으로 배지만 달지만,
      // 사용자가 원하면 같이 펼친다.
      const expanded = [];
      findings.forEach(function (finding, order) {
        const spans = spansByFinding[order];
        if (!spans.length) return;
        const entry = { finding: finding, spans: spans };
        if (shouldAutoExpand(finding)) expanded.push(entry);
        else attachBadge(seg.owner, entry);
      });

      if (expanded.length) buildBlock(seg.owner, expanded);
    });

    if (findingCount >= CONFIG.MAX_FINDINGS_PER_PAGE) halt();
  }

  function halt() {
    halted = true;
    pending.length = 0;
    dirty.clear();
    if (observer) observer.disconnect();
  }

  // 휴리스틱 경로는 확신할 수 없으므로 결과를 바로 보여주지 않는다.
  // "여기 뭔가 있을지도 모른다" 는 표식만 달고, 눌러야 펼친다.
  function attachBadge(owner, entry) {
    const lastSpan = entry.spans[entry.spans.length - 1];
    if (!lastSpan.parentNode) return;
    const badge = document.createElement('span');
    badge.setAttribute(OURS, 'badge');
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');
    badge.title = 'base64 로 보입니다. 눌러서 디코딩 결과 보기';
    badge.textContent = '🔓';
    lastSpan.after(badge);

    let host = null;
    function toggle(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!host) {
        host = withoutObserving(function () { return buildBlock(owner, [entry]); });
        badge.textContent = '🔒';
        return;
      }
      host.hidden = !host.hidden;
      badge.textContent = host.hidden ? '🔓' : '🔒';
    }
    badge.addEventListener('click', toggle);
    badge.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') toggle(ev);
    });
  }

  function insertBlock(owner, host) {
    const parent = owner.parentElement;
    if (owner === document.body || !parent) {
      document.body.appendChild(host);
      return;
    }
    const inside = INSERT_INSIDE.has(owner.localName) || STRICT_PARENTS.has(parent.localName);
    if (inside) owner.appendChild(host);
    else owner.after(host);
  }

  /* 배경 밝기를 보고 팔레트를 고른다. 사이트마다 테마가 제각각이라
     OS 설정만으로는 어긋난다. */
  function isDarkBackground(el) {
    for (let n = el; n; n = n.parentElement) {
      let bg;
      try { bg = getComputedStyle(n).backgroundColor; } catch (e) { break; }
      const m = bg && bg.match(/rgba?\(([^)]+)\)/);
      if (!m) continue;
      const parts = m[1].split(',').map(function (v) { return parseFloat(v); });
      if (parts.length >= 4 && parts[3] === 0) continue; // 투명하면 더 올라간다
      const lum = (0.299 * parts[0] + 0.587 * parts[1] + 0.114 * parts[2]) / 255;
      return lum < 0.5;
    }
    return false;
  }

  const LIGHT = {
    bg: '#f6f8fa', border: '#d5dae0', fg: '#1f2328', dim: '#6b7280',
    link: '#0a58ca', mark: '#fff3bf', accent: '#0969da',
  };
  const DARK = {
    bg: '#1c2128', border: '#3d444d', fg: '#e6edf3', dim: '#9198a1',
    link: '#79c0ff', mark: '#4d3800', accent: '#58a6ff',
  };

  function blockStyles(p) {
    return [
      ':host { all: initial; display: block; }',
      ':host([hidden]) { display: none; }',
      '.wrap {',
      '  margin: 6px 0; padding: 8px 10px;',
      '  border: 1px solid ' + p.border + '; border-left: 3px solid ' + p.accent + ';',
      '  border-radius: 6px; background: ' + p.bg + '; color: ' + p.fg + ';',
      '  font: 13px/1.6 -apple-system, "Segoe UI", "Malgun Gothic", system-ui, sans-serif;',
      '  text-align: left; box-sizing: border-box;',
      '}',
      '.hd { display: flex; align-items: center; gap: 6px; font-size: 11px;',
      '      color: ' + p.dim + '; margin-bottom: 6px; }',
      '.hd .tag { border: 1px solid ' + p.border + '; border-radius: 999px; padding: 0 6px; }',
      '.item { display: flex; gap: 6px; padding: 2px 0; }',
      '.item + .item { border-top: 1px dashed ' + p.border + '; margin-top: 4px; padding-top: 6px; }',
      '.item.hl { background: ' + p.mark + '; border-radius: 4px; }',
      '.num { flex: 0 0 auto; color: ' + p.dim + '; }',
      '.col { flex: 1 1 auto; min-width: 0; }',
      '.body { overflow-wrap: anywhere; white-space: pre-wrap; }',
      '.body.clipped { display: -webkit-box; -webkit-line-clamp: 8;',
      '                -webkit-box-orient: vertical; overflow: hidden; }',
      'a { color: ' + p.link + '; text-decoration: underline; }',
      'a strong { font-weight: 700; }',
      '.tools { margin-top: 4px; display: flex; gap: 6px; }',
      'button {',
      '  font: inherit; font-size: 11px; cursor: pointer; padding: 1px 8px;',
      '  border: 1px solid ' + p.border + '; border-radius: 4px;',
      '  background: transparent; color: ' + p.dim + ';',
      '}',
      'button:hover { color: ' + p.fg + '; }',
    ].join('\n');
  }

  function makeLink(url) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = url;
    let host = '';
    try { host = new URL(url).host; } catch (e) { /* magnet 등은 host 가 없다 */ }
    const at = host ? url.indexOf(host) : -1;
    if (at === -1) {
      a.textContent = url;
      return a;
    }
    // 어디로 가는지 눈에 띄게 - base64 는 피싱 주소를 감추는 데 자주 쓰인다.
    a.appendChild(document.createTextNode(url.slice(0, at)));
    const strong = document.createElement('strong');
    strong.textContent = host;
    a.appendChild(strong);
    a.appendChild(document.createTextNode(url.slice(at + host.length)));
    return a;
  }

  function renderText(container, text) {
    container.textContent = '';
    URL_RE.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = URL_RE.exec(text)) !== null) {
      if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
      container.appendChild(makeLink(m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.setAttribute(OURS, 'scratch');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 복사 실패 */ }
    ta.remove();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function kindLabel(entries) {
    const kinds = new Set(entries.map(function (e) { return e.finding.kind; }));
    if (!kinds.has('heuristic')) return '링크 확정';
    if (!kinds.has('anchored')) return '추정';
    return '링크 + 추정';
  }

  function buildItem(entry, index, numbered) {
    const item = document.createElement('div');
    item.className = 'item';

    if (numbered) {
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = index < NUMERALS.length ? NUMERALS[index] : String(index + 1) + '.';
      item.appendChild(num);
      // 원문 쪽에도 같은 번호를 달아 연결고리를 만든다.
      const lastSpan = entry.spans[entry.spans.length - 1];
      if (lastSpan && lastSpan.parentNode) {
        const mark = document.createElement('sup');
        mark.setAttribute(OURS, 'num');
        mark.textContent = num.textContent;
        lastSpan.after(mark);
      }
    }

    const col = document.createElement('div');
    col.className = 'col';

    const body = document.createElement('div');
    body.className = 'body';
    const text = entry.finding.text;
    const long = text.length > CONFIG.COLLAPSE_LENGTH;
    renderText(body, long ? text.slice(0, CONFIG.COLLAPSE_LENGTH) : text);
    if (long) body.classList.add('clipped');
    col.appendChild(body);

    if (long) {
      const tools = document.createElement('div');
      tools.className = 'tools';

      let expanded = false;
      const more = document.createElement('button');
      more.textContent = '더 보기';
      more.addEventListener('click', function () {
        expanded = !expanded;
        renderText(body, expanded ? text : text.slice(0, CONFIG.COLLAPSE_LENGTH));
        body.classList.toggle('clipped', !expanded);
        more.textContent = expanded ? '접기' : '더 보기';
      });
      tools.appendChild(more);

      const copy = document.createElement('button');
      copy.textContent = '복사';
      copy.addEventListener('click', function () {
        copyText(text);
        copy.textContent = '복사됨';
        setTimeout(function () { copy.textContent = '복사'; }, 1200);
      });
      tools.appendChild(copy);

      col.appendChild(tools);
    }

    item.appendChild(col);
    return item;
  }

  // 원문과 결과를 서로 가리키게 한다.
  function linkHover(entry, item) {
    function on() {
      item.classList.add('hl');
      entry.spans.forEach(function (s) { s.setAttribute(OURS + '-hl', '1'); });
    }
    function off() {
      item.classList.remove('hl');
      entry.spans.forEach(function (s) { s.removeAttribute(OURS + '-hl'); });
    }
    entry.spans.forEach(function (s) {
      s.addEventListener('mouseenter', on);
      s.addEventListener('mouseleave', off);
    });
    item.addEventListener('mouseenter', on);
    item.addEventListener('mouseleave', off);
  }

  function buildBlock(owner, entries) {
    const host = document.createElement('div');
    host.setAttribute(OURS, 'block');
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = blockStyles(isDarkBackground(owner) ? DARK : LIGHT);
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const head = document.createElement('div');
    head.className = 'hd';
    const label = document.createElement('span');
    label.textContent = '디코딩 결과';
    head.appendChild(label);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = kindLabel(entries);
    head.appendChild(tag);
    wrap.appendChild(head);

    const numbered = entries.length >= 2;
    entries.forEach(function (entry, i) {
      const item = buildItem(entry, i, numbered);
      wrap.appendChild(item);
      if (entry.spans.length) linkHover(entry, item);
    });

    shadow.appendChild(wrap);
    insertBlock(owner, host);
    return host;
  }

  /* ------------------------------------------------------------------ *
   * 페이지에 주입하는 최소한의 스타일과 알림
   * ------------------------------------------------------------------ */

  function injectPageStyle() {
    const style = document.createElement('style');
    style.setAttribute(OURS, 'style');
    style.textContent = [
      '[' + OURS + '="src"] {',
      '  text-decoration: underline dotted currentColor !important;',
      '  text-underline-offset: 2px !important;',
      '}',
      '[' + OURS + '="src"][' + OURS + '-hl="1"] {',
      '  background: rgba(255, 213, 79, 0.45) !important;',
      '  border-radius: 2px !important;',
      '}',
      '[' + OURS + '="num"] { font-size: 0.75em !important; opacity: 0.7 !important; }',
      '[' + OURS + '="badge"] {',
      '  cursor: pointer !important; font-size: 0.85em !important; opacity: 0.7 !important;',
      '  margin-left: 2px !important; user-select: none !important;',
      '}',
      '[' + OURS + '="badge"]:hover, [' + OURS + '="badge"]:focus { opacity: 1 !important; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function notify(message) {
    const host = document.createElement('div');
    host.setAttribute(OURS, 'notice');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = '.n{font:12px/1.5 -apple-system,"Segoe UI","Malgun Gothic",system-ui,sans-serif;'
      + 'background:#1c2128;color:#e6edf3;border:1px solid #3d444d;border-radius:6px;'
      + 'padding:8px 12px;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:280px;}';
    const box = document.createElement('div');
    box.className = 'n';
    box.textContent = message;
    shadow.appendChild(style);
    shadow.appendChild(box);
    withoutObserving(function () { document.body.appendChild(host); });
    setTimeout(function () { withoutObserving(function () { host.remove(); }); }, 5000);
  }

  function notifyAutoCap() {
    if (autoCapNotified) return;
    autoCapNotified = true;
    notify('추정 결과 ' + CONFIG.MAX_AUTO_HEURISTIC + '개를 자동으로 펼쳤습니다. '
      + '나머지는 🔓 배지로 표시하니 눌러서 보세요.');
  }

  /* ------------------------------------------------------------------ *
   * 스케줄링
   * ------------------------------------------------------------------ */

  const idle = typeof window.requestIdleCallback === 'function'
    ? function (fn) { window.requestIdleCallback(fn, { timeout: 500 }); }
    : function (fn) { setTimeout(fn, 16); };

  const pending = [];
  let running = false;

  function enqueue(root) {
    if (halted) return;
    let segments;
    try {
      segments = collectSegments(root);
    } catch (e) {
      console.warn('[base64-autodecoder] 순회 실패:', e);
      return;
    }
    for (const seg of segments) pending.push(seg);
    if (pending.length && !running) {
      running = true;
      idle(step);
    }
  }

  function step() {
    let n = 0;
    while (pending.length && n < CONFIG.CHUNK_SIZE && !halted) {
      try {
        processSegment(pending.shift());
      } catch (e) {
        console.warn('[base64-autodecoder] 세그먼트 처리 실패:', e);
      }
      n++;
    }
    if (pending.length && !halted) idle(step);
    else running = false;
  }

  /* ------------------------------------------------------------------ *
   * 변화 감시
   * ------------------------------------------------------------------ */

  let debounceTimer = null;
  const dirty = new Set();

  function markDirty(el) {
    if (halted || !el) return;
    dirty.add(el);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, CONFIG.MUTATION_DEBOUNCE_MS);
  }

  function flush() {
    const roots = Array.from(dirty);
    dirty.clear();
    for (const root of roots) {
      if (root.isConnected) enqueue(root);
    }
  }

  function watch() {
    observer = new MutationObserver(function (mutations) {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          // 제자리에서 글자가 바뀐 노드는 다시 봐야 한다.
          const el = mutation.target.parentElement;
          if (!el || el.closest('[' + OURS + ']')) continue;
          visited.delete(mutation.target);
          markDirty(el);
          continue;
        }
        for (const node of mutation.addedNodes) {
          let el = null;
          if (node.nodeType === 1) el = node;
          else if (node.nodeType === 3) el = node.parentElement;
          if (!el || el.closest('[' + OURS + ']')) continue;
          markDirty(el);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
    });
  }

  /* ------------------------------------------------------------------ *
   * 드래그 수동 디코딩
   * ------------------------------------------------------------------ */

  let lastManual = '';

  function onMouseUp() {
    setTimeout(function () {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const anchor = selection.anchorNode;
      if (!anchor) return;
      const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
      if (!el || el.closest('[' + OURS + ']') || isSkippable(el)) return;

      const raw = selection.toString().replace(/\s+/g, '');
      // 수동 경로는 사용자가 직접 지목한 것이므로 최소 길이를 낮춘다.
      if (raw.length < 8 || raw === lastManual) return;
      if (!B64_LOOSE.test(raw)) return;

      const result = analyze(raw);
      if (!result) return;
      lastManual = raw;

      withoutObserving(function () {
        buildBlock(blockOwner(anchor), [{ finding: result, spans: [] }]);
      });
    }, 0);
  }

  /* ------------------------------------------------------------------ *
   * 메뉴
   * ------------------------------------------------------------------ */

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    const host = location.hostname;
    const blocked = settings.blacklist.indexOf(host) !== -1;

    GM_registerMenuCommand(
      (settings.heuristicEnabled ? '☑' : '☐') + ' 추정 탐지 (링크가 아닌 base64)',
      function () {
        settings.heuristicEnabled = !settings.heuristicEnabled;
        store.write(settings);
        notify('추정 탐지를 ' + (settings.heuristicEnabled ? '켰습니다' : '껐습니다')
          + '. 새로고침하면 적용됩니다.');
      }
    );

    GM_registerMenuCommand(
      (settings.autoExpandHeuristic ? '☑' : '☐') + ' 추정 결과도 바로 펼치기 (배지 대신)',
      function () {
        settings.autoExpandHeuristic = !settings.autoExpandHeuristic;
        store.write(settings);
        notify('추정 결과를 ' + (settings.autoExpandHeuristic ? '바로 펼칩니다' : '배지로만 표시합니다')
          + '. 새로고침하면 적용됩니다.');
      }
    );

    GM_registerMenuCommand(
      blocked ? '▶ 이 사이트에서 켜기 (' + host + ')' : '⏸ 이 사이트에서 끄기 (' + host + ')',
      function () {
        const at = settings.blacklist.indexOf(host);
        if (at === -1) settings.blacklist.push(host);
        else settings.blacklist.splice(at, 1);
        store.write(settings);
        location.reload();
      }
    );

    GM_registerMenuCommand('📋 끈 사이트 목록 관리', function () {
      const input = window.prompt(
        '동작을 끈 사이트 목록입니다. 쉼표로 구분해 편집하세요.',
        settings.blacklist.join(', ')
      );
      if (input === null) return;
      settings.blacklist = input.split(',')
        .map(function (s) { return s.trim(); })
        .filter(Boolean);
      store.write(settings);
      notify('저장했습니다. 새로고침하면 적용됩니다.');
    });

    GM_registerMenuCommand('↺ 기본값으로 되돌리기', function () {
      if (!window.confirm('모든 설정을 기본값으로 되돌릴까요?')) return;
      settings.heuristicEnabled = DEFAULTS.heuristicEnabled;
      settings.autoExpandHeuristic = DEFAULTS.autoExpandHeuristic;
      settings.blacklist = [];
      store.write(settings);
      location.reload();
    });
  }

  /* ------------------------------------------------------------------ *
   * 시작
   * ------------------------------------------------------------------ */

  registerMenu();

  if (settings.blacklist.indexOf(location.hostname) !== -1) return;

  injectPageStyle();
  enqueue(document.body);
  watch();
  document.addEventListener('mouseup', onMouseUp, true);
})();
