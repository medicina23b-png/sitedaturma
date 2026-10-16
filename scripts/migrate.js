#!/usr/bin/env node
/**
 * ============================================================
 *  MIGRAÇÃO: planilha (Excel) → Firestore (Firebase)
 * ============================================================
 *  Lê os dados já exportados em scripts/data/dados-turma.xlsx (a mesma
 *  estrutura de abas que o Code.gs usava: Eventos, Usuarios, Mural, Notas,
 *  Avaliacoes, Arquivos, DatasImportantes, Acompanhados, SessoesTutoria,
 *  Configuracao, Semestres...) e grava o equivalente em cada coleção do
 *  Firestore — preservando TODOS os dados já inseridos.
 *
 *  Não precisa mais de conta de serviço do Google Sheets nem de compartilhar
 *  planilha nenhuma: os dados já estão num arquivo .xlsx local. Só falta UMA
 *  coisa: a chave de conta de serviço do seu projeto Firebase, pra ter
 *  permissão de ESCREVER no Firestore.
 *
 *  O QUE VOCÊ PRECISA ANTES DE RODAR
 *  ----------------------------------
 *  1) Uma CHAVE DE CONTA DE SERVIÇO do seu projeto Firebase:
 *       Console do Firebase ▸ ⚙️ Configurações do projeto ▸ Contas de
 *       serviço ▸ Gerar nova chave privada. Salve o arquivo baixado como
 *       scripts/firebase-service-account.json
 *
 *  ⚠️ IMPORTANTE SOBRE PRIVACIDADE: scripts/data/dados-turma.xlsx tem dados
 *  pessoais reais da turma (nomes, e-mails, telefones e as senhas da aba
 *  Notas, hoje em TEXTO PURO na planilha). Por isso esse arquivo está no
 *  .gitignore deste projeto — ele NUNCA deve ser enviado ao GitHub, nem num
 *  repositório privado. Ele só precisa existir aqui, na sua máquina (ou
 *  nesta conversa), no momento de rodar esta migração. Depois de migrar,
 *  pode apagá-lo com segurança — os dados já estarão só no Firestore (e lá,
 *  a senha é guardada com hash, nunca em texto puro).
 *
 *  COMO RODAR
 *    cd scripts
 *    npm install
 *    node migrate.js
 *
 *  O script é seguro para rodar mais de uma vez (grava com o MESMO id de
 *  cada linha da planilha, então rodar de novo apenas sobrescreve com os
 *  dados atuais, não duplica nada).
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const XLSX = require('xlsx');

// Senha "técnica" usada para os discentes entrarem — ninguém digita ela (o
// site não pede senha pro aluno, só o usuário, igual sempre foi). Ela só
// existe pra abrir uma sessão do Firebase Authentication (que é grátis e não
// exige Cloud Functions nem plano Blaze). Precisa ser IDÊNTICA à constante
// SENHA_TECNICA_DISCENTE em public/index.html.
const SENHA_TECNICA_DISCENTE = 'turma23b-sessao-2026-sem-senha-';

function perguntarSenhaPresidente() {
  if (process.env.PRESIDENTE_SENHA) return Promise.resolve(process.env.PRESIDENTE_SENHA);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Digite a senha que o PRESIDENTE vai usar para entrar no site: ', (resposta) => {
      rl.close();
      resolve(String(resposta || '').trim());
    });
  });
}

async function criarOuAtualizarConta(admin, uid, email, senha, claims) {
  try {
    await admin.auth().updateUser(uid, { email, password: senha });
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      await admin.auth().createUser({ uid, email, password: senha });
    } else {
      throw err;
    }
  }
  await admin.auth().setCustomUserClaims(uid, claims);
}

async function sincronizarContasAuth(admin, usuarios) {
  console.log('\nCriando/atualizando contas de acesso (Firebase Authentication — grátis, sem Blaze)...');
  const senhaPresidente = await perguntarSenhaPresidente();
  if (!senhaPresidente) throw new Error('Senha do presidente não pode ser vazia.');
  await criarOuAtualizarConta(admin, 'presidente', 'presidente@turma23b.local', senhaPresidente, { role: 'presidente', usuario: 'presidente' });
  for (const l of usuarios) {
    const usuario = String(l.usuario).trim().toLowerCase();
    await criarOuAtualizarConta(admin, usuario, usuario + '@turma23b.local', SENHA_TECNICA_DISCENTE + usuario, { role: 'user', usuario });
  }
  console.log('  ' + (usuarios.length + 1) + ' conta(s) de acesso pronta(s).');
}
const admin = require('firebase-admin');
const crypto = require('crypto');

const XLSX_PATH = path.join(__dirname, 'data', 'dados-turma.xlsx');
const FIREBASE_KEY = path.join(__dirname, 'firebase-service-account.json');

if (!fs.existsSync(XLSX_PATH)) {
  console.error('Faltando scripts/data/dados-turma.xlsx — coloque ali a planilha exportada (.xlsx) com os dados da turma.');
  process.exit(1);
}
const TEM_CHAVE_LOCAL = fs.existsSync(FIREBASE_KEY);

// Rodando no Cloud Shell (ou em qualquer máquina já autenticada com "gcloud
// auth application-default login") não precisa do arquivo de chave: usa a
// credencial padrão da conta logada, que já é dona do projeto.
admin.initializeApp({
  credential: TEM_CHAVE_LOCAL ? admin.credential.cert(require(FIREBASE_KEY)) : admin.credential.applicationDefault(),
  projectId: 'turma23b',
});
const db = admin.firestore();
const livro = XLSX.readFile(XLSX_PATH);

function hashSenha(s) { return crypto.createHash('sha256').update(String(s || '')).digest('hex'); }

/* ------------------------------------------------------------------
 *  Leitura genérica de uma aba, por NOME de coluna (como colunasPorNome_
 *  no Code.gs) — funciona mesmo que a ordem das colunas tenha mudado.
 * ------------------------------------------------------------------ */
