/**
 * ============================================================
 *  CRONOGRAMA ACADÊMICO — Cloud Functions (Firebase)
 * ============================================================
 *  Substitui o Google Apps Script (Code.gs). As operações que não exigem
 *  nenhum segredo nem lógica entre-usuários (salvar/editar evento, mural,
 *  arquivo, data importante, seguir evento, nota pessoal, objetivos da
 *  tutoria) passaram a ser GRAVAÇÕES DIRETAS do navegador no Firestore,
 *  autorizadas pelas regras em firestore.rules — é o mesmo nível de
 *  confiança que o Code.gs já dava ao presidente (um único usuário
 *  confiável, sem validação extra de servidor além de "é o presidente?").
 *
 *  Ficam aqui, como Cloud Functions, só as operações que PRECISAM de algo
 *  que o navegador não pode ter: a senha do presidente, o hash da senha de
 *  Notas de cada discente, ou uma operação que precisa tocar várias
 *  coleções de uma vez só, de forma atômica (Encerrar Semestre).
 *
 *  COMO IMPLANTAR
 *  1. firebase login
 *  2. firebase use --add        (escolha o projeto "turma23b")
 *  3. firebase functions:secrets:set PRESIDENTE_SENHA
 *  4. firebase deploy --only functions,firestore:rules
 *
 *  Ver README.md na raiz do repositório para o passo a passo completo.
 */

const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const crypto = require('crypto');

initializeApp();
const db = getFirestore();
const auth = getAuth();

setGlobalOptions({ region: 'southamerica-east1', maxInstances: 10 });

const PRESIDENTE_SENHA = defineSecret('PRESIDENTE_SENHA');

/* ------------------------------------------------------------------
 *  Constantes (espelham Code.gs)
 * ------------------------------------------------------------------ */
const DISCIPLINAS = ['Tutoria', 'Morfofuncional', 'Habilidades Profissionais', 'Gestão, Integração, Ensino, Serviço e Comunidade'];
const TIPOS_AVALIACAO = ['Somativa', 'Formativa', 'Completa'];
const DISCIPLINAS_COM_MODULO = ['Tutoria', 'Morfofuncional'];
const NOTAS_MAXIMAS_VALIDAS = [10, 6, 5, 4];
const USUARIO_PRESIDENTE = 'presidente';
const NOTAS_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutos — igual ao Code.gs

// Link que vai no final de todo e-mail automático e no corpo das
// notificações. Configure com a URL real do site publicado no Netlify
// (ex.: "https://turma23b.netlify.app"), usando:
//   firebase functions:config:set site.url="https://turma23b.netlify.app"
// ou (API v2) defina a variável de ambiente SITE_URL no painel do projeto.
// Sem configurar, cai num texto genérico (não quebra nada, só o link do
// rodapé do e-mail fica sem link de verdade).
function linkDoSite() {
  return process.env.SITE_URL || 'https://turma23b.netlify.app';
}

/* ------------------------------------------------------------------
 *  Helpers genéricos
 * ------------------------------------------------------------------ */
function hashSenha(senha) {
  return crypto.createHash('sha256').update(String(senha || '')).digest('hex');
}

function novaVersao() {
  return String(Date.now());
}

// Marca a coleção X como "mudou" para quem está sincronizando — mesmo papel
// de bumpVersaoDe_ no Code.gs, só que guardado num único documento
// meta/versions em vez de PropertiesService.
async function bumpVersao(campo) {
  await db.doc('meta/versions').set({ [campo]: novaVersao() }, { merge: true });
}

async function achaUsuarioDoc(usuario) {
  const id = String(usuario || '').trim().toLowerCase();
  if (!id) return null;
  const snap = await db.doc('usuarios/' + id).get();
  return snap.exists ? { id, ...snap.data() } : null;
}

// Grava um documento na coleção "mail" no formato esperado pela extensão
// oficial do Firebase "Trigger Email" (firestore-send-email) — é ela que de
// fato manda o e-mail (via SMTP configurado na instalação da extensão),
// substituindo o MailApp/GmailApp do Apps Script.
async function enviarEmail(email, assunto, corpo) {
  if (!email) return;
  try {
    await db.collection('mail').add({
      to: [email],
      message: { subject: assunto, text: corpo },
    });
  } catch (err) { /* e-mail nunca pode quebrar a ação principal */ }
}

async function enviarParaTodosComEmail(assunto, corpo, excetoUsuario) {
  const snap = await db.collection('usuarios').get();
  const envios = [];
  snap.forEach(doc => {
    const u = doc.data();
    if (doc.id === excetoUsuario) return;
    if (u && u.email) envios.push(enviarEmail(u.email, assunto, corpo));
  });
  await Promise.all(envios);
}

