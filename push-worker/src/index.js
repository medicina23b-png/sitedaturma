/**
 * Worker da Cloudflare "push-23b" — notificações do app Medicina 23B.
 *
 * Plano grátis da Cloudflare, sem cartão, e sem Cloud Functions (o Firebase
 * continua no plano gratuito Spark). Faz duas coisas:
 *
 * 1. PUSH EM TEMPO REAL — o navegador do presidente grava as notificações em
 *    notificacoes/{usuario}/itens (pushEnviado: false) e logo em seguida chama
 *    este Worker (POST /, com o token do Firebase). O Worker lê o que está
 *    pendente, manda o push pelo Firebase Cloud Messaging pra cada aparelho
 *    da pessoa (coleção pushTokens) e marca pushEnviado: true.
 *
 * 2. LEMBRETE 2H ANTES (a cada 5 minutos, pelo "cron") — procura eventos de
 *    hoje/amanhã que começam em até 2 horas; pra cada discente cujo nome está
 *    na lista do evento, cria a notificação (que vira push) e manda e-mail com
 *    os dados do evento (via Brevo, grátis até 300 e-mails/dia). Cada lembrete
 *    é enviado uma vez só (controle em lembretes2h/{evento_data_hora}); se o
 *    presidente mudar o horário, sai um lembrete novo pro horário novo.
 *
 * Também roda o item 1 a cada 5 minutos, como rede de segurança.
 *
 * Configuração: ver push-worker/README.md.
 */

const SCOPES = 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging';
// O plano grátis permite 50 chamadas externas por execução. Guardamos uma
// folga; se sobrar trabalho, o Worker chama a si mesmo (binding SELF) e
// continua numa execução nova.
const ORCAMENTO_CHAMADAS = 44;

/* ============================ utilidades ============================ */

class Orcamento {
  constructor(max) { this.usadas = 0; this.max = max; }
  get sobra() { return this.max - this.usadas; }
  async fetch(url, init) { this.usadas++; return fetch(url, init); }
}

