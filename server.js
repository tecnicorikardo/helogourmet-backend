// ============================================================
// BACKEND — Pix via Efí Bank + Webhook
// Deploy no Render.com
// ============================================================
const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Firebase Admin
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
  console.log('Firebase Admin conectado.');
} catch (e) {
  console.warn('Firebase Admin não configurado:', e.message);
}

// ── Efí Bank config
const EFI_CLIENT_ID     = process.env.EFI_CLIENT_ID     || '';
const EFI_CLIENT_SECRET = process.env.EFI_CLIENT_SECRET || '';
const EFI_SANDBOX       = process.env.EFI_SANDBOX === 'true'; // false em produção
const EFI_BASE_URL      = EFI_SANDBOX
  ? 'https://pix-h.api.efipay.com.br'
  : 'https://pix.api.efipay.com.br';

console.log(`Efí Bank: ${EFI_SANDBOX ? 'SANDBOX' : 'PRODUÇÃO'}`);
console.log(`Client ID configurado: ${EFI_CLIENT_ID ? EFI_CLIENT_ID.slice(0,12) + '...' : 'NÃO CONFIGURADO'}`);

// ── Obtém token de acesso da Efí Bank
async function getEfiToken() {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${EFI_CLIENT_ID}:${EFI_CLIENT_SECRET}`).toString('base64');
    const body = 'grant_type=client_credentials';

    const options = {
      hostname: EFI_SANDBOX ? 'pix-h.api.efipay.com.br' : 'pix.api.efipay.com.br',
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    // Certificado mTLS — necessário para Efí Bank em produção
    // Em sandbox pode funcionar sem certificado
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error(json.error_description || 'Token não obtido'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Cria cobrança Pix imediata na Efí Bank
async function criarCobrancaEfi(total, descricao, pedidoId) {
  const token = await getEfiToken();

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      calendario: { expiracao: 3600 }, // 1 hora
      valor: { original: Number(total).toFixed(2) },
      chave: process.env.EFI_PIX_KEY || '', // sua chave Pix cadastrada na Efí
      solicitacaoPagador: descricao.slice(0, 140),
      infoAdicionais: [
        { nome: 'Pedido', valor: pedidoId || 'N/A' }
      ]
    });

    const options = {
      hostname: EFI_SANDBOX ? 'pix-h.api.efipay.com.br' : 'pix.api.efipay.com.br',
      path: '/v2/cob',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 201) resolve(json);
          else reject(new Error(json.mensagem || JSON.stringify(json)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Gera QR Code para um txid
async function gerarQRCode(txid) {
  const token = await getEfiToken();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: EFI_SANDBOX ? 'pix-h.api.efipay.com.br' : 'pix.api.efipay.com.br',
      path: `/v2/loc/${txid}/qrcode`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Rota de saúde
app.get('/', (req, res) => res.json({ status: 'ok', servico: 'Hélo Gourmet Backend', gateway: 'Efí Bank' }));

// ── Gerar QR Code Pix
app.post('/criar-pix', async (req, res) => {
  try {
    const { itens, total } = req.body;
    if (!itens || itens.length === 0) {
      return res.status(400).json({ erro: 'Carrinho vazio.' });
    }

    // Salva pedido no Firestore
    let pedidoId = 'sem-id';
    if (db) {
      const ref = await db.collection('pedidos').add({
        itens, total,
        status: 'pendente',
        tipoPagamento: 'pix',
        criadoEm: Timestamp.now()
      });
      pedidoId = ref.id;
    }

    const descricao = itens.map(i => `${i.quantidade}x ${i.nome}`).join(', ');

    // Cria cobrança na Efí Bank
    const cobranca = await criarCobrancaEfi(total, descricao, pedidoId);
    const txid = cobranca.txid;
    const locId = cobranca.loc?.id;

    // Gera QR Code
    let qrCode = '', qrCodeBase64 = '';
    if (locId) {
      const qr = await gerarQRCode(locId);
      qrCode = qr.qrcode || '';
      qrCodeBase64 = qr.imagemQrcode?.replace('data:image/png;base64,', '') || '';
    }

    // Atualiza pedido com txid
    if (db && pedidoId !== 'sem-id') {
      await db.collection('pedidos').doc(pedidoId).update({ txid, locId });
    }

    res.json({ pedidoId, txid, qrCode, qrCodeBase64, status: cobranca.status });

  } catch (err) {
    console.error('Erro ao gerar Pix:', err?.message || err);
    res.status(500).json({ erro: `Erro ao gerar Pix: ${err?.message || 'Erro desconhecido'}` });
  }
});

// ── Verificar status do Pix
app.get('/status-pix/:txid', async (req, res) => {
  try {
    const token = await getEfiToken();
    const txid = req.params.txid;

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: EFI_SANDBOX ? 'pix-h.api.efipay.com.br' : 'pix.api.efipay.com.br',
        path: `/v2/cob/${txid}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      };
      const req = https.request(options, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.end();
    });

    // Status Efí: ATIVA, CONCLUIDA, REMOVIDA_PELO_USUARIO_RECEBEDOR, REMOVIDA_PELO_PSP
    const pago = result.status === 'CONCLUIDA';
    res.json({ status: pago ? 'approved' : 'pending', statusEfi: result.status });

  } catch (err) {
    res.status(500).json({ erro: 'Erro ao verificar status.' });
  }
});

// ── Webhook Efí Bank — notifica quando Pix é pago
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const pixes = req.body?.pix || [];
    for (const pix of pixes) {
      const txid = pix.txid;
      if (!txid || !db) continue;

      // Busca pedido pelo txid
      const snap = await db.collection('pedidos').where('txid', '==', txid).limit(1).get();
      if (snap.empty) continue;

      const pedidoDoc = snap.docs[0];
      await pedidoDoc.ref.update({
        status: 'pago',
        pagamentoId: pix.endToEndId || txid,
        atualizadoEm: Timestamp.now()
      });
      console.log(`Pix confirmado: pedido=${pedidoDoc.id} txid=${txid}`);
    }
  } catch (err) {
    console.error('Erro no webhook Efí:', err);
  }
});

// ── Webhook Efí requer validação de chave (GET)
app.get('/webhook', (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
