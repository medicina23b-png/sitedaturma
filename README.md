# Cronograma Acadêmico — Turma 23B

Site da turma, agora hospedado assim:

- **Frontend** (`public/index.html`): hospedado no **Netlify**, publicado automaticamente a cada `git push` no **GitHub**.
- **Backend**: **Firebase** — Firestore (banco de dados), Cloud Functions (regras de negócio, e-mails, PDF do calendário) e Firebase Auth (login). Sem Firebase Storage (por escolha) — "Arquivos da Turma" funciona só por link (Google Drive, Docs, Slides etc.), nunca por upload de arquivo binário.
- O **Google Apps Script/Google Sheets antigos não são mais usados** pelo site. A planilha só serve, uma única vez, de fonte para o script de migração (`scripts/migrate.js`).

Este documento é o roteiro completo, passo a passo, para colocar tudo isso no ar. Não é preciso saber programar — é só seguir a ordem.

### O que é automático e o que não tem como automatizar

Depois de configurado uma única vez, o dia a dia é só `git push` — o Netlify publica o site sozinho, e uma automação do GitHub (passo 3.4) publica as Cloud Functions/regras sozinha também. Mas existe um punhado de coisas que **só o dono da conta Google/Firebase pode fazer** (são cliques/senhas presos à identidade de quem é o titular do projeto) — ninguém, nem eu, consegue pular isso por fora:

1. Ativar Firestore e Authentication no Console do Firebase (1.2) — alguns cliques, uma vez.
2. Colocar o projeto no plano **Blaze** (pago por uso, exigido pelas Cloud Functions) — a turma fica, na prática, dentro da faixa gratuita mensal.
3. Guardar a senha do presidente em segredo (3.1) — um comando, uma vez.
4. Gerar a chave de conta de serviço do Firebase e colar como segredo no GitHub (3.4) — pra automação de deploy funcionar.
5. Rodar a migração dos dados (5) — uma vez, com os dados que você já tem.

Depois desses 5 passos (todos de "fazer uma vez"), tudo mais roda sozinho.

---

## 0. O que você vai precisar