const b64url = (buf) => {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
const b64urlDecode = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function contaDeServico(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Falta o segredo FIREBASE_SERVICE_ACCOUNT (ver README).');
  return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
}
const projeto = (env) => env.FIREBASE_PROJECT_ID || contaDeServico(env).project_id;

/* ===================== token de acesso do Google ===================== */

let tokenCache = null; // { token, exp } — reaproveitado enquanto o Worker estiver "quente"

async function tokenGoogle(env, orc) {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  const sa = contaDeServico(env);
  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = b64urlJson({ alg: 'RS256', typ: 'JWT' });
  const corpo = b64urlJson({ iss: sa.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const chave = await crypto.subtle.importKey('pkcs8', b64urlDecode(pem.replace(/\+/g, '-').replace(/\//g, '_')), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const assinatura = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(cabecalho + '.' + corpo));
  const jwt = cabecalho + '.' + corpo + '.' + b64url(assinatura);
  const r = await orc.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Falha ao obter token do Google: ' + JSON.stringify(j));
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

/* ===================== conferir o token do Firebase ===================== */
// Só quem está logado no app pode pedir "envia os pushes agora".

let jwksCache = null;
async function verificarIdToken(env, idToken, orc) {
  const [h, p, s] = String(idToken || '').split('.');
  if (!h || !p || !s) return null;
  let cab, dados;
  try {
    cab = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    dados = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  } catch (e) { return null; }
  const proj = projeto(env);
  const agora = Math.floor(Date.now() / 1000);
  if (dados.aud !== proj || dados.iss !== 'https://securetoken.google.com/' + proj || !(dados.exp > agora)) return null;
  if (!jwksCache || jwksCache.exp < Date.now()) {
    const r = await orc.fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    jwksCache = { keys: (await r.json()).keys || [], exp: Date.now() + 3600000 };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === cab.kid);
  if (!jwk) return null;
  const chave = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', chave, b64urlDecode(s), new TextEncoder().encode(h + '.' + p));
  return ok ? dados : null;
}

/* ============================ Firestore (REST) ============================ */

function deValor(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(deValor);
  if ('mapValue' in v) return deCampos(v.mapValue.fields || {});
  return null;
}
function deCampos(fields) { const o = {}; Object.keys(fields || {}).forEach((k) => { o[k] = deValor(fields[k]); }); return o; }
function paraValor(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(paraValor) } };
  if (typeof x === 'object') return { mapValue: { fields: paraCampos(x) } };
  return { stringValue: String(x) };
}
function paraCampos(o) { const f = {}; Object.keys(o).forEach((k) => { f[k] = paraValor(o[k]); }); return f; }
const docDe = (d) => ({ _nome: d.name, id: d.name.split('/').pop(), ...deCampos(d.fields) });

class Firestore {
  constructor(env, orc) {
    this.env = env; this.orc = orc;
    this.raiz = `projects/${projeto(env)}/databases/(default)/documents`;
    this.base = 'https://firestore.googleapis.com/v1/' + this.raiz;
  }
  async req(url, init = {}) {
    const token = await tokenGoogle(this.env, this.orc);
    const r = await this.orc.fetch(url, { ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    return r;
  }
  async listar(colecao) {
    const out = [];
    let pagina = '';
    do {
      const r = await this.req(`${this.base}/${colecao}?pageSize=300${pagina ? '&pageToken=' + encodeURIComponent(pagina) : ''}`);
      const j = await r.json();
      if (!r.ok) throw new Error('Firestore listar ' + colecao + ': ' + JSON.stringify(j));
      (j.documents || []).forEach((d) => out.push(docDe(d)));
      pagina = j.nextPageToken || '';
    } while (pagina);
    return out;
  }
  async consultar(structuredQuery, pai = '') {
    const r = await this.req(`${this.base}${pai ? '/' + pai : ''}:runQuery`, { method: 'POST', body: JSON.stringify({ structuredQuery }) });
    const j = await r.json();
    if (!r.ok) { const e = new Error('Firestore consulta: ' + JSON.stringify(j)); e.status = (j[0] && j[0].error && j[0].error.status) || (j.error && j.error.status) || r.status; throw e; }
    return (Array.isArray(j) ? j : []).filter((x) => x.document).map((x) => docDe(x.document));
  }
  // Cria só se ainda não existir. true = criou; false = já existia.
  async criarSeNaoExiste(colecao, id, dados) {
    const r = await this.req(`${this.base}/${colecao}?documentId=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ fields: paraCampos(dados) }) });
    if (r.status === 409) return false;
    if (!r.ok) throw new Error('Firestore criar ' + colecao + '/' + id + ': ' + await r.text());
    return true;
  }
  // Várias gravações numa chamada só (economiza o limite de 50 chamadas).
  async commit(writes) {
    for (let i = 0; i < writes.length; i += 450) {
      const r = await this.req(`https://firestore.googleapis.com/v1/projects/${projeto(this.env)}/databases/(default)/documents:commit`, { method: 'POST', body: JSON.stringify({ writes: writes.slice(i, i + 450) }) });
      if (!r.ok) throw new Error('Firestore commit: ' + await r.text());
    }
  }
  nomeDoc(caminho) { return `${this.raiz}/${caminho}`; }
}

/* ============================ push (FCM) ============================ */

function urlDaNotificacao(env, n) {
  const base = (env.APP_URL || './').replace(/\?.*$/, '');
  if (n.tipo === 'evento' && n.refId) return base + '?evento=' + encodeURIComponent(n.refId);
  const aba = { mural: 'mural', arquivo: 'arquivos', data: 'datas', avaliacao: 'notas' }[n.tipo];
  return aba ? base + '?tab=' + aba : base;
}

// Devolve 'ok', 'invalido' (token morto: apagar) ou 'erro'.
async function enviarFcm(env, orc, token, dados) {
  const accessToken = await tokenGoogle(env, orc);
  const r = await orc.fetch(`https://fcm.googleapis.com/v1/projects/${projeto(env)}/messages:send`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        data: dados, // só "data": o sw.js monta a notificação (igual em Android, iPhone e PC)
        webpush: { headers: { Urgency: 'high', TTL: '86400' } },
        android: { priority: 'high' },
      },
    }),
  });
  if (r.ok) return 'ok';
  const txt = await r.text();
  if (r.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT.*token|not a valid FCM registration token/i.test(txt)) return 'invalido';
  console.log('FCM erro', r.status, txt.slice(0, 300));
  return 'erro';
}

// Notificações com pushEnviado == false (todas as pessoas de uma vez, via
// collection group "itens"). Se o índice de collection group não existir,
// cai pra uma consulta por usuário.
async function notificacoesPendentes(fs) {
  const filtro = { fieldFilter: { field: { fieldPath: 'pushEnviado' }, op: 'EQUAL', value: { booleanValue: false } } };
  try {
    return await fs.consultar({ from: [{ collectionId: 'itens', allDescendants: true }], where: filtro, limit: 300 });
  } catch (e) {
    console.log('Sem índice de collection group para pushEnviado — usando consulta por usuário. Veja o README.', e.message.slice(0, 200));
    const usuarios = await fs.listar('usuarios');
    const out = [];
    for (const u of usuarios) {
      if (fs.orc.sobra < 8) break;
      out.push(...await fs.consultar({ from: [{ collectionId: 'itens' }], where: filtro, limit: 50 }, 'notificacoes/' + u.id));
    }
    return out;
  }
}

async function enviarPendentes(env, orc) {
  const fs = new Firestore(env, orc);
  const pendentes = (await notificacoesPendentes(fs)).filter((n) => n._nome.indexOf('/notificacoes/') >= 0);
  if (!pendentes.length) return { enviados: 0, restam: false };
  const tokens = await fs.listar('pushTokens');
  const porUsuario = {};
  tokens.forEach((t) => { if (t.token && t.usuario) (porUsuario[t.usuario] = porUsuario[t.usuario] || []).push(t); });

  const writes = [];
  const mortos = new Set();
  let enviados = 0, restam = false;
  const limiteIdade = Date.now() - 24 * 3600 * 1000; // notificação de mais de 1 dia: só marca, não manda push atrasado

  pendentes.sort((a, b) => String(a.criadoEm || '').localeCompare(String(b.criadoEm || '')));
  for (const n of pendentes) {
    const usuario = n._nome.split('/notificacoes/')[1].split('/')[0];
    const aparelhos = (porUsuario[usuario] || []).filter((t) => !mortos.has(t.id));
    const velha = n.criadoEm && Date.parse(n.criadoEm) < limiteIdade;
    if (!velha && aparelhos.length) {
      if (orc.sobra - 2 < aparelhos.length) { restam = true; break; } // guarda 2 pro commit
      const dados = {
        titulo: String(n.titulo || 'Medicina 23B').slice(0, 120),
        corpo: String(n.corpo || '').slice(0, 400),
        url: urlDaNotificacao(env, n),
        tag: 'n-' + n.id,
        tipo: String(n.tipo || ''),
      };
      for (const t of aparelhos) {
        const res = await enviarFcm(env, orc, t.token, dados);
        if (res === 'ok') enviados++;
        if (res === 'invalido') { mortos.add(t.id); writes.push({ delete: fs.nomeDoc('pushTokens/' + t.id) }); }
      }
    }
    writes.push({ update: { name: n._nome, fields: { pushEnviado: { booleanValue: true } } }, updateMask: { fieldPaths: ['pushEnviado'] }, currentDocument: { exists: true } });
  }
  if (writes.length) await fs.commit(writes);
  return { enviados, restam };
}

/* ======================== lembrete 2h antes ======================== */

const PARTICULAS_NOME = ['de', 'da', 'do', 'das', 'dos', 'e'];
const dobraAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokensDeNome = (s) => dobraAcento(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && PARTICULAS_NOME.indexOf(t) < 0);
function mesmoNome(a, b) {
  if (!a.length || !b.length || a[0] !== b[0]) return false;
  const resto = (x, y) => x.slice(1).every((t) => y.indexOf(t) >= 0);
  return resto(a, b) || resto(b, a);
}
// Mesma regra do site (estouNesseEvento / citadosNoEvento no index.html).
function citados(evento, usuarios) {
  const nomes = String(evento.discentes || '').split('\n').map((linha) => {
    const m = linha.match(/^\s*\d+\s*\|\s*(.+?)\s*$/);
    return m ? tokensDeNome(m[1]) : null;
  }).filter(Boolean);
  if (!nomes.length) return [];
  return usuarios.filter((u) => u.id !== 'presidente' && nomes.some((n) => mesmoNome(tokensDeNome(u.nome || u.id), n)));
}

function offsetMin(env) {
  const m = String(env.TZ_OFFSET || '-03:00').match(/^([+-])(\d{2}):(\d{2})$/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : -180;
}
const diaLocal = (env, ms) => new Date(ms + offsetMin(env) * 60000).toISOString().slice(0, 10);
const inicioEm = (env, ev) => Date.parse(`${ev.data}T${(ev.inicio || '00:00').slice(0, 5)}:00${env.TZ_OFFSET || '-03:00'}`);

function disciplinaTexto(e) {
  if (e.disciplina === 'Tutoria' && e.tutoriaTipo) return 'Tutoria · ' + e.tutoriaTipo;
  if (e.disciplina === 'Habilidades Profissionais' && e.eixo) return 'Habilidades Profissionais / ' + e.eixo;
  if (e.disciplina === 'Gestão, Integração, Ensino, Serviço e Comunidade') return 'GIESC';
  return e.disciplina || '';
}
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
function dataTexto(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return `${DIAS[dt.getUTCDay()]}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => escHtml(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');

function emailHtml(env, ev) {
  const linhas = [
    ['Disciplina', disciplinaTexto(ev)],
    ['Data', dataTexto(ev.data)],
    ['Horário', ev.inicio + (ev.fim ? ' às ' + ev.fim : '')],
    ['Local', ev.local],
    ['Docente / Tutor(a)', ev.docente],
    ['Grupo', ev.grupo === 'TODOS' ? 'Turma toda' : ev.grupo],
    ['Roteiros', ev.roteiros],
    ['Observações', ev.observacoes],
  ].filter(([, v]) => v && String(v).trim());
  const url = urlDaNotificacao(env, { tipo: 'evento', refId: ev.id });
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#16181d">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border:1px solid #e7e9ee;border-radius:14px;padding:24px">
      <p style="margin:0 0 4px;color:#2547d0;font-size:12px;font-weight:bold;letter-spacing:.08em">MEDICINA 23B · LEMBRETE</p>
      <h1 style="margin:0 0 6px;font-size:20px;line-height:1.3">${escHtml(ev.titulo || 'Evento')}</h1>
      <p style="margin:0 0 18px;color:#565e6c">Olá, {{ params.nome }}! Seu nome está na lista deste evento, que começa às <b>${escHtml(ev.inicio)}</b>.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${linhas.map(([k, v]) => `<tr><td style="padding:8px 10px 8px 0;color:#8a92a1;vertical-align:top;white-space:nowrap;border-top:1px solid #f0f1f4">${escHtml(k)}</td><td style="padding:8px 0;border-top:1px solid #f0f1f4">${linkify(v)}</td></tr>`).join('')}
      </table>
      <p style="margin:22px 0 0"><a href="${escHtml(url)}" style="display:inline-block;background:#2547d0;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold">Abrir no app</a></p>
    </div>
    <p style="color:#8a92a1;font-size:12px;text-align:center;margin-top:14px">Aviso automático do Cronograma Acadêmico — Turma 23B.</p>
  </div></body></html>`;
}

async function enviarEmails(env, orc, ev, pessoas) {
  const destinos = pessoas.filter((u) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(u.email || '').trim()));
  if (!env.BREVO_API_KEY || !env.MAIL_FROM_EMAIL || !destinos.length) return 0;
  const r = await orc.fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME || 'Medicina 23B' },
      subject: `Lembrete: ${ev.titulo || 'evento'} às ${ev.inicio} (${dataTexto(ev.data)})`,
      htmlContent: emailHtml(env, ev),
      // um envio só, uma "versão" por pessoa (cada um recebe o seu, sem ver os outros)
      messageVersions: destinos.map((u) => ({ to: [{ email: String(u.email).trim(), name: u.nome || u.id }], params: { nome: String(u.nome || u.id).split(' ')[0] } })),
    }),
  });
  if (!r.ok) { console.log('Brevo erro', r.status, (await r.text()).slice(0, 300)); return 0; }
  return destinos.length;
}

