# Cronograma Acadêmico — Turma 23B

Site da turma, agora hospedado assim:

- **Frontend** (`index.html`, na raiz do repositório): hospedado no **Cloudflare Pages**, publicado automaticamente a cada `git push` no **GitHub**.
- **Backend**: **Firebase** — só Firestore (banco de dados) e Firebase Authentication (login). Sem Cloud Functions e sem Firebase Storage (por escolha, pra não depender do plano Blaze/cartão de crédito) — "Arquivos da Turma" funciona só por link (Google Drive, Docs, Slides etc.), e toda a lógica roda no navegador + regras do Firestore.
- O **Google Apps Script/Google Sheets antigos não são mais usados** pelo site. A planilha só serve, uma única vez, de fonte para o script de migração (`scripts/migrate.js`).

Este documento é o roteiro completo, passo a passo, para colocar tudo isso no ar. Não é preciso saber programar — é só seguir a ordem.

### O que é automático e o que não tem como automatizar

O frontend (`index.html`, na raiz) publica sozinho a cada `git push`, pelo Cloudflare Pages (passo 8) — conta grátis, sem cartão. O backend é só Firestore + Firebase Authentication, também grátis, sem Blaze e sem cartão. É:

1. Ativar Firestore no Console do Firebase (1.2) — alguns cliques, uma vez.
2. Publicar as regras do Firestore (3.3) — um comando (`firebase deploy --only firestore:rules`), repetido só quando você mudar algo em `firestore.rules`.
3. Rodar a migração dos dados (5) — uma vez, com os dados que você já tem (ela também cria o login de cada discente).
4. Ligar o Cloudflare Pages (8) — alguns cliques, uma vez.

---

## 0. O que você vai precisar

