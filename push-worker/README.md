# push-worker — notificações no celular e e-mail 2h antes

Este Worker da Cloudflare (nome `push-23b`, endereço `https://push-23b.medicina23b.workers.dev`,
já usado em `CONFIG.PUSH_URL` no `index.html`) faz:

- **Push em tempo real**: quando o presidente publica no mural, cria/edita/cancela/remove um evento,
  publica um arquivo ou uma data importante, o navegador dele grava as notificações no Firestore e
  chama este Worker, que manda o push pra todos os aparelhos na hora (mesmo com o app fechado).
- **Lembrete 2h antes**: a cada 5 minutos procura eventos que começam em até 2 horas e, pra cada
  discente cujo nome está na lista do evento, manda **push + e-mail** com os dados (disciplina, data,
  horário, local, docente, grupo, roteiros, observações).

Tudo no plano grátis: Cloudflare Workers (sem cartão), Firebase Spark (sem Blaze) e Brevo (300 e-mails/dia).

## Configurar (uma vez só)

Precisa do [Node.js](https://nodejs.org) instalado. Num terminal, dentro desta pasta `push-worker/`:

### 1. Conta de serviço do Firebase (pra ler o Firestore e mandar push)

1. [Firebase Console](https://console.firebase.google.com/project/cronograma-23b/settings/serviceaccounts/adminsdk)
   → ⚙️ Configurações do projeto → **Contas de serviço** → **Gerar nova chave privada**. Baixa um `.json`.
2. No terminal:
   ```bash
   npx wrangler login
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT < caminho/do/arquivo-baixado.json
   ```
   (No Windows PowerShell: `Get-Content caminho\arquivo.json -Raw | npx wrangler secret put FIREBASE_SERVICE_ACCOUNT`.)
3. Apague o `.json` baixado depois — ele dá acesso total ao projeto. **Nunca** suba pro GitHub.

Confira também, no Console do Firebase → Configurações do projeto → **Cloud Messaging**, que a
"API Firebase Cloud Messaging (V1)" está **Ativada**.

### 2. E-mail (Brevo, grátis)

1. Crie uma conta em [brevo.com](https://www.brevo.com) (plano Free).
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender**: cadastre o e-mail que vai aparecer como
   remetente (pode ser o Gmail da turma) e clique no link de confirmação que chega nele.
3. **SMTP & API → API Keys → Generate a new API key**. Copie a chave.
4. No terminal:
   ```bash
   npx wrangler secret put BREVO_API_KEY
   npx wrangler secret put MAIL_FROM_EMAIL
   ```
   (cole a chave no primeiro e o e-mail remetente no segundo).

Os e-mails vão para o campo **e-mail** de cada discente (aba Discentes, no app do presidente). Quem não
tem e-mail cadastrado recebe só o push. Sem o Brevo configurado, o lembrete sai só como push.

### 3. Publicar

```bash
npm install
npx wrangler deploy
```

Pronto: o Worker passa a rodar sozinho a cada 5 minutos. Para ver o que ele está fazendo em tempo real:
`npx wrangler tail`.

### 4. Índice do Firestore (recomendado)

O Worker procura as notificações pendentes de todo mundo numa consulta só. Para isso o Firestore precisa
de um índice de "collection group" no campo `pushEnviado` da coleção `itens` (já descrito em
`firestore.indexes.json`, na raiz). Duas formas de criar:

- Com a CLI: na raiz do projeto, `firebase deploy --only firestore:indexes`; **ou**
- No Console: Firestore → **Índices** → aba **Campo único** (Single field) → **Adicionar isenção**:
  coleção `itens`, campo `pushEnviado`, marcar **Collection group** com ordem crescente.

Sem o índice funciona igual, só gasta mais leituras do Firestore (uma consulta por discente).

## Ajustes (em `wrangler.toml`)

- `LEMBRETE_MINUTOS` — antecedência do lembrete (padrão `120` = 2h).
- `TZ_OFFSET` — fuso dos horários do cronograma (padrão `-03:00`, Santarém/PA).
- `APP_URL` — endereço do site (para os links das notificações e do e-mail).

Depois de mudar, rode `npx wrangler deploy` de novo.