const idAleatorio = () => b64url(crypto.getRandomValues(new Uint8Array(15))).replace(/[-_]/g, 'x').slice(0, 20);

async function lembretes2h(env, orc) {
  const fs = new Firestore(env, orc);
  const minutos = Number(env.LEMBRETE_MINUTOS || 120);
  const agora = Date.now();
  const hoje = diaLocal(env, agora), ate = diaLocal(env, agora + minutos * 60000);
  const eventos = await fs.consultar({
    from: [{ collectionId: 'eventos' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'data' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: hoje } } },
      { fieldFilter: { field: { fieldPath: 'data' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: ate } } },
    ] } },
  });
  const devidos = eventos.filter((ev) => {
    if (ev.cancelado === 'Sim' || !ev.inicio) return false;
    const falta = inicioEm(env, ev) - agora;
    return falta > 0 && falta <= minutos * 60000;
  });
  if (!devidos.length) return { lembretes: 0, emails: 0 };

  const usuarios = await fs.listar('usuarios');
  let lembretes = 0, emails = 0;
  for (const ev of devidos) {
    if (orc.sobra < 6) break; // o resto fica pro próximo ciclo (5 min)
    const pessoas = citados(ev, usuarios);
    const chave = `${ev.id}_${ev.data}_${String(ev.inicio).replace(':', '')}`;
    // "trava": só quem conseguir criar este documento envia (evita lembrete duplicado)
    if (!(await fs.criarSeNaoExiste('lembretes2h', chave, { eventoId: ev.id, data: ev.data, inicio: ev.inicio, enviadoEm: new Date().toISOString(), pessoas: pessoas.length }))) continue;
    if (!pessoas.length) continue;
    const corpo = [ev.inicio + (ev.fim ? '–' + ev.fim : ''), ev.local, disciplinaTexto(ev), ev.docente].filter(Boolean).join(' · ');
    const criadoEm = new Date().toISOString();
    // "Daqui a 2h" / "Daqui a 1h30" / "Daqui a 40 min" (arredondado de 5 em 5 min)
    const falta = Math.max(5, Math.round((inicioEm(env, ev) - agora) / 300000) * 5);
    const quando = falta >= 60 ? `${Math.floor(falta / 60)}h${falta % 60 ? String(falta % 60).padStart(2, '0') : ''}` : `${falta} min`;
    await fs.commit(pessoas.map((u) => ({
      update: {
        name: fs.nomeDoc(`notificacoes/${u.id}/itens/${idAleatorio()}`),
        fields: paraCampos({ tipo: 'evento', titulo: `Daqui a ${quando}: ${ev.titulo || 'evento'}`, corpo, refId: ev.id, lida: false, pushEnviado: false, criadoEm }),
      },
      currentDocument: { exists: false },
    })));
    lembretes += pessoas.length;
    emails += await enviarEmails(env, orc, ev, pessoas);
  }
  return { lembretes, emails };
}