- Uma conta Google (para o Firebase) — pode ser a mesma do Apps Script antigo.
- Uma conta no [GitHub](https://github.com) (guarda o código).
- Uma conta no [Cloudflare](https://dash.cloudflare.com/sign-up) (publica o site — veja o passo 8; é grátis, sem cartão).
- O [Node.js](https://nodejs.org) instalado no seu computador (versão 20 ou mais nova), só para rodar os comandos abaixo.
- Uma conta de e-mail que o site vai usar para mandar os avisos (pode ser um Gmail comum, com "senha de app" — explico no passo 4).

---

## 1. Criar o projeto no Firebase

O projeto já existe no Firebase Console com o nome **turma23b** (foi criado para gerar a configuração usada no site). Se ele já existe, pule para o item 1.2. Se precisar criar do zero:

### 1.1 Criar o projeto (só se ainda não existir)

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) e clique em **Adicionar projeto**.
2. Nome do projeto: `turma23b` (ou o nome que preferir — se for outro nome, troque os valores de `firebaseConfig` dentro de `index.html` (na raiz), no `<script type="module">` do `<head>`, e o `default` em `.firebaserc`).
3. Pode desativar o Google Analytics se não quiser, ou deixar ativado (o site já está preparado pra usar).

### 1.2 Ativar os produtos usados

Dentro do projeto, no menu da esquerda:

1. **Authentication** → aba "Sign-in method" → não é preciso ativar nenhum provedor específico (o login usa "tokens personalizados", que já vem liberado por padrão).
2. **Firestore Database** → **Criar banco de dados** → modo de produção → escolha a região `southamerica-east1` (São Paulo — mais perto da turma).
3. **Functions** → será ativado automaticamente no primeiro `firebase deploy` (passo 3). Ele pede para colocar o projeto no plano **Blaze** (pago por uso) — é obrigatório para usar Cloud Functions; o uso de uma turma de faculdade fica, na prática, dentro da faixa gratuita mensal do Firebase.

(Não é preciso ativar o **Storage** — este projeto não usa, por escolha: "Arquivos da Turma" funciona só por link.)

### 1.3 Instalar as ferramentas de linha de comando

No seu computador, num terminal:

```bash
npm install -g firebase-tools
firebase login
```

Isso abre o navegador para você entrar com a conta Google do projeto.

---

## 2. Baixar este projeto para o seu computador

Se você recebeu este projeto como uma pasta/zip, extraia e abra um terminal dentro dela (a pasta que contém `firebase.json`, `index.html`, `scripts/`, etc.). Depois:

```bash
firebase use --add
```

Escolha o projeto `turma23b` e dê o nome de alias `default` quando perguntado (isso já está pré-configurado em `.firebaserc`, então normalmente você pode pular este comando).

---

## 3. Publicar as regras do Firestore (sem terminal, direto no Console)

Este projeto **não usa Cloud Functions** (por escolha, pra não exigir o plano Blaze/cartão de crédito), **não usa GitHub Actions** e **não precisa de Cloud Shell nem de CLI nenhuma**. Login, notas, notificações etc. rodam direto no navegador, autorizados pelas regras do arquivo `firestore.rules` — e dá pra publicar essas regras colando o texto direto no site do Firebase:

1. Abra o [Firebase Console](https://console.firebase.google.com/project/turma23b/firestore/rules) → projeto `turma23b` → **Firestore Database** → aba **Regras**.
2. Abra o arquivo `firestore.rules` deste projeto num editor de texto (Bloco de Notas, VS Code, o que tiver), selecione tudo e copie.
3. Cole no editor de regras do Firebase Console, substituindo o que já estava escrito ali.
4. Clique em **Publicar**.

Repita isso sempre que esse arquivo mudar (por exemplo, numa atualização futura que eu te mandar).

---

## 4. Notificações no celular e e-mail 2h antes (Worker da Cloudflare)

Continua sem Cloud Functions e sem Blaze: quem manda o push (com o app fechado) e os e-mails de lembrete é um Worker grátis da Cloudflare, na pasta [`push-worker/`](push-worker/README.md). Siga o passo a passo de lá (conta de serviço do Firebase + Brevo para e-mail + `npx wrangler deploy`).

O que ele faz:

- **Tempo real**: quando o presidente publica no mural, cria/edita/cancela/remove um evento, publica um arquivo ou uma data importante, todo mundo que precisa saber recebe a notificação no celular na hora.
- **2h antes de cada evento**: quem está na lista do evento recebe push + e-mail com os dados (disciplina, data, horário, local, docente, grupo, roteiros, observações).

Depois de publicar as regras novas do Firestore (passo 3 — elas agora liberam a coleção `pushTokens`, que guarda os aparelhos), cada pessoa só precisa tocar em **Ativar** no aviso que aparece no topo do app (ou no sininho ▸ "Ativar notificações"). No iPhone, isso só funciona com o app instalado na Tela de Início (exigência da Apple, iOS 16.4+).

---

## 5. Migrar os dados já existentes para o Firestore

Esse passo só precisa ser feito **uma vez**. Os dados da turma (eventos, discentes, mural, notas, arquivos, datas importantes, semestres já encerrados etc.) já vêm prontos em `scripts/data/dados-turma.xlsx` — o script lê esse arquivo local e grava tudo no Firestore. **Não precisa mais de conta de serviço do Google Sheets, nem de compartilhar planilha nenhuma.**

### 5.1 Gerar a chave do Firebase (a única credencial necessária)

1. No [Firebase Console](https://console.firebase.google.com), dentro do projeto `turma23b` → ⚙️ **Configurações do projeto** → aba **Contas de serviço** → **Gerar nova chave privada**. Um arquivo `.json` será baixado.
2. Renomeie para `firebase-service-account.json` e coloque dentro da pasta `scripts/`.

Esse arquivo `.json` é sensível (dá acesso total ao projeto) — **nunca** suba ele para o GitHub (o `.gitignore` deste projeto já está configurado para ignorá-lo automaticamente).

### 5.2 Rodar a migração

```bash
cd scripts
npm install
node migrate.js
```

O script mostra na tela, passo a passo, o que está migrando (eventos, usuários, mural, notas, arquivos, semestres arquivados...).

Pode rodar de novo sem problema — ele não duplica nada (sempre sobrescreve os mesmos documentos, usando o mesmo id de cada linha).

**⚠️ Sobre `scripts/data/dados-turma.xlsx`**: esse arquivo tem dados pessoais reais da turma — nomes, e-mails, telefones e as senhas da aba "Notas" em **texto puro** (como estavam na planilha). Por isso ele já está no `.gitignore` e **nunca deve ir para o GitHub**, nem em repositório privado. Ele só precisa existir na sua máquina no momento de rodar `node migrate.js`; depois pode apagá-lo com segurança — a partir daí os dados moram só no Firestore (lá, a senha de Notas já fica guardada com hash, nunca em texto puro).

### 5.3 Ligar o login (um clique, nenhuma conta pra criar à mão)

Login agora é bem simples: **cada discente entra só com o usuário** (primeiro nome em letra minúscula — ex.: `alexandre`), **sem senha nenhuma**; só o **presidente** tem senha, fixa: `23b23b`.

Nenhuma conta precisa ser criada à mão — o próprio site cria a conta de cada pessoa (no Firebase Authentication) na primeira vez que ela entra. Só falta UM clique, uma vez:

1. No [Firebase Console](https://console.firebase.google.com/project/turma23b/authentication/providers) → **Authentication** → aba **Sign-in method** → clique em **E-mail/senha** → **Ativar** → **Salvar**.

Pronto. Teste entrando com o usuário de um discente (sem senha) ou com `presidente` / `23b23b`.

---

## 6. Assinar calendário (Google Calendar/iCal) — não disponível nesta versão

Esse recurso precisava de um endereço de internet que gerasse o arquivo do calendário toda vez que alguém assinasse — isso exigia Cloud Functions, que tiramos do projeto (por escolha, pra não precisar do plano Blaze/cartão). O botão "Assinar no calendário" continua no site, só avisando que falta configurar; o cronograma em si continua funcionando normalmente dentro do site.

---

## 7. Subir o projeto para o GitHub

Dentro da pasta do projeto:

```bash
git init
git add .
git commit -m "Site da Turma 23B — Firebase + Cloudflare Pages"
```

Depois, crie um repositório novo (privado, de preferência) no GitHub, pelo site, e siga as instruções que o próprio GitHub mostra para "enviar um repositório já existente":

```bash
git remote add origin https://github.com/SEU_USUARIO/NOME_DO_REPOSITORIO.git
git branch -M main
git push -u origin main
```

---

## 8. Publicar o site com o Cloudflare Pages (grátis, sem cartão)

1. Crie uma conta em [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) (ou entre se já tiver).
2. **Workers & Pages** (menu da esquerda) → **Create** → aba **Pages** → **Connect to Git** → autorize o GitHub e escolha o repositório.
3. Em **Build settings**: deixe **Build command** vazio e **Build output directory** como `/` (ou deixe em branco — o site é só HTML estático na raiz, não tem build nenhum).
4. **Save and Deploy**. Em 1-2 minutos o Cloudflare mostra o endereço do site, algo como `https://sitedaturma.pages.dev`.

A partir de agora, **todo `git push` no GitHub publica automaticamente** a nova versão ali — não precisa fazer nada manual depois disso. Funciona com o repositório público ou privado, sem diferença de preço (sempre grátis nesse uso).

---

## 9. Testar

1. Abra o site publicado pelo Cloudflare Pages.
2. Entre como presidente (usuário `presidente`, a senha configurada no passo 3.1).
3. Confirme que o cronograma, mural, arquivos e notas aparecem com os dados migrados.
4. Entre como um discente e confira o sino de notificações, o botão "Acompanhar Todos os eventos que estou Citado" (na aba Eventos Acompanhados) e o link de assinatura de calendário.
5. Publique um aviso de teste no mural e confira se chega e-mail (se configurou o passo 4) e se a notificação aparece no sino dos outros usuários.

---

## Deu erro "Internal" ao tentar entrar no site

Isso é o Firebase dizendo que a Cloud Function `login` quebrou no meio do caminho (ou nem existe ainda) — quase sempre por uma destas causas, nesta ordem de probabilidade:

1. **As Cloud Functions ainda não foram publicadas.** Veja no [Firebase Console](https://console.firebase.google.com) → projeto `turma23b` → **Functions**: se a lista estiver vazia, é isso. Rode o passo 3.3 (`firebase deploy --only functions,firestore:rules`) do seu computador.
2. **O segredo `PRESIDENTE_SENHA` não foi configurado** (passo 3.1) — sem ele, a função quebra sempre que alguém tenta entrar como presidente.
3. **O Firestore ainda não foi criado** no projeto (passo 1.2) — a função tenta ler a coleção `usuarios` e não encontra nem o banco.
4. **O projeto não está no plano Blaze** — nesse caso o próprio `firebase deploy` já teria avisado e recusado publicar as functions; confirme em Console → ⚙️ → Uso e cobrança.

Pra confirmar qual é: Console do Firebase → **Functions** → clique na função `login` → aba **Registros** (Logs) — a mensagem de erro real (bem mais específica que "Internal") aparece ali.

---

## O que mudou para quem já usava o site

- **Não existe mais "link pessoal de acesso"**: o login agora fica salvo de verdade pelo próprio navegador (Firebase Auth) — basta entrar uma vez; não precisa mais pedir, copiar nem guardar nenhum link especial.
- **Notificações dentro do site** (sininho no topo), em todas estas situações:
  1. O presidente publica algo no mural.
  2. Um evento em que o nome do discente aparece (esteja ele "acompanhando" ou não) muda de horário, professor/tutor(a), grupo ou sala — e também 30 minutos antes desse mesmo evento começar.
  3. É publicado um novo arquivo em "Arquivos da Turma" ou uma nova Data Importante.
  4. A nota individual do discente é lançada.
  5. 1 dia, 1 hora e 30 minutos antes de um evento que o discente marcou como "Acompanhar Evento".
  Cada notificação chega também por e-mail (quando o discente tem e-mail cadastrado), além de aparecer no sino do site em tempo real.
- **Assinatura de calendário mais direta**: o botão "Assinar no calendário" agora tem um link de um clique para o **Google Calendar** e outro para **iPhone/iPad/Mac** (abre direto a tela de "Assinar calendário" do sistema, sem precisar copiar link). O arquivo `.ics` também já vem com lembrete de 1 dia/1 hora/30 min embutido — o Apple Calendar e o Outlook notificam sozinhos com isso; o Google Calendar, por uma limitação própria dele, não importa lembretes de agendas assinadas por link (as notificações do site cobrem esse caso).
- **Instalar como aplicativo**: no Android/Chrome aparece um botão de instalar (ícone de ⬇ no topo) que abre o instalador nativo do navegador; no iPhone/iPad (Safari), o mesmo botão mostra o passo a passo (Compartilhar ▸ Adicionar à Tela de Início), já que a Apple não libera instalação automática por fora da App Store.
- **Novo botão "Acompanhar Todos os eventos que estou Citado"**, na aba Eventos Acompanhados, para discentes: acompanha de uma vez só todos os eventos em que seu nome aparece na lista, sem precisar abrir um por um.
- O resto do site — cronograma, mural com enquetes, arquivos da turma, notas, Coordenador da Tutoria, Datas Importantes, Encerrar Semestre — continua exatamente igual, com todos os dados preservados.

---

## Aplicativo (PWA) — Medicina 23B

- **Ícone novo**: "Medicina 23B" com o cajado de Asclépio, fundo branco — no ícone do app, no favicon da aba e na marca do topo. Versão "maskable" para o Android recortar em círculo sem cortar o desenho.
- **Já abre logado**: o login fica guardado no aparelho e, se a sessão do Firebase sumir, o app entra de novo sozinho. Ao instalar, o endereço guardado já identifica a pessoa — no iPhone, onde o app instalado não enxerga o login feito no Safari, ele abre direto logado. (O presidente continua tendo que digitar a senha no app instalado do iPhone, por segurança.)
- **Atualiza sozinho**: o service worker busca a versão nova do site sempre que o app volta para a tela.
- **Navegação mais fluida**: troca de aba deslizando para o lado certo, barrinha da aba ativa que acompanha, deslizar o dedo para trocar de aba (ou de semana/mês no Cronograma), janelas que sobem de baixo no celular e fecham arrastando pra baixo, avisos animados. Quem ativou "reduzir movimento" no sistema vê tudo sem animação.

## Estrutura do projeto

```
index.html, manifest.json, sw.js, ícones → o site em si, na raiz
push-worker/        → Worker da Cloudflare: push em tempo real + lembrete 2h antes (push e e-mail)
scripts/migrate.js  → script de migração + criação dos logins (roda uma única vez)
scripts/data/dados-turma.xlsx → dados reais da turma pra migração — NUNCA commitar (já no .gitignore)
scripts/make_icons.js → gera os ícones/favicon (cajado de Asclépio); scripts/make_favicon.py era o gerador antigo
firestore.rules     → regras de segurança do banco de dados (toda a lógica de autorização, sem Cloud Functions)
firebase.json, .firebaserc, firestore.indexes.json → configuração do Firebase
```
