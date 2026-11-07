// AIによる資料間の照合（意味の食い違い・反映漏れ）
// ルール照合（public/js/core/check.js）で拾えない「内容の矛盾」をClaudeに探させる。
// AIの指摘は、根拠として引用した文言が本当に資料にあるかをここで確かめ、無ければ「根拠未確認」にする。
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const MAX_CHARS = 600_000; // これを超える量は送らずに、資料を分けてもらう

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'severity', 'key', 'title', 'message', 'evidence'],
        properties: {
          category: { type: 'string', enum: ['寸法', '品番', '数量', '記載漏れ', '仕様', 'その他'] },
          severity: { type: 'string', enum: ['ng', 'check'] },
          key: { type: 'string', description: '記号・品番・部位など、指摘の対象' },
          title: { type: 'string', description: '1行の見出し（40字以内）' },
          message: { type: 'string', description: '何と何が食い違っているか、確認してほしいこと（120字以内）' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['doc', 'location', 'quote'],
              properties: {
                doc: { type: 'string', description: '資料名（与えられた名前そのまま）' },
                location: { type: 'string', description: 'p.1 や 見積!12行 など' },
                quote: { type: 'string', description: '資料からそのまま書き写した短い文言' },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `あなたは住宅会社（注文住宅）の工事監督を手伝う、資料照合の担当者です。
図面・建具表・仕上表・設備仕様書・見積書の文字情報が渡されます。資料どうしの「内容の食い違い」と「記載漏れ」を探してください。

探すもの:
- 寸法の食い違い（同じ建具・部材の W/H/D が資料によって違う）
- 品番・型番の食い違い（同じ部位なのに品番が違う、1文字違い）
- 数量の食い違い（図面の数と表・見積の数量が違う）
- 記載漏れ（図面や仕様書にある器具・仕様が見積や表に無い）
- 仕様の反映漏れ（例：仕様書は Low-E複層ガラスなのに見積は単板、色・グレードの違い）

決まり:
- 「ルール照合で検出済み」として渡したものと同じ指摘は出さない。
- 根拠は必ず資料の文字をそのまま書き写す（quote）。書き写せない推測は出さない。
- 確実に食い違っているものは severity "ng"、担当者に確かめてほしいものは "check"。
- 単位の違いだけ（m2 と ㎡、箇所 と ヶ所）や、見積にだけある諸経費・運搬費などは指摘しない。
- 見つからなければ findings は空でよい。数を増やすために弱い指摘を足さない。`;

export function aiEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function docToText(d) {
  if (d.kind === 'pdf') {
    return d.pages.map(p => `[p.${p.page}]\n` + p.lines.join(' | ')).join('\n');
  }
  return d.sheets.map(s => `[シート ${s.name}]\n` + s.rows.map(r => `${r.n}行: ${r.cells.join(' | ')}`).join('\n')).join('\n');
}

export async function aiCheck({ docs, ruleFindings }) {
  const blocks = docs.map(d => `<資料 name="${d.name}" 種類="${d.roleLabel}">\n${docToText(d)}\n</資料>`);
  const total = blocks.reduce((n, b) => n + b.length, 0);
  if (total > MAX_CHARS) {
    const err = new Error(`資料の文字数が多すぎます（${total.toLocaleString()}字）。照合する資料を減らすか、ページを分けてください。`);
    err.status = 413;
    throw err;
  }
  const already = ruleFindings.length
    ? ruleFindings.map(f => `- ${f.title}（${f.message}）`).join('\n')
    : '（なし）';

  const client = new Anthropic();
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `${blocks.join('\n\n')}\n\n<ルール照合で検出済み>\n${already}\n</ルール照合で検出済み>\n\n上の資料どうしを照合し、食い違いと記載漏れを挙げてください。`,
    }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    const err = new Error('AIが照合を断りました。資料の内容を確認して、もう一度お試しください。');
    err.status = 422;
    throw err;
  }
  if (msg.stop_reason === 'max_tokens') {
    const err = new Error('AIの回答が長くなりすぎて途中で止まりました。資料を減らしてお試しください。');
    err.status = 422;
    throw err;
  }
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    const err = new Error('AIの回答を読み取れませんでした。もう一度お試しください。');
    err.status = 502;
    throw err;
  }
  return {
    model: msg.model,
    usage: msg.usage,
    findings: verify(parsed.findings || [], docs),
  };
}

// 根拠の文言が、その資料の中に本当にあるか（空白・区切りを無視して探す）
const squash = s => String(s || '').normalize('NFKC').replace(/[\s|｜]/g, '').toUpperCase();
export function verify(findings, docs) {
  const texts = new Map(docs.map(d => [d.name, squash(docToText(d))]));
  return findings.map((f, i) => {
    const evidence = (f.evidence || []).map(e => {
      const t = texts.get(e.doc) ?? [...texts.entries()].find(([n]) => n.includes(e.doc) || e.doc.includes(n))?.[1];
      const q = squash(e.quote);
      return { ...e, verified: Boolean(t && q && t.includes(q)) };
    });
    const allOk = evidence.length > 0 && evidence.every(e => e.verified);
    return {
      id: 'a' + (i + 1), source: 'ai', kind: 'ai', category: f.category, severity: allOk ? f.severity : 'check',
      key: f.key, title: f.title, message: f.message, verified: allOk,
      obs: evidence.map(e => ({ doc: e.doc, loc: e.location, value: e.quote, verified: e.verified })),
    };
  });
}