/* ============================ entrada ============================ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// Se sobrou trabalho, continua numa execução nova (cada uma tem seu próprio
// limite de 50 chamadas). Precisa do binding SELF no wrangler.toml.
function continuar(env, ctx, profundidade) {
  if (!env.SELF || profundidade >= 8) return;
  ctx.waitUntil(env.SELF.fetch('https://interno/continuar', { method: 'POST', headers: { 'X-Continuar': String(profundidade + 1), 'X-Segredo': env.SEGREDO_INTERNO || 'x' } }).catch(() => {}));
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return new Response('ok', { headers: CORS });
    const orc = new Orcamento(ORCAMENTO_CHAMADAS);
    try {
      const prof = Number(req.headers.get('X-Continuar') || 0);
      const interno = prof > 0 && req.headers.get('X-Segredo') === (env.SEGREDO_INTERNO || 'x') && new URL(req.url).hostname === 'interno';
      if (!interno) {
        const auth = req.headers.get('Authorization') || '';
        const quem = await verificarIdToken(env, auth.replace(/^Bearer\s+/i, ''), orc);
        if (!quem) return json({ erro: 'não autorizado' }, 401);
      }
      const r = await enviarPendentes(env, orc);
      if (r.restam) continuar(env, ctx, prof);
      return json({ ok: true, ...r });
    } catch (e) {
      console.log('erro', e.stack || e.message);
      return json({ erro: String(e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    const orc = new Orcamento(ORCAMENTO_CHAMADAS);
    try {
      const l = await lembretes2h(env, orc);
      const p = await enviarPendentes(env, orc);
      if (p.restam) continuar(env, ctx, 0);
      console.log('ciclo', JSON.stringify({ ...l, ...p, chamadas: orc.usadas }));
    } catch (e) {
      console.log('erro no ciclo', e.stack || e.message);
    }
  },
};