// Quem "está citado" num evento (nome aparece na lista de discentes do
// evento) — mesmo algoritmo tolerante a acento/maiúscula/apelido do
// estouNesseEvento()/tokensDeNome()/mesmoNome() do index.html, só que
// rodando no servidor pra decidir quem recebe notificação/e-mail mesmo que
// a pessoa nunca tenha clicado em "Acompanhar Evento".
const PARTICULAS_NOME = ['de', 'da', 'do', 'das', 'dos', 'e'];
function dobraAcento(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function tokensDeNome(s) { return dobraAcento(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t && PARTICULAS_NOME.indexOf(t) < 0); }
function mesmoNome(a, b) {
  if (!a.length || !b.length || a[0] !== b[0]) return false;
  const resto = (x, y) => x.slice(1).every(t => y.indexOf(t) >= 0);
  return resto(a, b) || resto(b, a);
}
function nomesCitadosEm(discentesTexto) {
  if (!discentesTexto) return [];
  return String(discentesTexto).split('\n').map(linha => {
    const m = linha.match(/^\s*\d+\s*\|\s*(.+?)\s*$/);
    return m ? tokensDeNome(m[1]) : null;
  }).filter(t => t && t.length);
}
async function usuariosComIdentidade() {
  const snap = await db.collection('usuarios').get();
  return snap.docs.filter(d => d.id !== USUARIO_PRESIDENTE).map(d => {
    const data = d.data();
    const identidades = [data.nome, d.id].map(v => tokensDeNome(v || '')).filter(t => t.length);
    return { usuario: d.id, identidades };
  });
}
function citadosNoEvento(evento, usuariosComId) {
  const nomes = nomesCitadosEm(evento && evento.discentes);
  if (!nomes.length) return [];
  return usuariosComId.filter(u => u.identidades.some(id => nomes.some(n => mesmoNome(id, n)))).map(u => u.usuario);
}

// Notificação dentro do próprio app (sineta no topo) — novo recurso, não
// existia no Code.gs. Guardada em notificacoes/{usuario}/itens/{id}.
async function notificar(usuario, tipo, titulo, corpo, refId) {
  try {
    await db.collection('notificacoes').doc(usuario).collection('itens').add({
      tipo, titulo, corpo, refId: refId || '', lida: false,
      criadoEm: FieldValue.serverTimestamp(),
    });
  } catch (err) { /* nunca quebra a ação principal */ }
}

async function notificarTodosDiscentes(tipo, titulo, corpo, refId) {
  const snap = await db.collection('usuarios').get();
  const envios = [];
  snap.forEach(doc => { if (doc.id !== USUARIO_PRESIDENTE) envios.push(notificar(doc.id, tipo, titulo, corpo, refId)); });
  await Promise.all(envios);
}

function exigirPresidente(request) {
  if (!request.auth || request.auth.token.role !== 'presidente') {
    throw new HttpsError('permission-denied', 'Só o presidente pode fazer isso.');
  }
}

function exigirLogado(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sessão expirada. Entre novamente.');
}

/* ------------------------------------------------------------------
 *  Login — emite um Firebase Auth Custom Token.
 *  O Firebase Auth SDK, no navegador, GUARDA essa sessão sozinho (IndexedDB)
 *  e a restaura sozinho a cada visita — é isso que elimina a necessidade do
 *  antigo "link pessoal de acesso".
 * ------------------------------------------------------------------ */
exports.login = onCall({ secrets: [PRESIDENTE_SENHA] }, async (request) => {
  const usuario = String(request.data?.usuario || '').trim().toLowerCase();
  if (!usuario) throw new HttpsError('invalid-argument', 'Informe o usuário.');

  let role, nomeReal = '';
  if (usuario === USUARIO_PRESIDENTE) {
    const senha = String(request.data?.senha || '');
    if (senha !== PRESIDENTE_SENHA.value()) throw new HttpsError('permission-denied', 'Senha incorreta.');
    role = 'presidente';
  } else {
    const u = await achaUsuarioDoc(usuario);
    if (!u) throw new HttpsError('not-found', 'Usuário não encontrado.');
    role = 'user';
    nomeReal = u.nome || '';
  }

  // Garante que existe um usuário do Firebase Auth com esse uid, já com as
  // claims certas (role/usuario) — criado da primeira vez que a pessoa entra.
  try {
    await auth.getUser(usuario);
    await auth.setCustomUserClaims(usuario, { role, usuario });
  } catch (err) {
    await auth.createUser({ uid: usuario });
    await auth.setCustomUserClaims(usuario, { role, usuario });
  }

  const token = await auth.createCustomToken(usuario, { role, usuario });
  return { role, usuario, nomeReal, token };
});

/* ------------------------------------------------------------------
 *  Segunda senha da aba "Notas" (independente da sessão principal)
 * ------------------------------------------------------------------ */
exports.loginNotas = onCall(async (request) => {
  exigirLogado(request);
  const usuario = String(request.data?.usuario || '').trim().toLowerCase();
  if (usuario !== request.auth.token.usuario) throw new HttpsError('permission-denied', 'Usuário inválido.');
  const u = await achaUsuarioDoc(usuario);
  if (!u) throw new HttpsError('not-found', 'Usuário não encontrado.');
  if (!u.senhaNotasHash) throw new HttpsError('failed-precondition', 'Sua senha de acesso às notas ainda não foi cadastrada. Fale com o presidente.');
  const senha = String(request.data?.senha || '');
  if (hashSenha(senha) !== u.senhaNotasHash) throw new HttpsError('permission-denied', 'Senha incorreta.');

  const token = crypto.randomBytes(24).toString('hex');
  await db.doc('notasTokens/' + token).set({ usuario, criadoEm: Date.now() });
  return { token, usuario };
});

exports.readNotasAluno = onCall(async (request) => {
  const token = String(request.data?.token || '');
  const usuario = String(request.data?.usuario || '').trim().toLowerCase();
  const snap = await db.doc('notasTokens/' + token).get();
  const dados = snap.exists ? snap.data() : null;
  const valido = dados && dados.usuario === usuario && (Date.now() - dados.criadoEm) < NOTAS_TOKEN_TTL_MS;
  if (!valido) throw new HttpsError('permission-denied', 'Sua sessão da aba Notas expirou. Entre com a senha de novo.');
  const notasSnap = await db.collection('avaliacoes').where('usuario', '==', usuario).get();
  const notas = notasSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  return { notas };
});

/* ------------------------------------------------------------------
 *  Avaliações (notas de prova) — só o presidente grava.
 * ------------------------------------------------------------------ */
function limpaAvaliacao(raw) {
  const a = {};
  a.usuario = String(raw.usuario || '').trim().toLowerCase();
  if (!a.usuario) throw new HttpsError('invalid-argument', 'Discente não encontrado.');
  a.disciplina = String(raw.disciplina || '').trim();
  if (DISCIPLINAS.indexOf(a.disciplina) < 0) throw new HttpsError('invalid-argument', 'Disciplina inválida.');
  a.eixo = a.disciplina === 'Habilidades Profissionais' ? String(raw.eixo || '').trim() : '';
  if (a.disciplina === 'Habilidades Profissionais' && !a.eixo) throw new HttpsError('invalid-argument', 'Escolha o eixo de Habilidades Profissionais.');
  a.tipo = String(raw.tipo || '').trim();
  if (TIPOS_AVALIACAO.indexOf(a.tipo) < 0) throw new HttpsError('invalid-argument', 'Escolha se é Nota Somativa, Formativa ou Completa.');
  const precisaModulo = DISCIPLINAS_COM_MODULO.indexOf(a.disciplina) >= 0 && a.tipo !== 'Completa';
  a.modulo = precisaModulo ? String(raw.modulo || '').trim() : '';
  if (precisaModulo && !a.modulo) throw new HttpsError('invalid-argument', 'Informe o módulo (' + a.disciplina + ').');
  const notaMaxima = Number(raw.notaMaxima);
  if (NOTAS_MAXIMAS_VALIDAS.indexOf(notaMaxima) < 0) throw new HttpsError('invalid-argument', 'Nota máxima inválida.');
  const nota = Number(String(raw.nota === undefined || raw.nota === null ? '' : raw.nota).replace(',', '.'));
  if (isNaN(nota) || nota < 0 || nota > notaMaxima) throw new HttpsError('invalid-argument', 'Informe uma nota válida (até ' + notaMaxima + ').');
  // Guardadas como texto (igual ao Local/Code.gs — ver limparAvaliacaoLocal no index.html),
  // pra não quebrar nada no front-end que compara/formata essas duas colunas como string.
  a.notaMaxima = String(notaMaxima);
  a.nota = String(nota);
  return a;
}

async function gravarAvaliacao(a, idInformado) {
  const agora = new Date().toISOString(); // string ISO, igual ao Code.gs (não Date.now())
  const id = idInformado || db.collection('avaliacoes').doc().id;
  const ref = db.doc('avaliacoes/' + id);
  const existente = await ref.get();
  a.id = id;
  a.atualizadoEm = agora;
  a.criadoEm = existente.exists ? existente.data().criadoEm : agora;
  await ref.set(a);
  notificarAvaliacao(a); // não espera (e-mail nunca deve atrasar a resposta)
  return a;
}

async function notificarAvaliacao(a) {
  try {
    const u = await achaUsuarioDoc(a.usuario);
    if (!u) return;
    const linhaDisciplina = a.disciplina + (a.eixo ? ' — ' + a.eixo : '') + (a.modulo ? ' — ' + a.modulo : '');
    const rotuloTipo = a.tipo === 'Completa' ? 'Nota completa da disciplina' : (a.tipo === 'Formativa' ? 'Nota Formativa' : 'Nota Somativa');
    const corpo = 'Uma nota foi lançada para você:\n\n' + linhaDisciplina + '\n' + rotuloTipo + '\nNota: ' + a.nota + ' de ' + a.notaMaxima
      + '\n\nAbra a aba "Notas" no site pra ver (é preciso digitar sua senha de notas): ' + linkDoSite();
    if (u.email) await enviarEmail(u.email, '[Cronograma] Nota enviada: ' + a.disciplina, corpo);
    await notificar(a.usuario, 'avaliacao', 'Nova nota: ' + a.disciplina, rotuloTipo + ' — ' + a.nota + '/' + a.notaMaxima, a.id);
  } catch (err) { /* nunca quebra o lançamento da nota */ }
}

exports.saveAvaliacao = onCall(async (request) => {
  exigirPresidente(request);
  const a = limpaAvaliacao(request.data?.avaliacao || {});
  const salva = await gravarAvaliacao(a, String(request.data?.avaliacao?.id || ''));
  await bumpVersao('versionAvaliacoes');
  return { avaliacao: salva };
});

exports.saveAvaliacoesEmLote = onCall(async (request) => {
  exigirPresidente(request);
  const lote = request.data?.lote || {};
  const itens = Array.isArray(lote.itens) ? lote.itens : [];
  if (!itens.length) throw new HttpsError('invalid-argument', 'Nenhuma nota para salvar.');
  const limpas = itens.map(item => limpaAvaliacao({
    usuario: item.usuario, disciplina: lote.disciplina, eixo: lote.eixo, modulo: lote.modulo, tipo: lote.tipo, notaMaxima: lote.notaMaxima, nota: item.nota,
  }));
  const salvas = [];
  for (let i = 0; i < limpas.length; i++) salvas.push(await gravarAvaliacao(limpas[i], String(itens[i].id || '')));
  await bumpVersao('versionAvaliacoes');
  return { avaliacoes: salvas };
});

exports.deleteAvaliacao = onCall(async (request) => {
  exigirPresidente(request);
  const id = String(request.data?.id || '');
  if (!id) throw new HttpsError('invalid-argument', 'Nota inválida.');
  await db.doc('avaliacoes/' + id).delete();
  await bumpVersao('versionAvaliacoes');
  return { ok: true };
});

/* ------------------------------------------------------------------
 *  Discentes (perfil + senha de Notas) — só o presidente grava.
 * ------------------------------------------------------------------ */
exports.salvarDiscente = onCall(async (request) => {
  exigirPresidente(request);
  const d = request.data?.discente || {};
  const usuario = String(d.usuario || '').trim().toLowerCase();
  const u = await achaUsuarioDoc(usuario);
  if (!u) throw new HttpsError('not-found', 'Discente não encontrado.');
  const patch = {};
  if (d.nome !== undefined) patch.nome = String(d.nome || '').trim().slice(0, 200);
  if (d.email !== undefined) patch.email = String(d.email || '').trim().slice(0, 200);
  if (d.matricula !== undefined) patch.matricula = String(d.matricula || '').trim().slice(0, 50);
  if (d.telefone !== undefined) patch.telefone = String(d.telefone || '').trim().slice(0, 50);
  if (String(d.senhaNotas || '').trim()) patch.senhaNotasHash = hashSenha(String(d.senhaNotas).trim());
  await db.doc('usuarios/' + usuario).set(patch, { merge: true });
  await bumpVersao('versionDiscentes');
  return { ok: true };
});

/* ------------------------------------------------------------------
 *  Configuração do semestre atual / Encerrar Semestre
 * ------------------------------------------------------------------ */
exports.salvarConfiguracaoSemestre = onCall(async (request) => {
  exigirPresidente(request);
  const cfg = request.data?.config || {};
  const eixos = Array.isArray(cfg.eixos) ? cfg.eixos.map(x => String(x || '').trim()).filter(Boolean) : [];
  const tutorias = (cfg.tutorias && typeof cfg.tutorias === 'object') ? cfg.tutorias : {};
  const subgrupos = (cfg.subgrupos && typeof cfg.subgrupos === 'object') ? cfg.subgrupos : {};
  const docentesEixos = (cfg.docentesEixos && typeof cfg.docentesEixos === 'object') ? cfg.docentesEixos : {};
  if (!eixos.length) throw new HttpsError('invalid-argument', 'Informe ao menos um eixo de Habilidades Profissionais.');
  if (!Array.isArray(tutorias.T1) || !tutorias.T1.length || !Array.isArray(tutorias.T2) || !tutorias.T2.length) {
    throw new HttpsError('invalid-argument', 'Informe os dois grupos de tutoria (T1 e T2), cada um com pelo menos um discente.');
  }
  for (const k of ['A', 'B', 'C', 'D']) {
    if (!Array.isArray(subgrupos[k]) || !subgrupos[k].length) throw new HttpsError('invalid-argument', 'Informe os quatro subgrupos de Habilidades Profissionais (A, B, C e D), cada um com pelo menos um discente.');
  }
  const batch = db.batch();
  batch.set(db.doc('config/eixos'), { valor: eixos });
  batch.set(db.doc('config/docentesEixos'), { valor: docentesEixos });
  batch.set(db.doc('config/tutorias'), { valor: { T1: tutorias.T1, T2: tutorias.T2 } });
  batch.set(db.doc('config/subgrupos'), { valor: { A: subgrupos.A, B: subgrupos.B, C: subgrupos.C, D: subgrupos.D } });
  await batch.commit();
  await bumpVersao('versionConfig');
  return { ok: true };
});

// Copia todos os documentos de uma coleção para <destino>/<id> (em lotes de
// até 400) e depois apaga os originais — é o equivalente a "renomear e
// esconder a aba, criar uma nova vazia" do Code.gs.
async function arquivarColecao(colName, destino) {
  const snap = await db.collection(colName).get();
  let i = 0;
  const docs = snap.docs;
  while (i < docs.length) {
    const lote = docs.slice(i, i + 400);
    const batch = db.batch();
    lote.forEach(doc => {
      batch.set(db.doc(destino + '/' + doc.id), doc.data());
      batch.delete(doc.ref);
    });
    await batch.commit();
    i += 400;
  }
  return docs.length;
}

exports.encerrarSemestre = onCall({ timeoutSeconds: 300 }, async (request) => {
  exigirPresidente(request);
  const rotulo = String(request.data?.rotulo || '').trim();
  if (!rotulo) throw new HttpsError('invalid-argument', 'Informe um rótulo para o semestre que está terminando (ex.: "2025.2").');

  const id = db.collection('semestres').doc().id;
  const base = 'semestres/' + id;
  const totais = {
    eventos: await arquivarColecao('eventos', base + '/eventos'),
    mural: await arquivarColecao('mural', base + '/mural'),
    muralLido: await arquivarColecao('muralLido', base + '/muralLido'),
    muralVotos: await arquivarColecao('muralVotos', base + '/muralVotos'),
    arquivos: await arquivarColecao('arquivos', base + '/arquivos'),
    datasImportantes: await arquivarColecao('datasImportantes', base + '/datasImportantes'),
  };
  // Avaliações: igual ao Code.gs, vão para um lugar que o site NUNCA lê de
  // volta — nem para o presidente, de propósito (ver firestore.rules).
  await arquivarColecao('avaliacoes', 'semestresNotasOcultas/' + id + '/avaliacoes');

  await db.doc(base).set({ rotulo, encerradoEm: new Date().toISOString(), totais });

  await Promise.all(['version', 'versionMural', 'versionArq', 'versionDatas', 'versionAvaliacoes'].map(bumpVersao));
  return { ok: true, rotulo };
});

exports.listarSemestres = onCall(async (request) => {
  exigirPresidente(request);
  const snap = await db.collection('semestres').orderBy('encerradoEm', 'desc').get();
  const semestres = snap.docs.map(d => ({ id: d.id, rotulo: d.data().rotulo, encerradoEm: d.data().encerradoEm }));
  return { semestres };
});

exports.lerSemestreArquivado = onCall(async (request) => {
  exigirPresidente(request);
  const id = String(request.data?.id || '');
  const ref = db.doc('semestres/' + id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Semestre não encontrado.');
  const lerSub = async (nome) => (await ref.collection(nome).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const [eventos, mural, arquivos, datas] = await Promise.all([lerSub('eventos'), lerSub('mural'), lerSub('arquivos'), lerSub('datasImportantes')]);
  const d = snap.data();
  return { rotulo: d.rotulo, encerradoEm: d.encerradoEm, eventos, mural, arquivos, datas };
});

/* ------------------------------------------------------------------
 *  Assinatura de calendário (iCalendar) — endpoint HTTP público, sem login
 *  (é assim que o Google Calendar/Apple/Outlook conseguem buscar sozinhos,
 *  periodicamente, sem credenciais). Mesmo formato RFC 5545 do Code.gs.
 *  SUA_URL_DA_FUNCTION/icsFeed?usuario=aluno01  -> só os eventos acompanhados
 *  SUA_URL_DA_FUNCTION/icsFeed?usuario=presidente -> grade inteira da turma
 * ------------------------------------------------------------------ */
function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function utf8Bytes(s) { return Buffer.byteLength(s, 'utf8'); }
function icsFold(linha) {
  const LIMITE = 74;
  const partes = [];
  let atual = '', bytesAtual = 0;
  for (const ch of String(linha)) {
    const b = utf8Bytes(ch);
    if (atual && bytesAtual + b > LIMITE) { partes.push(atual); atual = ''; bytesAtual = 0; }
    atual += ch; bytesAtual += b;
  }
  if (atual || !partes.length) partes.push(atual);
  return partes.join('\r\n ');
}
function fmtUtcAgora() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
function buildIcs(eventos, nomeAgenda) {
  const agora = fmtUtcAgora();
  const linhas = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cronograma Academico//PT-BR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEscape(nomeAgenda), 'X-WR-TIMEZONE:America/Sao_Paulo',
    'BEGIN:VTIMEZONE', 'TZID:America/Sao_Paulo', 'X-LIC-LOCATION:America/Sao_Paulo',
    'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:-0300', 'TZOFFSETTO:-0300', 'TZNAME:-03', 'END:STANDARD', 'END:VTIMEZONE',
  ];
  eventos.forEach(e => {
    const dtStart = String(e.data).replace(/-/g, '') + 'T' + String(e.inicio).replace(':', '') + '00';
    const dtEnd = String(e.data).replace(/-/g, '') + 'T' + String(e.fim).replace(':', '') + '00';
    const desc = [e.disciplina + (e.eixo ? ' / ' + e.eixo : '') + (e.tutoriaTipo ? ' · ' + e.tutoriaTipo : '')]
      .concat(e.docente ? ['Docente/Tutor(a): ' + e.docente] : [])
      .concat(e.grupo ? ['Grupo: ' + e.grupo] : [])
      .concat(e.observacoes ? [e.observacoes] : []).join('\n');
    linhas.push('BEGIN:VEVENT');
    linhas.push('UID:' + e.id + '@cronograma-academico');
    linhas.push('DTSTAMP:' + agora);
    linhas.push('DTSTART;TZID=America/Sao_Paulo:' + dtStart);
    linhas.push('DTEND;TZID=America/Sao_Paulo:' + dtEnd);
    linhas.push('SUMMARY:' + (e.cancelado === 'Sim' ? 'CANCELADO: ' : '') + icsEscape(e.titulo));
    if (e.cancelado === 'Sim') linhas.push('STATUS:CANCELLED');
    if (e.local) linhas.push('LOCATION:' + icsEscape(e.local));
    linhas.push('DESCRIPTION:' + icsEscape(desc));
    if (e.cancelado !== 'Sim') {
      // Alarmes embutidos no próprio evento do calendário — 1 dia, 1 hora e
      // 30 minutos antes. O Google Calendar ignora VALARM em agendas
      // assinadas por URL (limitação dele, não do arquivo), mas Apple
      // Calendar (iPhone/iPad/Mac) e Outlook respeitam e notificam sozinhos,
      // complementando as notificações que o site já manda.
      [['-P1D', 'Lembrete: 1 dia'], ['-PT1H', 'Lembrete: 1 hora'], ['-PT30M', 'Lembrete: 30 minutos']].forEach(([trigger, desc2]) => {
        linhas.push('BEGIN:VALARM');
        linhas.push('ACTION:DISPLAY');
        linhas.push('DESCRIPTION:' + icsEscape(desc2 + ' — ' + e.titulo));
        linhas.push('TRIGGER:' + trigger);
        linhas.push('END:VALARM');
      });
    }
    linhas.push('END:VEVENT');
  });
  linhas.push('END:VCALENDAR');
  return linhas.map(icsFold).join('\r\n');
}

exports.icsFeed = onRequest({ cors: true }, async (req, res) => {
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  try {
    const usuario = String(req.query.usuario || '').trim().toLowerCase();
    if (!usuario) throw new Error('Informe o usuário.');
    let eventos, nomeAgenda;
    const todosSnap = await db.collection('eventos').get();
    const todos = todosSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (usuario === USUARIO_PRESIDENTE) {
      eventos = todos;
      nomeAgenda = 'Cronograma — turma toda';
    } else {
      const u = await achaUsuarioDoc(usuario);
      if (!u) throw new Error('Usuário não encontrado.');
      const segSnap = await db.collection('acompanhados').where('usuario', '==', usuario).get();
      const ids = new Set(segSnap.docs.map(d => d.data().eventoId));
      eventos = todos.filter(e => ids.has(e.id));
      nomeAgenda = 'Cronograma — ' + usuario;
    }
    res.status(200).send(buildIcs(eventos, nomeAgenda));
  } catch (err) {
    res.status(200).send('Erro: ' + String((err && err.message) || err));
  }
});

/* ------------------------------------------------------------------
 *  Gatilhos do Firestore: versão (sincronização) + e-mails + notificações
 * ------------------------------------------------------------------ */
exports.onEventoWrite = onDocumentWritten('eventos/{id}', async (event) => {
  await bumpVersao('version');
  const antes = event.data.before.exists ? event.data.before.data() : null;
  const depois = event.data.after.exists ? event.data.after.data() : null;
  if (!antes || !depois) return; // só avisa em EDIÇÃO de evento existente (igual ao Code.gs)
  const id = event.params.id;

  const rotulos = { titulo: 'Título', data: 'Data', inicio: 'Início', fim: 'Fim', local: 'Local', docente: 'Docente/Tutor(a)', grupo: 'Grupo' };
  const mudancas = Object.keys(rotulos).filter(c => String(antes[c] || '') !== String(depois[c] || ''))
    .map(c => rotulos[c] + ': ' + (antes[c] || '(vazio)') + ' → ' + (depois[c] || '(vazio)'));

  let assunto, corpo, tituloNotif, corpoNotif;
  if (antes.cancelado !== 'Sim' && depois.cancelado === 'Sim') {
    assunto = '[Cronograma] Evento cancelado: ' + depois.titulo;
    corpo = 'O evento "' + depois.titulo + '" (' + depois.data + ' das ' + depois.inicio + ' às ' + depois.fim + ') foi cancelado.';
    tituloNotif = 'Evento cancelado'; corpoNotif = depois.titulo + ' (' + depois.data + ')';
  } else if (antes.cancelado === 'Sim' && depois.cancelado !== 'Sim') {
    assunto = '[Cronograma] Cancelamento desfeito: ' + depois.titulo;
    corpo = 'O evento "' + depois.titulo + '" voltou a valer — o cancelamento foi desfeito.';
    tituloNotif = 'Cancelamento desfeito'; corpoNotif = depois.titulo + ' (' + depois.data + ')';
  } else {
    if (!mudancas.length) return; // nada relevante mudou
    assunto = '[Cronograma] Evento alterado: ' + depois.titulo;
    corpo = 'O evento "' + depois.titulo + '" foi alterado:\n\n' + mudancas.join('\n');
    tituloNotif = 'Evento alterado: ' + depois.titulo; corpoNotif = mudancas.join(' · ');
  }
  corpo += '\n\nVeja os detalhes no site: ' + linkDoSite();

  // Avisa quem marcou "Acompanhar Evento" E, além disso (pedido do
  // presidente), quem está citado na lista de discentes do evento — mesmo
  // que nunca tenha clicado em acompanhar. Cobre especificamente mudança de
  // horário, docente/tutor(a), grupo ou sala (ver "rotulos" acima) e
  // cancelamento/desfazer cancelamento.
  const [segSnap, usuariosComId] = await Promise.all([
    db.collection('acompanhados').where('eventoId', '==', id).get(),
    usuariosComIdentidade(),
  ]);
  const seguidores = segSnap.docs.map(d => d.data().usuario);
  const citados = citadosNoEvento(depois, usuariosComId);
  const usuarios = [...new Set([...seguidores, ...citados])];
  if (!usuarios.length) return;
  await Promise.all(usuarios.map(async (usuario) => {
    const u = await achaUsuarioDoc(usuario);
    if (u && u.email) await enviarEmail(u.email, assunto, corpo);
    await notificar(usuario, 'evento', tituloNotif, corpoNotif, id);
  }));
});

exports.onMuralCreate = onDocumentCreated('mural/{id}', async (event) => {
  await bumpVersao('versionMural');
  const aviso = event.data.data();
  const id = event.params.id;
  try {
    let contexto = '';
    const eventoIds = Array.isArray(aviso.eventoIds) ? aviso.eventoIds : [];
    const arquivoIds = Array.isArray(aviso.arquivoIds) ? aviso.arquivoIds : [];
    if (eventoIds.length) {
      const citados = (await Promise.all(eventoIds.map(i => db.doc('eventos/' + i).get()))).filter(s => s.exists).map(s => s.data());
      if (citados.length) contexto += '\n\nEvento' + (citados.length > 1 ? 's citados' : ' citado') + ':\n' + citados.map(e => '- ' + e.titulo + ' (' + e.data + ', ' + e.inicio + ')').join('\n');
    }
    if (arquivoIds.length) {
      const citados = (await Promise.all(arquivoIds.map(i => db.doc('arquivos/' + i).get()))).filter(s => s.exists).map(s => s.data());
      if (citados.length) contexto += '\n\nDocumento' + (citados.length > 1 ? 's citados' : ' citado') + ':\n' + citados.map(a => '- ' + a.titulo).join('\n');
    }
    const corpo = '■ ' + (aviso.subtipo || 'AVISOS') + '\n\n' + aviso.texto + contexto + '\n\nAbra o mural no site: ' + linkDoSite();
    const assunto = '[Cronograma] ' + (aviso.subtipo || 'Novo aviso no mural');
    await enviarParaTodosComEmail(assunto, corpo);
    await notificarTodosDiscentes('mural', '■ ' + (aviso.subtipo || 'AVISOS'), String(aviso.texto || '').slice(0, 140), id);
  } catch (err) { /* nunca quebra a publicação do aviso */ }
});

exports.onMuralLidoWrite = onDocumentWritten('muralLido/{id}', async () => { await bumpVersao('versionMural'); });
exports.onMuralVotosWrite = onDocumentWritten('muralVotos/{id}', async () => { await bumpVersao('versionMural'); });
exports.onArquivosWrite = onDocumentWritten('arquivos/{id}', async () => { await bumpVersao('versionArq'); });
exports.onDatasWrite = onDocumentWritten('datasImportantes/{id}', async () => { await bumpVersao('versionDatas'); });
exports.onConfigWrite = onDocumentWritten('config/{chave}', async () => { await bumpVersao('versionConfig'); });
exports.onUsuariosWrite = onDocumentWritten('usuarios/{usuario}', async () => { await bumpVersao('versionDiscentes'); });

// Novo arquivo publicado → avisa todos os discentes (e-mail + sino no app).
// Só dispara na CRIAÇÃO (não em reordenar/editar/excluir um já existente).
exports.onArquivoCreate = onDocumentCreated('arquivos/{id}', async (event) => {
  const a = event.data.data();
  const id = event.params.id;
  try {
    const linha = a.disciplina + (a.modulo ? ' — ' + a.modulo : '') + (a.docente ? ' — ' + a.docente : '');
    const corpo = 'Um novo arquivo foi publicado em Arquivos da Turma:\n\n"' + a.titulo + '"\n' + linha
      + '\n\nAbra Arquivos da Turma no site: ' + linkDoSite();
    await enviarParaTodosComEmail('[Cronograma] Novo arquivo: ' + a.titulo, corpo);
    await notificarTodosDiscentes('arquivo', 'Novo arquivo: ' + a.titulo, a.disciplina || '', id);
  } catch (err) { /* nunca quebra o envio do arquivo */ }
});

// Nova Data Importante publicada → avisa todos os discentes.
exports.onDataCreate = onDocumentCreated('datasImportantes/{id}', async (event) => {
  const d = event.data.data();
  const id = event.params.id;
  try {
    const corpo = 'Uma nova Data Importante foi publicada:\n\n"' + d.titulo + '" — ' + d.data + (d.categoria ? ' (' + d.categoria + ')' : '')
      + (d.observacoes ? '\n' + d.observacoes : '') + '\n\nVeja em Datas Importantes no site: ' + linkDoSite();
    await enviarParaTodosComEmail('[Cronograma] Nova data importante: ' + d.titulo, corpo);
    await notificarTodosDiscentes('data', 'Nova data importante: ' + d.titulo, d.data || '', id);
  } catch (err) { /* nunca quebra a criação da data */ }
});

/* ------------------------------------------------------------------
 *  Lembretes agendados de evento — roda a cada 5 minutos e avisa:
 *   - 1 dia, 1 hora e 30 minutos antes, quem ACOMPANHA o evento;
 *   - 30 minutos antes, também quem está CITADO no evento (mesmo sem
 *     acompanhar) — pedido específico do presidente.
 *  Controla o que já foi enviado em lembretesEnviados/{eventoId}, pra nunca
 *  mandar o mesmo lembrete duas vezes (o Firestore não tem "cron" próprio,
 *  então cada rodada reconfere os eventos das próximas ~25h).
 * ------------------------------------------------------------------ */
const JANELAS_LEMBRETE = [
  { chave: 'um_dia', ms: 24 * 60 * 60 * 1000, rotulo: '1 dia' },
  { chave: 'uma_hora', ms: 60 * 60 * 1000, rotulo: '1 hora' },
  { chave: 'trinta_min', ms: 30 * 60 * 1000, rotulo: '30 minutos' },
];
const TOLERANCIA_LEMBRETE_MS = 150 * 1000; // ±2,5min — a função roda a cada 5min

exports.enviarLembretesEventos = onSchedule({ schedule: 'every 5 minutes', timeZone: 'America/Sao_Paulo' }, async () => {
  const agora = Date.now();
  const ymd = ms => new Date(ms).toISOString().slice(0, 10);
  // Faixa ampla (ontem a depois de amanhã) só pra não perder evento por causa
  // de fuso na comparação de string — o filtro fino é feito por evento, com
  // a data/hora real convertida para o fuso fixo de Brasília (-03:00).
  const de = ymd(agora - 24 * 60 * 60 * 1000);
  const ate = ymd(agora + 2 * 24 * 60 * 60 * 1000);
  const snap = await db.collection('eventos').where('data', '>=', de).where('data', '<=', ate).get();
  const eventos = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(e => e.cancelado !== 'Sim' && e.data && e.inicio);
  if (!eventos.length) return;

  let usuariosComId = null; // só busca se algum evento realmente precisar (tem janela batendo)

  for (const e of eventos) {
    const inicioMs = Date.parse(e.data + 'T' + e.inicio + ':00-03:00');
    if (isNaN(inicioMs)) continue;
    const faltaMs = inicioMs - agora;
    if (faltaMs < -TOLERANCIA_LEMBRETE_MS) continue; // já começou/passou

    const janelasQueBatem = JANELAS_LEMBRETE.filter(j => Math.abs(faltaMs - j.ms) <= TOLERANCIA_LEMBRETE_MS);
    if (!janelasQueBatem.length) continue;

    const flagRef = db.doc('lembretesEnviados/' + e.id);
    const flagSnap = await flagRef.get();
    const jaEnviados = flagSnap.exists ? flagSnap.data() : {};
    const aEnviarAgora = janelasQueBatem.filter(j => !jaEnviados[j.chave]);
    if (!aEnviarAgora.length) continue;

    const seguidoresSnap = await db.collection('acompanhados').where('eventoId', '==', e.id).get();
    const seguidores = new Set(seguidoresSnap.docs.map(d => d.data().usuario));
    if (!usuariosComId) usuariosComId = await usuariosComIdentidade();
    const citados = new Set(citadosNoEvento(e, usuariosComId));

    const patch = {};
    for (const j of aEnviarAgora) {
      // 30 minutos antes: quem acompanha OU está citado. 1h e 1 dia: só quem acompanha.
      const publico = j.chave === 'trinta_min' ? new Set([...seguidores, ...citados]) : seguidores;
      if (publico.size) {
        const corpo = 'Faltam ' + j.rotulo + ' para "' + e.titulo + '", às ' + e.inicio + (e.local ? ' em ' + e.local : '') + '.'
          + '\n\nVeja os detalhes no site: ' + linkDoSite();
        await Promise.all([...publico].map(async (usuario) => {
          const u = await achaUsuarioDoc(usuario);
          if (u && u.email) await enviarEmail(u.email, '[Cronograma] Em ' + j.rotulo + ': ' + e.titulo, corpo);
          await notificar(usuario, 'evento', 'Em ' + j.rotulo + ': ' + e.titulo, (e.local ? e.local + ' · ' : '') + e.inicio, e.id);
        }));
      }
      patch[j.chave] = true;
    }
    await flagRef.set(patch, { merge: true });
  }
});

// Lembrete manual: "lembrar quem não leu" um aviso específico do mural —
// chamado pelo botão na aba Mural (só presidente). Igual a lembrarNaoLeram_.
exports.lembrarNaoLeram = onCall(async (request) => {
  exigirPresidente(request);
  const avisoId = String(request.data?.avisoId || '');
  if (!avisoId) throw new HttpsError('invalid-argument', 'Aviso inválido.');
  const avisoSnap = await db.doc('mural/' + avisoId).get();
  if (!avisoSnap.exists) throw new HttpsError('not-found', 'Este aviso não existe mais.');
  const lidoSnap = await db.collection('muralLido').where('avisoId', '==', avisoId).get();
  const leram = new Set(lidoSnap.docs.map(d => d.data().usuario));
  const todosSnap = await db.collection('usuarios').get();
  const faltam = todosSnap.docs.filter(d => d.id !== USUARIO_PRESIDENTE && !leram.has(d.id) && d.data().email);
  const aviso = avisoSnap.data();
  const corpo = 'Lembrete: você ainda não viu este aviso no mural da turma:\n\n"' + aviso.texto + '"\n\nAbra o mural no site: ' + linkDoSite();
  await Promise.all(faltam.map(d => enviarEmail(d.data().email, '[Cronograma] Lembrete: aviso não visto no mural', corpo)));
  return { ok: true, enviados: faltam.length };
});