- Uma conta Google (para o Firebase) — pode ser a mesma do Apps Script antigo.
- Uma conta no [GitHub](https://github.com) (para guardar o código e conectar no Netlify).
- Uma conta no [Netlify](https://netlify.com) (pode entrar direto com a conta do GitHub).
- O [Node.js](https://nodejs.org) instalado no seu computador (versão 20 ou mais nova), só para rodar os comandos abaixo.
- Uma conta de e-mail que o site vai usar para mandar os avisos (pode ser um Gmail comum, com "senha de app" — explico no passo 4).

---

## 1. Criar o projeto no Firebase

O projeto já existe no Firebase Console com o nome **turma23b** (foi criado para gerar a configuração usada no site). Se ele já existe, pule para o item 1.2. Se precisar criar do zero:

### 1.1 Criar o projeto (só se ainda não existir)

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) e clique em **Adicionar projeto**.
2. Nome do projeto: `turma23b` (ou o nome que preferir — se for outro nome, troque os valores de `firebaseConfig` dentro de `public/index.html`, no `<script type="module">` do `<head>`, e o `default` em `.firebaserc`).
3. Pode desativar o Google Analytics se não quiser, ou deixar ativado (o site já está preparado pra usar).

### 1.2 Ativar os produtos usados

Dentro do projeto, no menu da esquerda:

1. **Authentication** → aba "Sign-in method" → não é preciso ativar nenhum provedor específico (o login usa "tokens personalizados", que já vem liberado por padrão).
2. **Firestore Database** → **Criar banco de dados** → modo de produção → escolha a região `southamerica-east1` (São Paulo — mais perto da turma; se escolher outra, troque também em `functions/index.js`, na linha com `region: 'southamerica-east1'`, e no `<script type="module">` do `index.html`, na linha `getFunctions(app, 'southamerica-east1')`).
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

Se você recebeu este projeto como uma pasta/zip, extraia e abra um terminal dentro dela (a pasta que contém `firebase.json`, `public/`, `functions/`, etc.). Depois:

```bash
firebase use --add
```

Escolha o projeto `turma23b` e dê o nome de alias `default` quando perguntado (isso já está pré-configurado em `.firebaserc`, então normalmente você pode pular este comando).

---

## 3. Configurar a senha do presidente e publicar as Cloud Functions

### 3.1 Guardar a senha do presidente em segredo

A senha do presidente **não fica escrita em nenhum arquivo** — ela é guardada criptografada no "Secret Manager" do Firebase:

```bash
firebase functions:secrets:set PRESIDENTE_SENHA
```

Vai pedir para digitar a senha (a mesma que o presidente vai usar para entrar no site). Pode trocar essa senha depois, repetindo o mesmo comando.

### 3.2 Instalar as dependências das Functions

```bash
cd functions
npm install
cd ..
```

### 3.3 Publicar Functions e Regras do Firestore

```bash
firebase deploy --only functions,firestore:rules
```

Isso leva alguns minutos na primeira vez. No final, o terminal mostra uma lista de URLs — **copie a URL da função `icsFeed`** (algo como `https://southamerica-east1-turma23b.cloudfunctions.net/icsFeed`). Você vai usar essa URL no passo 6.

**Observação sobre os lembretes automáticos de evento** (`enviarLembretesEventos`): essa função roda sozinha a cada 5 minutos (usando o Cloud Scheduler do Google) — não precisa fazer nada além do `firebase deploy` acima. Só na primeira vez, o terminal pode pedir para confirmar a ativação das APIs **Cloud Scheduler** e **Cloud Pub/Sub** (responda "y"/sim); se isso não acontecer automaticamente, ative as duas em [console.cloud.google.com/apis/library](https://console.cloud.google.com/apis/library) (busque pelo nome) e rode o deploy de novo.

### 3.4 Deploy automático a partir do GitHub (fazer só uma vez)

Depois disso, você nunca mais precisa rodar `firebase deploy` na mão — este projeto já vem com uma automação (`.github/workflows/firebase-deploy.yml`) que publica sozinha as Cloud Functions e as regras a cada `git push` na branch `main`. Pra ligá-la:

1. Gere **outra** chave de conta de serviço do Firebase (pode ser a mesma do passo 5.1 mais abaixo, ou uma nova): Console do Firebase → ⚙️ **Configurações do projeto** → **Contas de serviço** → **Gerar nova chave privada**. Abre um arquivo `.json`.
2. No GitHub, dentro do repositório → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
3. Nome do segredo: `FIREBASE_SERVICE_ACCOUNT`. Valor: cole o **conteúdo inteiro** do arquivo `.json` baixado no passo 1.
4. Salve. No próximo `git push` que tocar em `functions/` ou `firestore.rules`, a aba **Actions** do GitHub mostra o deploy rodando sozinho.

(Pode rodar manualmente também, sem precisar de um push: aba **Actions** do repositório → "Publicar Cloud Functions e regras no Firebase" → **Run workflow**.)

---

## 4. Configurar o envio de e-mails (extensão "Trigger Email")

O site escreve os e-mails numa "fila" (coleção `mail` do Firestore) e uma extensão oficial do Firebase (`firestore-send-email`) é quem efetivamente os envia por SMTP.

1. No Firebase Console, vá em **Extensions** (menu da esquerda) → **Explorar extensões** → procure **"Trigger Email"** (publicada pela própria Google/Firebase) → **Instalar**.
2. Durante a instalação, configure:
   - **Collection path**: `mail` (tem que ser exatamente esse nome, é o que as Cloud Functions usam).
   - **SMTP connection URI**: os dados do seu provedor de e-mail. Para Gmail, algo como `smtps://SEU_EMAIL%40gmail.com:SENHA_DE_APP@smtp.gmail.com:465` — a "senha de app" (não é a senha normal da conta) se cria em [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), com a verificação em duas etapas ativada.
   - **Default FROM address**: o e-mail que vai aparecer como remetente (ex.: `Turma 23B <seu_email@gmail.com>`).
3. Finalize a instalação (também leva alguns minutos).

Se pular este passo, o site continua funcionando normalmente — só os e-mails de aviso não saem (ficam só as notificações dentro do próprio site, que não dependem disso).

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

---

## 6. Preencher a URL do calendário (iCalendar) no site

1. Abra `public/index.html` num editor de texto.
2. Procure por `ICS_URL: ''` (dentro do bloco `const CONFIG = {`).
3. Cole ali a URL da função `icsFeed` que você copiou no passo 3.3, por exemplo:
   ```js
   ICS_URL: 'https://southamerica-east1-turma23b.cloudfunctions.net/icsFeed',
   ```
4. Salve o arquivo.

Sem isso, o botão "Assinar no calendário" continua aparecendo, só que avisando que ainda falta configurar.

---

## 7. Subir o projeto para o GitHub

Dentro da pasta do projeto:

```bash
git init
git add .
git commit -m "Site da Turma 23B — Firebase + Netlify"
```

Depois, crie um repositório novo (privado, de preferência) no GitHub, pelo site, e siga as instruções que o próprio GitHub mostra para "enviar um repositório já existente":

```bash
git remote add origin https://github.com/SEU_USUARIO/NOME_DO_REPOSITORIO.git
git branch -M main
git push -u origin main
```

---

## 8. Conectar o Netlify ao GitHub

1. Entre em [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import an existing project** → **GitHub** → autorize e escolha o repositório que você acabou de criar.
2. As configurações de build já estão prontas no arquivo `netlify.toml` deste projeto (pasta publicada: `public`), então pode deixar os campos como o Netlify sugerir e clicar em **Deploy**.
3. Depois do primeiro deploy, o Netlify dá um endereço tipo `https://nome-aleatorio.netlify.app`. Em **Site settings → Domain management** você pode trocar para um nome melhor (ex.: `turma23b.netlify.app`) ou ligar um domínio próprio.

A partir de agora, **todo `git push` no GitHub publica automaticamente** a nova versão no Netlify — não precisa fazer nada manual depois disso.

---

## 9. Testar

1. Abra o site publicado pelo Netlify.
2. Entre como presidente (usuário `presidente`, a senha configurada no passo 3.1).
3. Confirme que o cronograma, mural, arquivos e notas aparecem com os dados migrados.
4. Entre como um discente e confira o sino de notificações, o botão "Acompanhar Todos os eventos que estou Citado" (na aba Eventos Acompanhados) e o link de assinatura de calendário.
5. Publique um aviso de teste no mural e confira se chega e-mail (se configurou o passo 4) e se a notificação aparece no sino dos outros usuários.

---

## Deu erro "Internal" ao tentar entrar no site

Isso é o Firebase dizendo que a Cloud Function `login` quebrou no meio do caminho (ou nem existe ainda) — quase sempre por uma destas causas, nesta ordem de probabilidade:

1. **As Cloud Functions ainda não foram publicadas.** Veja no [Firebase Console](https://console.firebase.google.com) → projeto `turma23b` → **Functions**: se a lista estiver vazia, é isso. Faça o passo 3 (ou, se já configurou o segredo `FIREBASE_SERVICE_ACCOUNT` no GitHub, dê um `git push` qualquer que toque em `functions/` para a automação publicar).
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

## Estrutura do projeto

```
public/            → o site em si (único arquivo index.html + ícones), publicado no Netlify
functions/          → Cloud Functions (toda a lógica de servidor, equivalente ao antigo Code.gs)
.github/workflows/  → automação que publica Functions/regras a cada git push (passo 3.4)
scripts/migrate.js  → script de migração (roda uma única vez)
scripts/data/dados-turma.xlsx → dados reais da turma pra migração — NUNCA commitar (já no .gitignore)
scripts/make_favicon.py → script que gerou os ícones/favicon (não precisa rodar de novo)
firestore.rules     → regras de segurança do banco de dados
firebase.json, .firebaserc, firestore.indexes.json → configuração do Firebase
netlify.toml        → configuração do Netlify
```