function normalizaCabecalho(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function lerAba(titulo, colunas) {
  const ws = livro.Sheets[titulo];
  if (!ws) { console.warn('  (aba "' + titulo + '" não encontrada — pulando)'); return []; }
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (linhas.length < 2) return [];
  const cabecalho = linhas[0].map(normalizaCabecalho);
  const idx = {};
  colunas.forEach(c => { idx[c] = cabecalho.indexOf(normalizaCabecalho(c)); });
  return linhas.slice(1)
    .filter(r => r[idx.id ?? 0] !== undefined && String(r[idx.id ?? 0] || '').trim() !== '')
    .map(r => {
      const o = {};
      colunas.forEach(c => { const i = idx[c]; o[c] = i >= 0 ? String(r[i] === undefined ? '' : r[i]) : ''; });
      return o;
    });
}

const COLS_EVENTO = ['id', 'disciplina', 'tutoriaTipo', 'eixo', 'titulo', 'data', 'inicio', 'fim', 'local', 'docente', 'roteiros', 'grupo', 'discentes', 'observacoes', 'atualizadoEm', 'cancelado', 'arquivosAnexados'];
const COLS_ARQUIVO = ['id', 'titulo', 'disciplina', 'tipo', 'temDocente', 'docente', 'modulo', 'cobradoProva', 'origem', 'driveId', 'link', 'nomeOriginal', 'mimeType', 'enviadoEm', 'ordem'];
const COLS_MURAL = ['id', 'texto', 'eventoIds', 'arquivoIds', 'criadoEm', 'opcoes', 'multiplaEscolha', 'subtipo'];
const COLS_DATA = ['id', 'titulo', 'data', 'categoria', 'observacoes', 'criadoEm'];
const COLS_USUARIO = ['usuario', 'nome', 'email', 'aniversario', 'matricula', 'telefone', 'senhaNotas'];
const COLS_NOTA = ['id', 'usuario', 'eventoId', 'texto', 'atualizadoEm'];
const COLS_AVALIACAO = ['id', 'usuario', 'disciplina', 'eixo', 'tipo', 'nota', 'notaMaxima', 'criadoEm', 'atualizadoEm', 'modulo'];
const COLS_SESSAO_TUTORIA = ['eventoId', 'objetivos', 'status', 'iniciadoPor', 'iniciadoEm', 'encerradoEm', 'relatorio', 'atualizadoEm'];
const COLS_SEMESTRE = ['id', 'rotulo', 'encerradoEm', 'abaEventos', 'abaMural', 'abaMuralLido', 'abaMuralVotos', 'abaArquivos', 'abaDatas', 'abaAvaliacoes'];
const COLS_ACOMP = ['usuario', 'eventoId'];
const COLS_MURAL_LIDO = ['usuario', 'avisoId'];
const COLS_MURAL_VOTOS = ['usuario', 'avisoId', 'opcao'];

// Grava em lotes de 400 (limite do Firestore é 500 por batch).
async function gravarEmLotes(colecao, linhas, montarId, montarDados) {
  let i = 0;
  while (i < linhas.length) {
    const fatia = linhas.slice(i, i + 400);
    const batch = db.batch();
    fatia.forEach(l => batch.set(db.doc(colecao + '/' + montarId(l)), montarDados(l)));
    await batch.commit();
    i += 400;
  }
  console.log('  ' + colecao + ': ' + linhas.length + ' documento(s) gravado(s).');
}

async function main() {
  console.log('Lendo ' + XLSX_PATH + ' e gravando no Firestore...\n');

  // ---------- Eventos ----------
  const eventos = lerAba('Eventos', COLS_EVENTO);
  await gravarEmLotes('eventos', eventos, l => l.id, l => {
    const o = { ...l };
    try { o.arquivosAnexados = JSON.parse(o.arquivosAnexados || '[]'); } catch (e) { o.arquivosAnexados = []; }
    delete o.id;
    return o;
  });

  // ---------- Usuarios / Discentes ----------
  const usuarios = lerAba('Usuarios', COLS_USUARIO);
  await gravarEmLotes('usuarios', usuarios, l => String(l.usuario).trim().toLowerCase(), l => ({
    nome: l.nome || '', email: l.email || '', aniversario: l.aniversario || '',
    matricula: l.matricula || '', telefone: l.telefone || '',
    senhaNotasHash: l.senhaNotas ? hashSenha(l.senhaNotas) : '',
  }));
  await sincronizarContasAuth(admin, usuarios);

  // ---------- Acompanhados ----------
  const acomp = lerAba('Acompanhados', COLS_ACOMP);
  await gravarEmLotes('acompanhados', acomp, l => (l.usuario + '_' + l.eventoId), l => ({ usuario: String(l.usuario).toLowerCase(), eventoId: l.eventoId }));

  // ---------- Arquivos ----------
  const arquivos = lerAba('Arquivos', COLS_ARQUIVO);
  await gravarEmLotes('arquivos', arquivos, l => l.id, l => { const o = { ...l }; delete o.id; return o; });

  // ---------- Mural + MuralLido + MuralVotos ----------
  const mural = lerAba('Mural', COLS_MURAL);
  await gravarEmLotes('mural', mural, l => l.id, l => {
    const o = { ...l };
    try { o.eventoIds = JSON.parse(o.eventoIds || '[]'); } catch (e) { o.eventoIds = []; }
    try { o.arquivoIds = JSON.parse(o.arquivoIds || '[]'); } catch (e) { o.arquivoIds = []; }
    try { o.opcoes = JSON.parse(o.opcoes || '[]'); } catch (e) { o.opcoes = []; }
    delete o.id;
    return o;
  });
  const muralLido = lerAba('MuralLido', COLS_MURAL_LIDO);
  await gravarEmLotes('muralLido', muralLido, l => l.usuario + '_' + l.avisoId, l => ({ usuario: String(l.usuario).toLowerCase(), avisoId: l.avisoId }));
  const muralVotos = lerAba('MuralVotos', COLS_MURAL_VOTOS);
  await gravarEmLotes('muralVotos', muralVotos, l => l.usuario + '_' + l.avisoId + '_' + l.opcao, l => ({ usuario: String(l.usuario).toLowerCase(), avisoId: l.avisoId, opcao: l.opcao }));

  // ---------- Datas Importantes ----------
  const datas = lerAba('DatasImportantes', COLS_DATA);
  await gravarEmLotes('datasImportantes', datas, l => l.id, l => { const o = { ...l }; delete o.id; return o; });

  // ---------- Notas privadas ----------
  const notas = lerAba('Notas', COLS_NOTA);
  await gravarEmLotes('notas', notas, l => String(l.usuario).toLowerCase() + '__' + l.eventoId, l => ({ usuario: String(l.usuario).toLowerCase(), eventoId: l.eventoId, texto: l.texto, atualizadoEm: l.atualizadoEm }));

  // ---------- Avaliações ----------
  const avaliacoes = lerAba('Avaliacoes', COLS_AVALIACAO);
  await gravarEmLotes('avaliacoes', avaliacoes, l => l.id, l => { const o = { ...l, usuario: String(l.usuario).toLowerCase() }; delete o.id; return o; });

  // ---------- Sessões de Tutoria (Coordenador) ----------
  const sessoes = lerAba('SessoesTutoria', COLS_SESSAO_TUTORIA);
  await gravarEmLotes('sessoesTutoria', sessoes, l => l.eventoId, l => {
    const o = { ...l };
    try { o.objetivos = JSON.parse(o.objetivos || 'null'); } catch (e) { o.objetivos = null; }
    try { o.relatorio = o.relatorio ? JSON.parse(o.relatorio) : null; } catch (e) { o.relatorio = null; }
    delete o.eventoId;
    return o;
  });

  // ---------- Configuração do semestre atual ----------
  const wsCfg = livro.Sheets['Configuracao'];
  if (wsCfg) {
    const linhasCfg = XLSX.utils.sheet_to_json(wsCfg, { header: 1 });
    if (linhasCfg.length > 1) {
      const batch = db.batch();
      let algumaChave = false;
      linhasCfg.slice(1).forEach(r => {
        const chave = String((r && r[0]) || '').trim();
        if (!chave) return;
        let valor; try { valor = JSON.parse(r[1]); } catch (e) { return; }
        batch.set(db.doc('config/' + chave), { valor });
        algumaChave = true;
      });
      if (algumaChave) { await batch.commit(); console.log('  config: configuração do semestre atual migrada.'); }
    }
  }

  // ---------- Semestres já arquivados antes (se existir a aba "Semestres") ----------
  const semestres = lerAba('Semestres', COLS_SEMESTRE);
  for (const s of semestres) {
    const base = 'semestres/' + s.id;
    console.log('  Semestre arquivado "' + s.rotulo + '"...');
    const mapaAbas = [
      ['eventos', s.abaEventos, COLS_EVENTO],
      ['mural', s.abaMural, COLS_MURAL],
      ['muralLido', s.abaMuralLido, COLS_MURAL_LIDO],
      ['muralVotos', s.abaMuralVotos, COLS_MURAL_VOTOS],
      ['arquivos', s.abaArquivos, COLS_ARQUIVO],
      ['datasImportantes', s.abaDatas, COLS_DATA],
    ];
    for (const [nomeCol, tituloAba, colunas] of mapaAbas) {
      if (!tituloAba) continue;
      const linhas = lerAba(tituloAba, colunas);
      await gravarEmLotes(base + '/' + nomeCol, linhas, l => l.id || (l.usuario + '_' + (l.eventoId || l.avisoId)), l => { const o = { ...l }; delete o.id; return o; });
    }
    if (s.abaAvaliacoes) {
      const linhas = lerAba(s.abaAvaliacoes, COLS_AVALIACAO);
      await gravarEmLotes('semestresNotasOcultas/' + s.id + '/avaliacoes', linhas, l => l.id, l => { const o = { ...l }; delete o.id; return o; });
    }
    await db.doc(base).set({ rotulo: s.rotulo, encerradoEm: s.encerradoEm || new Date().toISOString() });
  }

  console.log('\nMigração concluída! Confira os dados no Console do Firebase (Firestore Database).');
  console.log('Lembre-se: scripts/data/dados-turma.xlsx tem dados pessoais da turma — nunca envie esse arquivo ao GitHub (já está no .gitignore).');
  process.exit(0);
}

main().catch(err => { console.error('Erro na migração:', err); process.exit(1); });
